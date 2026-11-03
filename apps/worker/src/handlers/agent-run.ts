import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ClaudeCodeRunner, ReplayRunner, rtkRunSettings, summarizeEvents } from '@tab-enter/claude';
import { redactDeep, redactSecrets, type AgentEvent, type AgentRunner } from '@tab-enter/core';
import {
  appendRunEvents,
  getProfile,
  getProfileDir,
  getRun,
  getToolStatuses,
  updateRun,
  type Db,
  type RunRow,
} from '@tab-enter/db';
import { resolveWorkspace, type WorkspaceDeps } from '../workspace';

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
  if (!cwd) {
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

  try {
    for await (const event of runner.run(
      {
        runId,
        cwd,
        prompt: run.prompt,
        preset,
        resumeSessionId: run.sessionId ?? undefined,
        settingsPath,
      },
      controller.signal,
    )) {
      push(event);
      if (event.type === 'init' && event.sessionId) {
        await updateRun(db, runId, { sessionId: event.sessionId, modelUsed: event.model });
      }
      if (pending.length >= FLUSH_EVERY) await flush();
    }
  } catch (err) {
    push({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  } finally {
    clearInterval(timer);
    while (ticking) await new Promise((r) => setTimeout(r, 10));
    await flush();
  }

  const summary = summarizeEvents(all);
  const result = summary.result;
  const status = cancelled ? 'cancelled' : result && !result.isError ? 'succeeded' : 'failed';
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
    diffSummary: { filesChanged: summary.filesChanged },
    inputTokens: result?.usage.inputTokens ?? null,
    outputTokens: result?.usage.outputTokens ?? null,
    cacheReadTokens: result?.usage.cacheReadTokens ?? null,
    cacheCreationTokens: result?.usage.cacheCreationTokens ?? null,
    costUsd: result?.usage.costUsd ?? null,
    numTurns: result?.numTurns ?? null,
    endedAt: new Date(),
  });
}
