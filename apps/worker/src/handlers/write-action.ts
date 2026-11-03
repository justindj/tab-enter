import { findOnPath, runCommand, type RunCommand } from '@tab-enter/claude';
import {
  ConnectorError,
  createGitLabHost,
  createJiraTracker,
  type FetchLike,
} from '@tab-enter/connectors';
import {
  isWriteAllowed,
  PROTECTED_BRANCH,
  redactSecrets,
  WriteActionSchema,
  type CredentialProvider,
  type MRRef,
  type WriteAction,
} from '@tab-enter/core';
import {
  enqueueJob,
  finishWriteAction,
  getProfile,
  getRun,
  getWriteAction,
  hasPendingJob,
  updateRun,
  type Db,
  type Profile,
} from '@tab-enter/db';

// Performs one confirmed write action. The web app logged it as "pending"
// with the exact payload the user saw; this re-checks that the action is
// still enabled, performs it, and records the outcome. Never retried: the
// job runs once, and a failed write is left for the user to retry by hand.

export interface WriteDeps {
  credentials?: CredentialProvider;
  fetch?: FetchLike;
  run?: RunCommand;
  findGit?: () => Promise<string | null>;
}

const SAFE_REF = /^(?!.*\.\.)(?!\/)(?!.*\/$)[A-Za-z0-9._/-]+$/;

export class WriteError extends Error {}

function parseMrKey(key: string): MRRef {
  const m = /^(.+)!(\d+)$/.exec(key);
  if (!m) throw new WriteError(`Not a merge request key: ${key}`);
  return { projectId: m[1]!, iid: Number(m[2]) };
}

export async function executeWriteAction(
  db: Db,
  job: { profileId: string; actionId: string },
  deps: WriteDeps,
): Promise<void> {
  const row = await getWriteAction(db, job.actionId);
  if (!row || row.status !== 'pending' || row.profileId !== job.profileId) return;
  const profile = await getProfile(db, row.profileId);
  try {
    if (!profile) throw new WriteError('The profile was deleted.');
    const action = WriteActionSchema.parse(row.payload);
    if (!isWriteAllowed(profile.settings, action.kind)) {
      throw new WriteError('This write action is turned off in Settings → Write actions.');
    }
    const result = profile.isDemo
      ? { message: 'Demo profile: simulated, nothing was sent.' }
      : await perform(db, profile, action, deps);
    await finishWriteAction(db, row.id, { result });
  } catch (err) {
    await finishWriteAction(db, row.id, {
      error: redactSecrets(err instanceof Error ? err.message : String(err)),
    });
  }
}

async function perform(
  db: Db,
  profile: Profile,
  action: WriteAction,
  deps: WriteDeps,
): Promise<{ url?: string; message?: string }> {
  if (!deps.credentials && action.kind !== 'git-push') {
    throw new WriteError('The worker has no credentials.');
  }
  const opts = {
    profileId: profile.id,
    settings: profile.settings,
    credentials: deps.credentials!,
    fetch: deps.fetch,
  };
  const resync = async () => {
    if (!(await hasPendingJob(db, 'sync', profile.id))) {
      await enqueueJob(db, { type: 'sync', profileId: profile.id });
    }
  };

  switch (action.kind) {
    case 'git-push':
      return gitPush(db, profile, action.runId, deps);

    case 'open-mr': {
      const run = await ownRun(db, profile, action.runId);
      if (!run.projectId) throw new WriteError('This run has no GitLab project.');
      if (!run.branch || !SAFE_REF.test(run.branch))
        throw new WriteError('This run has no branch.');
      const mr = await createGitLabHost(opts).createMergeRequest({
        projectId: run.projectId,
        sourceBranch: run.branch,
        targetBranch: action.targetBranch,
        title: action.title,
        description: action.description,
      });
      await updateRun(db, run.id, { mrKey: `${run.projectId}!${mr.iid}` });
      await resync();
      return { url: mr.url, message: `Opened merge request !${mr.iid}.` };
    }

    case 'mr-comment':
      return createGitLabHost(opts).postNote(parseMrKey(action.mrKey), action.body);

    case 'mr-diff-comments': {
      const host = createGitLabHost(opts);
      const ref = parseMrKey(action.mrKey);
      let placed = 0;
      let general = 0;
      let firstUrl: string | undefined;
      for (const c of action.comments) {
        // Post first, then remember the URL: `firstUrl ??= await …` would skip the call.
        let posted: { url: string };
        try {
          posted = await host.postDiffNote(ref, c);
          placed++;
        } catch (err) {
          // Lines outside the diff can't carry a line comment; post it generally instead.
          if (!(err instanceof ConnectorError) || err.kind === 'auth' || err.kind === 'network')
            throw err;
          posted = await host.postNote(ref, `\`${c.file}:${c.line}\`: ${c.body}`);
          general++;
        }
        firstUrl ??= posted.url;
      }
      return {
        url: firstUrl,
        message: `Posted ${placed} line comment${placed === 1 ? '' : 's'}${general ? ` and ${general} general (line not in the diff)` : ''}.`,
      };
    }

    case 'mr-approve':
      await createGitLabHost(opts).approve(parseMrKey(action.mrKey), action.sha);
      await resync();
      return { message: `Approved at ${action.sha.slice(0, 12)}.` };

    case 'jira-comment':
      return createJiraTracker(opts).addComment(action.issueKey, action.body);

    case 'jira-transition':
      await createJiraTracker(opts).transition(action.issueKey, action.transitionId);
      await resync();
      return { message: `Moved ${action.issueKey} via "${action.transitionName}".` };
  }
}

async function ownRun(db: Db, profile: Profile, runId: string) {
  const run = await getRun(db, runId);
  if (!run || run.profileId !== profile.id) throw new WriteError('Run not found.');
  return run;
}

/** Push the run's branch to origin. Never forced, never a protected branch. */
async function gitPush(db: Db, profile: Profile, runId: string, deps: WriteDeps) {
  const run = await ownRun(db, profile, runId);
  const branch = run.branch;
  if (!run.cwd || !branch || branch === 'demo' || branch.startsWith('origin/')) {
    throw new WriteError('This run has no branch of its own to push.');
  }
  if (!SAFE_REF.test(branch)) throw new WriteError(`Refusing an unusual branch name: ${branch}`);
  if (PROTECTED_BRANCH.test(branch)) throw new WriteError(`tab-enter never pushes ${branch}.`);
  const gitPath = await (deps.findGit ?? (() => findOnPath('git')))();
  if (!gitPath) throw new WriteError('git was not found on PATH.');
  const run_ = deps.run ?? runCommand;
  const git = (args: string[], timeoutMs = 30_000) =>
    run_(gitPath, ['-C', run.cwd!, ...args], { timeoutMs });

  const head = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  if (head !== branch) {
    throw new WriteError(
      `The worktree is on ${head || '(unknown)'}, not ${branch}. Check it in a terminal.`,
    );
  }
  // No --force, no --force-with-lease: a rejected push is reported, not overridden.
  const push = await git(
    ['push', '--porcelain', '-u', 'origin', `refs/heads/${branch}:refs/heads/${branch}`],
    120_000,
  );
  if (push.code !== 0) {
    throw new WriteError(`git push failed: ${(push.stderr || push.stdout).trim().slice(0, 600)}`);
  }
  await updateRun(db, run.id, {
    diffSummary: { ...(run.diffSummary ?? { filesChanged: [] }), commits: [] },
  });
  const line = push.stdout
    .split('\n')
    .find((l) => l.includes(`refs/heads/${branch}`))
    ?.trim();
  return { message: `Pushed ${branch} to origin${line ? ` (${line.replace(/\s+/g, ' ')})` : ''}.` };
}

/** A ticket's workflow transitions, for the "Move ticket" picker. */
export async function listJiraTransitions(
  db: Db,
  job: { profileId: string; issueKey: string },
  deps: WriteDeps,
): Promise<{ id: string; name: string; to: string }[]> {
  const profile = await getProfile(db, job.profileId);
  if (!profile) throw new WriteError('The profile was deleted.');
  if (profile.isDemo) {
    return [
      { id: '11', name: 'Start progress', to: 'In Progress' },
      { id: '21', name: 'Send to review', to: 'In Review' },
      { id: '31', name: 'Done', to: 'Done' },
    ];
  }
  if (!deps.credentials) throw new WriteError('The worker has no credentials.');
  return createJiraTracker({
    profileId: profile.id,
    settings: profile.settings,
    credentials: deps.credentials,
    fetch: deps.fetch,
  }).listTransitions(job.issueKey);
}
