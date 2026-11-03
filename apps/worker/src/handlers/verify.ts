import { copyFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { findOnPath, runCommand } from '@tab-enter/claude';
import {
  createGitLabHost,
  DemoCodeHost,
  type DemoGitLabFixture,
  type FetchLike,
} from '@tab-enter/connectors';
import {
  AssessmentSchema,
  assessmentPrompt,
  buildSlideshow,
  classifyFiles,
  deriveOutcome,
  heuristicAssessment,
  isExcluded,
  parsePlaywrightReport,
  parseUiPageMap,
  parseWith,
  redactSecrets,
  smokeWalkthrough,
  uiPagesFor,
  verificationSummary,
  WalkthroughSchema,
  walkthroughPrompt,
  type SpecRunResult,
  type AgentRunner,
  type Assessment,
  type BlobStore,
  type CredentialProvider,
  type Evidence,
  type MergeRequest,
  type PresetId,
  type StepOutcome,
  type Walkthrough,
  type WatchedProject,
} from '@tab-enter/core';
import {
  createRun,
  getProfile,
  getProfileDir,
  getRun,
  getVerification,
  listIssues,
  listLinks,
  listMergeRequests,
  listRunEvents,
  listVerifications,
  updateRun,
  updateVerification,
  type Db,
  type Profile,
  type RunRow,
} from '@tab-enter/db';
import type { SecretStore } from '@tab-enter/secrets';
import {
  runShell,
  runWalkthrough,
  startApp,
  waitUntilDown,
  type WalkthroughOptions,
} from '../walkthrough';
import { ensureDetachedWorktree, ensureWorktree } from '../worktree';
import { executeRun } from './agent-run';

// Verification job (spec 4.3): gather evidence for a ticket, run a browser
// walkthrough for UI changes, have Claude assess the acceptance criteria, and
// store a self-contained slideshow. Each Claude call is an ordinary run, so it
// shows on the Runs page with its log and cost.

export interface VerifyDeps {
  fixturesDir: string;
  blobs: BlobStore;
  credentials?: CredentialProvider;
  secrets?: Pick<SecretStore, 'get'>;
  fetch?: FetchLike;
  /** Tests: fake Claude, fake browser, no real app start. */
  runner?: (run: RunRow, vars: Record<string, string>) => AgentRunner;
  launch?: WalkthroughOptions['launch'];
  startApp?: (
    command: string,
    cwd: string,
    baseUrl: string,
  ) => Promise<{ stop: () => Promise<void> | void }>;
  runShell?: typeof runShell;
}

export interface VerifyJob {
  profileId: string;
  artifactId: string;
  mode: 'auto' | 'ui' | 'backend';
  rerun: boolean;
}

class VerifyError extends Error {}

const MAX_EXCERPTS = 4;
const EXCERPT_CHARS = 1500;

export async function executeVerification(db: Db, job: VerifyJob, deps: VerifyDeps): Promise<void> {
  const row = await getVerification(db, job.artifactId);
  if (!row || row.status !== 'running') return;
  const profile = await getProfile(db, job.profileId);
  if (!profile) return;
  try {
    await verify(db, profile, row.id, row.issueKey, row.mrKey, job, deps);
  } catch (err) {
    await updateVerification(db, row.id, {
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
      finishedAt: new Date(),
    });
  }
}

async function verify(
  db: Db,
  profile: Profile,
  artifactId: string,
  issueKey: string,
  mrKeyHint: string | null,
  job: VerifyJob,
  deps: VerifyDeps,
) {
  const { settings } = profile;
  const issue = (await listIssues(db, profile.id)).find((i) => i.key === issueKey);
  if (!issue) throw new VerifyError(`Ticket ${issueKey} isn't in the synced data.`);
  const mr = await linkedMR(db, profile.id, issueKey, mrKeyHint);
  const project = mr ? findProject(settings.gitlab.projects, mr) : undefined;
  const verification = project?.verification ?? {};
  const prefix = `profiles/${profile.id}/verification/${artifactId}`;
  const outDir = path.join(getProfileDir(profile.id), 'verification', artifactId);
  await mkdir(outDir, { recursive: true });
  const notes: string[] = [];
  const claudeAllowed = !profile.isDemo && settings.claude.approvedForClient;

  // 1. What changed: GitLab's MR diff (works for open and merged MRs).
  let files: { path: string; diff: string }[] = [];
  if (mr) {
    try {
      files = await mrDiff(profile, mr, deps);
    } catch (err) {
      notes.push(`Couldn't read the MR diff: ${err instanceof Error ? err.message : err}`);
    }
  }
  const changed = classifyFiles(files.map((f) => f.path));
  const demoScripts = profile.isDemo ? await demoWalkthroughs(deps.fixturesDir) : {};
  const mode =
    job.mode !== 'auto'
      ? job.mode
      : changed.ui.length > 0 || demoScripts[issueKey]
        ? 'ui'
        : 'backend';
  await updateVerification(db, artifactId, { mode, mrKey: mr ? key(mr) : null });

  const evidence: Evidence = {
    mode,
    changed,
    pipelineStatus: mr?.pipelineStatus ?? 'none',
    pipelineFailures: mr?.pipelineFailures ?? [],
    steps: [],
  };
  let runId: string | null = null;
  const images: Record<string, string> = {};

  if (mr) {
    evidence.coverage = await mrCoverage(profile, mr, deps).catch(() => undefined);
  }

  // 2a. UI with the repo's own Playwright tests: run them instead of a walkthrough.
  if (mode === 'ui' && !profile.isDemo && verification.specCommand) {
    evidence.spec = await runSpec(
      profile,
      project,
      mr,
      verification.specCommand,
      outDir,
      notes,
      deps,
    ).catch((err: unknown): SpecRunResult => ({
      command: verification.specCommand!,
      passed: 0,
      failed: 0,
      skipped: 0,
      tests: [],
      screenshots: [],
      error: err instanceof Error ? err.message : String(err),
    }));
    await loadImages(outDir, evidence.spec.screenshots, images);
  }
  // 2b. UI: walkthrough script (saved, demo, or written by Claude), then run it.
  else if (mode === 'ui') {
    let script: Walkthrough | null;
    if (job.rerun) {
      script = await savedScript(db, deps.blobs, profile.id, issueKey, artifactId);
      if (!script)
        throw new VerifyError(
          'There is no saved walkthrough for this ticket yet. Run a full verification first.',
        );
    } else if (profile.isDemo) {
      script = demoScripts[issueKey] ?? null;
      if (!script) throw new VerifyError(`The demo has no walkthrough for ${issueKey}.`);
    } else {
      if (!claudeAllowed) {
        throw new VerifyError(
          'Writing a walkthrough needs Claude Code approved for this client. Use backend mode, or re-run a saved walkthrough.',
        );
      }
      if (!verification.baseUrl) {
        throw new VerifyError(
          `Set a test URL for ${project?.path || 'the project'} in Settings → Verification.`,
        );
      }
      const cwd = await appWorktree(project, mr, notes).catch((err: unknown) => {
        notes.push(
          `No worktree, so Claude can't read the code: ${err instanceof Error ? err.message : err}`,
        );
        return null;
      });
      const result = await claudeJson(
        db,
        profile,
        {
          preset: 'verification-script',
          issueKey,
          mrKey: mr ? key(mr) : null,
          cwd: cwd ?? (await scratch(profile)),
          prompt: walkthroughPrompt({
            issue,
            mr,
            changed,
            baseUrl: verification.baseUrl,
            hasCredentials: !!verification.testCredentialsSecret,
            descriptionChars: settings.contextCaps.descriptionChars,
          }),
        },
        WalkthroughSchema,
        deps,
      );
      runId = result.runId;
      if (!result.value)
        throw new VerifyError(`Claude's walkthrough wasn't usable: ${result.error}`);
      script = result.value;
    }
    await deps.blobs.put(
      `${prefix}/walkthrough.json`,
      JSON.stringify(script, null, 2),
      'application/json',
    );
    await updateVerification(db, artifactId, {
      scriptBlobKey: `${prefix}/walkthrough.json`,
      runId,
    });

    if (profile.isDemo) {
      evidence.steps = demoOutcomes(script, images);
      notes.push('Demo: the walkthrough is simulated; screenshots are placeholders.');
    } else {
      evidence.steps = await walk(profile, project, mr, script, outDir, notes, deps).catch(
        (err: unknown) => {
          evidence.walkthroughError = err instanceof Error ? err.message : String(err);
          return [];
        },
      );
      // "Before": the same steps on the target branch, for open MRs whose app tab-enter starts.
      if (
        settings.verification.captureBefore &&
        verification.startCommand &&
        mr?.state === 'opened' &&
        evidence.steps.some((s) => s.ok && s.screenshot)
      ) {
        const before = await walk(
          profile,
          project,
          mr,
          script,
          path.join(outDir, 'before'),
          notes,
          deps,
          'before',
        ).catch((err: unknown) => {
          notes.push(`No "before" screenshots: ${err instanceof Error ? err.message : err}`);
          return [];
        });
        for (const b of before) {
          const after = evidence.steps.find((s) => s.index === b.index);
          if (b.ok && b.screenshot && after?.screenshot)
            after.beforeScreenshot = `before/${b.screenshot}`;
        }
      }
      await loadImages(
        outDir,
        evidence.steps.flatMap((s) => [s.screenshot, s.beforeScreenshot]),
        images,
      );
    }
  }

  // 2c. Backend change: smoke-check the UI pages it maps to (Settings → Verification).
  if (mode === 'backend' && !profile.isDemo && verification.baseUrl) {
    const pages = uiPagesFor(changed.all, parseUiPageMap(verification.uiPages));
    if (pages.length > 0) {
      const smoke = await walk(
        profile,
        project,
        mr,
        smokeWalkthrough(pages),
        path.join(outDir, 'smoke'),
        notes,
        deps,
      ).catch((err: unknown) => {
        notes.push(`UI smoke check couldn't run: ${err instanceof Error ? err.message : err}`);
        return [];
      });
      evidence.smoke = smoke.map((s) =>
        s.screenshot ? { ...s, screenshot: `smoke/${s.screenshot}` } : s,
      );
      await loadImages(
        outDir,
        evidence.smoke.map((s) => s.screenshot),
        images,
      );
    }
  }

  // 3. Assess each acceptance criterion (Claude when allowed, else evidence only).
  let assessment: Assessment;
  if (claudeAllowed) {
    const result = await claudeJson(
      db,
      profile,
      {
        preset: 'short-text',
        issueKey,
        mrKey: mr ? key(mr) : null,
        cwd: await scratch(profile),
        prompt: assessmentPrompt(issue, evidence),
      },
      AssessmentSchema,
      deps,
    );
    runId ??= result.runId;
    assessment =
      result.value ??
      heuristicAssessment(issue, evidence, `Claude's assessment wasn't usable: ${result.error}`);
  } else {
    assessment = heuristicAssessment(
      issue,
      evidence,
      profile.isDemo ? 'demo: no AI' : 'Claude Code is not approved for this client',
    );
  }
  if (notes.length)
    assessment = {
      ...assessment,
      summary: [assessment.summary, ...notes].filter(Boolean).join(' '),
    };

  // 4. Slideshow.
  const outcome = deriveOutcome(evidence, assessment);
  const excerpts = files
    .filter((f) => !isExcluded(f.path, settings.reviewExcludeGlobs))
    .slice(0, MAX_EXCERPTS)
    .map((f) => ({
      path: f.path,
      diff: f.diff.length > EXCERPT_CHARS ? `${f.diff.slice(0, EXCERPT_CHARS)}\n[…]` : f.diff,
    }));
  const html = buildSlideshow({
    issue,
    mr,
    evidence,
    assessment,
    outcome,
    diffExcerpts: excerpts,
    images,
    generatedAt: new Date(),
    demo: profile.isDemo,
  });
  await deps.blobs.put(`${prefix}/index.html`, html, 'text/html');
  await updateVerification(db, artifactId, {
    status: outcome,
    blobKey: `${prefix}/index.html`,
    criteria: assessment.criteria.map(({ text, result }) => ({ text, result })),
    summary: verificationSummary(issue, outcome, assessment),
    runId,
    finishedAt: new Date(),
  });
}

// ------------------------------------------------------------- helpers

const key = (mr: MergeRequest) => `${mr.ref.projectId}!${mr.ref.iid}`;

/** My MR for the ticket: the hinted one, else the newest open, else the newest merged. */
async function linkedMR(db: Db, profileId: string, issueKey: string, hint: string | null) {
  const links = (await listLinks(db, profileId)).filter((l) => l.issueKey === issueKey);
  const mrs = (await listMergeRequests(db, profileId))
    .filter((m) => links.some((l) => l.mrKey === key(m.mr)))
    .map((m) => m.mr);
  return (
    mrs.find((m) => key(m) === hint) ??
    mrs
      .filter((m) => m.state === 'opened')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ??
    mrs
      .filter((m) => m.state === 'merged')
      .sort((a, b) => (b.mergedAt ?? '').localeCompare(a.mergedAt ?? ''))[0]
  );
}

function findProject(projects: WatchedProject[], mr: MergeRequest) {
  return projects.find((p) => p.id === mr.ref.projectId || (p.path && p.path === mr.projectPath));
}

async function mrDiff(profile: Profile, mr: MergeRequest, deps: VerifyDeps) {
  if (profile.isDemo) {
    const fixture = JSON.parse(
      await readFile(path.join(deps.fixturesDir, 'demo/gitlab.json'), 'utf8'),
    ) as DemoGitLabFixture;
    return (await new DemoCodeHost(fixture).getMRDetail(mr.ref)).diff;
  }
  if (!deps.credentials) throw new Error('no GitLab credentials in the worker');
  const host = createGitLabHost({
    profileId: profile.id,
    settings: profile.settings,
    credentials: deps.credentials,
    fetch: deps.fetch,
  });
  return (await host.getMRDetail(mr.ref)).diff;
}

async function demoWalkthroughs(fixturesDir: string): Promise<Record<string, Walkthrough>> {
  try {
    const raw = JSON.parse(
      await readFile(path.join(fixturesDir, 'demo/walkthroughs.json'), 'utf8'),
    ) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(raw).flatMap(([k, v]) => {
        const parsed = WalkthroughSchema.safeParse(v);
        return parsed.success ? [[k, parsed.data]] : [];
      }),
    );
  } catch {
    return {};
  }
}

/** Demo: every step "passes"; screenshots are labelled SVG placeholders. */
function demoOutcomes(script: Walkthrough, images: Record<string, string>): StepOutcome[] {
  return script.steps.map((step, index) => {
    if (step.action !== 'screenshot') return { index, step, ok: true };
    const name = `step-${index + 1}.svg`;
    const text = step.caption.replace(/[<>&"]/g, '');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800"><rect width="100%" height="100%" fill="#f4f4f5"/><rect x="40" y="40" width="1200" height="60" rx="8" fill="#e4e4e7"/><text x="640" y="400" font-family="system-ui,sans-serif" font-size="36" text-anchor="middle" fill="#3f3f46">${text}</text><text x="640" y="450" font-family="system-ui,sans-serif" font-size="20" text-anchor="middle" fill="#71717a">Demo placeholder: no real app was opened</text></svg>`;
    images[name] = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
    return { index, step, ok: true, screenshot: name };
  });
}

async function scratch(profile: Profile) {
  const dir = path.join(getProfileDir(profile.id), 'scratch');
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Code for the app: the MR branch while open, the target branch once merged. */
async function appWorktree(
  project: WatchedProject | undefined,
  mr: MergeRequest | undefined,
  notes: string[],
): Promise<string> {
  if (!mr || !project?.localPath) {
    throw new VerifyError('no watched project with a local clone path for this MR');
  }
  const git = await findOnPath('git');
  if (!git) throw new VerifyError('git is not on PATH');
  const wt =
    mr.state === 'opened'
      ? await ensureWorktree(runCommand, git, {
          clonePath: project.localPath,
          key: `mr-${mr.ref.iid}`,
          branch: mr.sourceBranch,
        })
      : await ensureDetachedWorktree(runCommand, git, {
          clonePath: project.localPath,
          key: `verify-${mr.targetBranch}`,
          remoteBranch: mr.targetBranch,
        });
  notes.push(...wt.warnings);
  return wt.cwd;
}

async function testCredentials(
  profile: Profile,
  project: WatchedProject | undefined,
  deps: VerifyDeps,
): Promise<{ username: string; password: string } | null> {
  const name = project?.verification.testCredentialsSecret;
  if (!name || !deps.secrets) return null;
  const raw = await deps.secrets.get(profile.id, name);
  return raw ? (JSON.parse(raw) as { username: string; password: string }) : null;
}

/**
 * Run `fn` with the app up: started from the change's worktree (or, for
 * "before", the target branch's) when a start command is set, and stopped
 * (port released) afterwards.
 */
async function withApp<T>(
  project: WatchedProject | undefined,
  mr: MergeRequest | undefined,
  which: 'change' | 'before',
  notes: string[],
  deps: VerifyDeps,
  fn: (cwd: string | null) => Promise<T>,
  needsCode = false,
): Promise<T> {
  const v = project?.verification ?? {};
  if (!v.baseUrl)
    throw new VerifyError('No test URL is set for this project (Settings → Verification).');
  if (which === 'before' && !v.startCommand)
    throw new VerifyError('"Before" screenshots need a start command.');
  // With no start command the app is already running, so walkthroughs need no checkout.
  const cwd =
    which === 'before'
      ? await beforeWorktree(project, mr, notes)
      : v.startCommand || needsCode
        ? await appWorktree(project, mr, notes)
        : null;
  let app: { stop: () => Promise<void> | void } | null = null;
  if (v.startCommand) {
    app = await (deps.startApp ?? startApp)(v.startCommand, cwd!, v.baseUrl);
  }
  try {
    return await fn(cwd);
  } finally {
    if (app) {
      await app.stop();
      await waitUntilDown(v.baseUrl);
    }
  }
}

async function walk(
  profile: Profile,
  project: WatchedProject | undefined,
  mr: MergeRequest | undefined,
  script: Walkthrough,
  outDir: string,
  notes: string[],
  deps: VerifyDeps,
  which: 'change' | 'before' = 'change',
): Promise<StepOutcome[]> {
  const credentials = await testCredentials(profile, project, deps);
  return withApp(project, mr, which, notes, deps, () =>
    runWalkthrough(script, {
      baseUrl: project!.verification.baseUrl!,
      credentials,
      outDir,
      video: which === 'change' && profile.settings.verification.captureVideo,
      // On the target branch the new behaviour's checks are expected to fail; don't wait long.
      ...(which === 'before' ? { stepTimeoutMs: 4000 } : {}),
      launch: deps.launch,
    }),
  );
}

/** The target branch, for "before" screenshots of an open MR. */
async function beforeWorktree(
  project: WatchedProject | undefined,
  mr: MergeRequest | undefined,
  notes: string[],
): Promise<string> {
  if (!mr || !project?.localPath) {
    throw new VerifyError('no watched project with a local clone path for this MR');
  }
  const git = await findOnPath('git');
  if (!git) throw new VerifyError('git is not on PATH');
  const wt = await ensureDetachedWorktree(runCommand, git, {
    clonePath: project.localPath,
    key: `verify-${mr.targetBranch}`,
    remoteBranch: mr.targetBranch,
  });
  notes.push(...wt.warnings);
  return wt.cwd;
}

const MAX_SPEC_SCREENSHOTS = 12;

/**
 * Run the repo's own Playwright tests in the change's worktree with the JSON
 * reporter. BASE_URL (and TEST_USERNAME / TEST_PASSWORD when configured) are
 * passed as environment variables, never written anywhere.
 */
async function runSpec(
  profile: Profile,
  project: WatchedProject | undefined,
  mr: MergeRequest | undefined,
  command: string,
  outDir: string,
  notes: string[],
  deps: VerifyDeps,
): Promise<SpecRunResult> {
  const v = project?.verification ?? {};
  const credentials = await testCredentials(profile, project, deps);
  const reportFile = path.join(outDir, 'playwright-report.json');
  return withApp(project, mr, 'change', notes, deps, async (cwd) => runAndRead(cwd!), true);

  async function runAndRead(cwd: string): Promise<SpecRunResult> {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      BASE_URL: v.baseUrl,
      PLAYWRIGHT_JSON_OUTPUT_NAME: reportFile,
      ...(credentials
        ? { TEST_USERNAME: credentials.username, TEST_PASSWORD: credentials.password }
        : {}),
    };
    const run = await (deps.runShell ?? runShell)(`${command} --reporter=json`, cwd, { env });
    const raw = await readFile(reportFile, 'utf8').catch(() => null);
    if (!raw) {
      let output = redactSecrets(run.output.slice(-800));
      if (credentials?.password) output = output.replaceAll(credentials.password, '••••');
      throw new VerifyError(
        `${run.timedOut ? 'The tests timed out' : `The tests exited (code ${run.code})`} without a report. Output: ${output}`,
      );
    }
    const report = parsePlaywrightReport(JSON.parse(raw));
    const screenshots: string[] = [];
    for (const [i, file] of report.attachments.slice(0, MAX_SPEC_SCREENSHOTS).entries()) {
      const name = `spec-${String(i + 1).padStart(2, '0')}.png`;
      if (
        await copyFile(file, path.join(outDir, name)).then(
          () => true,
          () => false,
        )
      )
        screenshots.push(name);
    }
    return {
      command,
      passed: report.passed,
      failed: report.failed,
      skipped: report.skipped,
      tests: report.tests,
      screenshots,
      ...(run.timedOut ? { error: 'The tests timed out after 10 minutes.' } : {}),
    };
  }
}

async function mrCoverage(profile: Profile, mr: MergeRequest, deps: VerifyDeps) {
  if (profile.isDemo) {
    const fixture = JSON.parse(
      await readFile(path.join(deps.fixturesDir, 'demo/gitlab.json'), 'utf8'),
    ) as DemoGitLabFixture;
    return new DemoCodeHost(fixture).getCoverage(mr.ref);
  }
  if (!deps.credentials) return undefined;
  const host = createGitLabHost({
    profileId: profile.id,
    settings: profile.settings,
    credentials: deps.credentials,
    fetch: deps.fetch,
  });
  return host.getCoverage?.(mr.ref);
}

/** Screenshots in the run folder → data URIs for the self-contained slideshow. */
async function loadImages(
  outDir: string,
  names: (string | undefined)[],
  images: Record<string, string>,
) {
  for (const name of names) {
    if (!name || images[name]) continue;
    const png = await readFile(path.join(outDir, name)).catch(() => null);
    if (png) images[name] = `data:image/png;base64,${png.toString('base64')}`;
  }
}

/** The newest saved walkthrough for a ticket (other than this verification's own). */
async function savedScript(
  db: Db,
  blobs: BlobStore,
  profileId: string,
  issueKey: string,
  exceptId: string,
): Promise<Walkthrough | null> {
  for (const v of await listVerifications(db, profileId, issueKey)) {
    if (v.id === exceptId || !v.scriptBlobKey) continue;
    const data = await blobs.get(v.scriptBlobKey);
    if (!data) continue;
    const parsed = WalkthroughSchema.safeParse(JSON.parse(Buffer.from(data).toString('utf8')));
    if (parsed.success) return parsed.data;
  }
  return null;
}

/**
 * Run a Claude preset that answers in JSON, as a normal (visible) run, retrying
 * once in the same session if the answer doesn't validate.
 */
async function claudeJson<T>(
  db: Db,
  profile: Profile,
  req: {
    preset: PresetId;
    prompt: string;
    cwd: string;
    issueKey: string | null;
    mrKey: string | null;
  },
  schema: Parameters<typeof parseWith<T>>[0],
  deps: VerifyDeps,
): Promise<{ value: T | null; error: string; runId: string }> {
  const preset = profile.settings.claude.presets[req.preset];
  const exec = async (prompt: string, parentRunId?: string) => {
    const id = await createRun(
      db,
      {
        profileId: profile.id,
        preset: req.preset,
        prompt,
        modelRequested: preset.model,
        issueKey: req.issueKey,
        mrKey: req.mrKey,
        parentRunId,
      },
      undefined,
      { enqueue: false },
    );
    await updateRun(db, id, { cwd: req.cwd });
    await executeRun(db, id, { fixturesDir: deps.fixturesDir, runner: deps.runner, pollMs: 500 });
    const events = await listRunEvents(db, id, -1, 5000);
    const result = [...events].reverse().find((e) => e.event.type === 'result')?.event;
    return { id, text: result?.type === 'result' ? (result.resultText ?? '') : '' };
  };

  const first = await exec(req.prompt);
  let parsed = parseWith(schema, first.text);
  if (parsed.ok) return { value: parsed.value, error: '', runId: first.id };
  const run = await getRun(db, first.id);
  if (run?.status !== 'succeeded' || !run.sessionId) {
    return { value: null, error: run?.error ?? parsed.error, runId: first.id };
  }
  const retry = await exec(
    `That reply wasn't valid: ${parsed.error}\nReply again with only the JSON object in the requested shape.`,
    first.id,
  );
  parsed = parseWith(schema, retry.text);
  return parsed.ok
    ? { value: parsed.value, error: '', runId: first.id }
    : { value: null, error: parsed.error, runId: first.id };
}
