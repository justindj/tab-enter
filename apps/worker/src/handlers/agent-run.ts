import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  ClaudeCodeRunner,
  findOnPath,
  ReplayRunner,
  rtkRunSettings,
  runCommand,
  summarizeEvents,
} from '@tab-enter/claude';
import {
  parseReviewResult,
  redactDeep,
  redactSecrets,
  reviewRetryPrompt,
  type AgentEvent,
  type AgentRunner,
  type StoredReview,
} from '@tab-enter/core';
import {
  appendRunEvents,
  saveCodeReview,
  getProfile,
  getProfileDir,
  getRun,
  getToolStatuses,
  updateRun,
  type Db,
  type RunRow,
} from '@tab-enter/db';
import { resolveWorkspace, type WorkspaceDeps } from '../workspace';
import { branchStatus } from '../worktree';
import { prepareReview, type PreparedReview } from './review';

export interface AgentRunDeps extends WorkspaceDeps {
  fixturesDir: string;
  /** Tests inject a runner; production builds one per run. */
  runner?: (run: RunRow, vars: Record<string, string>) => AgentRunner;
  /** How often the cancel flag is checked and events are flushed. */
  pollMs?: number;
}

const FLUSH_EVERY = 25;

function defaultRunner(isDemo: boolean, fixturesDir: string, vars: Record<string, string>) {
  if (isDemo) {
    return new ReplayRunner({
      taskFixture: path.join(fixturesDir, 'claude/work-ticket.stream.jsonl'),
      analysisFixture: path.join(fixturesDir, 'claude/code-review.result.json'),
    });
  }
  return new ClaudeCodeRunner({ vars });
}

/**
 * Execute one queued run: find or create its worktree, stream Claude Code's
 * events into run_events (redacted), and record session, usage and outcome.
 * Errors end up on the run row; this only throws on programming errors.
 */
export async function executeRun(db: Db, runId: string, deps: AgentRunDeps): Promise<void> {
  const run = await getRun(db, runId);
  if (!run || run.status !== 'queued') return; // cancelled while queued, or already handled
  const profile = await getProfile(db, run.profileId);
  const fail = (error: string) =>
    updateRun(db, runId, { status: 'failed', error: redactSecrets(error), endedAt: new Date() });
  if (!profile) return fail('The profile was deleted.');

  const { settings } = profile;
  if (!profile.isDemo && !settings.claude.approvedForClient) {
    return fail('Claude Code is not approved for this client. Turn it on in Settings first.');
  }
  const preset = settings.claude.presets[run.preset];
  if (!preset) return fail(`Unknown preset ${run.preset}.`);

  // Where to work: a Continue reuses its parent's folder and session.
  let cwd = run.cwd;
  const notes: string[] = [];
  if (!cwd && !run.issueKey && !run.mrKey) {
    // Text-only runs (report polish) need no repository: an empty scratch folder.
    cwd = path.join(getProfileDir(profile.id), 'scratch');
    await mkdir(cwd, { recursive: true });
    await updateRun(db, runId, { cwd });
  } else if (!cwd) {
    try {
      const ws = await resolveWorkspace(
        db,
        profile,
        { issueKey: run.issueKey, mrKey: run.mrKey, projectId: run.projectId },
        deps,
      );
      cwd = ws.cwd;
      notes.push(...ws.warnings);
      await updateRun(db, runId, { cwd, branch: ws.branch, projectId: ws.projectId });
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }

  // Per-run files: artifacts folder and (for RTK per-run mode) a settings file.
  const runDir = path.join(getProfileDir(profile.id), 'runs', runId);
  const artifactsDir = path.join(runDir, 'artifacts');
  await mkdir(artifactsDir, { recursive: true });
  let settingsPath: string | undefined;
  if (!profile.isDemo && settings.rtk.mode === 'per-run') {
    const rtk = (await getToolStatuses(db)).rtk;
    if (rtk?.installed) {
      settingsPath = path.join(runDir, 'claude-settings.json');
      await writeFile(
        settingsPath,
        JSON.stringify(
          rtkRunSettings({ rtkPath: rtk.path, telemetry: settings.rtk.telemetry }),
          null,
          2,
        ),
      );
    } else {
      notes.push('RTK per-run mode is on but rtk is not installed; running without it.');
    }
  }

  // Code reviews: the worker builds the prompt, since it needs the worktree's diff.
  let prompt = run.prompt;
  let review: PreparedReview | null = null;
  if (run.preset === 'code-review' && run.mrKey) {
    try {
      review = await prepareReview(db, profile, run, cwd, deps);
      prompt = review.prompt;
      notes.push(...review.notes);
      await updateRun(db, runId, { prompt });
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }

  const vars = { artifactsDir: artifactsDir.replace(/\\/g, '/') };
  const runner = deps.runner?.(run, vars) ?? defaultRunner(profile.isDemo, deps.fixturesDir, vars);

  await updateRun(db, runId, { status: 'running', startedAt: new Date() });

  const controller = new AbortController();
  let cancelled = false;
  const all: AgentEvent[] = [];
  let pending: { seq: number; event: AgentEvent }[] = [];
  let seq = 0;
  const flush = async () => {
    const batch = pending;
    pending = [];
    await appendRunEvents(db, { id: runId, profileId: profile.id }, batch);
  };
  const push = (event: AgentEvent) => {
    const safe = redactDeep(event);
    all.push(safe);
    pending.push({ seq: seq++, event: safe });
  };
  for (const note of notes) push({ type: 'text', text: `[tab-enter] ${note}` });

  // Check for Cancel and flush the log on a timer, so the UI updates even
  // when Claude is quiet for a while.
  let ticking = false;
  const timer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    void (async () => {
      try {
        await flush();
        if ((await getRun(db, runId))?.cancelRequested) {
          cancelled = true;
          controller.abort();
        }
      } finally {
        ticking = false;
      }
    })();
  }, deps.pollMs ?? 1000);

  const stream = async (text: string, resumeSessionId: string | undefined) => {
    for await (const event of runner.run(
      { runId, cwd, prompt: text, preset, resumeSessionId, settingsPath },
      controller.signal,
    )) {
      push(event);
      if (event.type === 'init' && event.sessionId) {
        await updateRun(db, runId, { sessionId: event.sessionId, modelUsed: event.model });
      }
      if (pending.length >= FLUSH_EVERY) await flush();
    }
  };

  let stored: StoredReview | null = null;
  try {
    await stream(prompt, run.sessionId ?? undefined);
    if (review && !cancelled) {
      // Validate the structured answer; on failure ask once more in the same session.
      let parsed = parseReviewResult(lastResultText(all) ?? '');
      const session = summarizeEvents(all).sessionId;
      if (!parsed.ok && session && lastResultText(all) !== null) {
        push({
          type: 'text',
          text: `[tab-enter] Review reply didn't validate (${parsed.error}); asking once more.`,
        });
        await stream(reviewRetryPrompt(parsed.error), session);
        parsed = parseReviewResult(lastResultText(all) ?? '');
      }
      const raw = lastResultText(all);
      if (raw !== null) {
        stored = {
          review: parsed.ok ? parsed.review : null,
          raw: parsed.ok ? null : raw,
          error: parsed.ok ? null : parsed.error,
          incrementalFrom: review.incrementalFrom,
          excludedFiles: review.excludedFiles,
          truncated: review.truncated,
        };
      }
    }
  } catch (err) {
    push({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  } finally {
    clearInterval(timer);
    while (ticking) await new Promise((r) => setTimeout(r, 10));
    await flush();
  }

  if (stored && review && !cancelled) {
    await saveCodeReview(db, {
      profileId: profile.id,
      mrKey: run.mrKey!,
      reviewedSha: review.headSha,
      runId,
      result: stored,
    });
  }

  const summary = summarizeEvents(all);
  const result = summary.result;
  const usage = totalUsage(all);
  const status = cancelled ? 'cancelled' : result && !result.isError ? 'succeeded' : 'failed';

  // Task runs in a worktree: note unpushed commits and uncommitted files, for
  // the (gated) Push branch action and so nothing is silently left behind.
  let branchInfo: { commits: string[]; uncommitted: number } | null = null;
  const branch = (await getRun(db, runId))?.branch;
  if (profile.isDemo && preset.mode === 'task' && result && !result.isError) {
    // Demo: a pretend commit so the (simulated) Push / Open MR flow can be tried.
    branchInfo = {
      commits: [`0000000 (demo) ${run.issueKey ?? ''} changes`.trim()],
      uncommitted: 0,
    };
  } else if (!profile.isDemo && preset.mode === 'task' && branch && !branch.startsWith('origin/')) {
    const gitPath = await (deps.findGit ?? (() => findOnPath('git')))();
    if (gitPath)
      branchInfo = await branchStatus(deps.run ?? runCommand, gitPath, cwd).catch(() => null);
  }

  await updateRun(db, runId, {
    status,
    sessionId: summary.sessionId ?? run.sessionId,
    modelUsed: summary.model,
    error:
      status === 'failed'
        ? (summary.errors.at(-1) ??
          result?.resultText ??
          `Run ended: ${result?.subtype ?? 'no result'}`)
        : null,
    diffSummary: { filesChanged: summary.filesChanged, ...(branchInfo ?? {}) },
    inputTokens: usage?.inputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    cacheReadTokens: usage?.cacheReadTokens ?? null,
    cacheCreationTokens: usage?.cacheCreationTokens ?? null,
    costUsd: usage?.costUsd ?? null,
    numTurns: usage?.numTurns ?? null,
    endedAt: new Date(),
  });
}

function lastResultText(events: AgentEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === 'result') return e.resultText;
  }
  return null;
}

/** Usage across every result in the run (a review retry adds a second one). */
function totalUsage(events: AgentEvent[]) {
  const results = events.filter((e) => e.type === 'result');
  if (results.length === 0) return null;
  let costKnown = false;
  const total = results.reduce(
    (acc, r) => {
      if (r.usage.costUsd !== null) costKnown = true;
      return {
        inputTokens: acc.inputTokens + r.usage.inputTokens,
        outputTokens: acc.outputTokens + r.usage.outputTokens,
        cacheReadTokens: acc.cacheReadTokens + r.usage.cacheReadTokens,
        cacheCreationTokens: acc.cacheCreationTokens + r.usage.cacheCreationTokens,
        costUsd: acc.costUsd + (r.usage.costUsd ?? 0),
        numTurns: acc.numTurns + (r.numTurns ?? 0),
      };
    },
    {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0,
      numTurns: 0,
    },
  );
  return { ...total, costUsd: costKnown ? total.costUsd : null };
}
