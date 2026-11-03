import type { FetchLike } from '@tab-enter/connectors';
import {
  JobSchema,
  redactSecrets,
  type CredentialProvider,
  type Job,
  type JobType,
} from '@tab-enter/core';
import {
  claimNextJob,
  enqueueJob,
  finishJob,
  getDataDir,
  getProfile,
  getSyncStates,
  hasPendingJob,
  listProfiles,
  type ClaimFilter,
  type Db,
} from '@tab-enter/db';
import { executeRun, type AgentRunDeps } from './handlers/agent-run';
import { cleanupWorktrees, removeWorktree } from './handlers/cleanup-worktrees';
import { deleteProfileFiles } from './handlers/delete-profile-files';
import { detectTools } from './handlers/detect-tools';
import { openTerminal, type OpenTerminalDeps } from './handlers/open-terminal';
import { syncProfile } from './handlers/sync';
import { executeVerification, type VerifyDeps } from './handlers/verify';
import { executeWriteAction, listJiraTransitions, type WriteDeps } from './handlers/write-action';
import { FileBlobStore } from '@tab-enter/db/blob-store';
import type { SecretStore } from '@tab-enter/secrets';

export interface WorkerDeps {
  fixturesDir: string;
  /** Tokens for live Jira/GitLab syncs (from the OS keychain in production). */
  credentials?: CredentialProvider;
  fetch?: FetchLike;
  log?: (message: string) => void;
  /** Read-only access to the keychain, for verification test credentials. */
  secrets?: Pick<SecretStore, 'get'>;
  /** Overrides for agent runs, terminals and verification (tests). */
  run?: Omit<AgentRunDeps, 'fixturesDir'>;
  terminal?: OpenTerminalDeps;
  verify?: Partial<Omit<VerifyDeps, 'fixturesDir'>>;
  write?: Partial<WriteDeps>;
}

/** Long jobs that run in the pool beside syncs. */
const POOLED: JobType[] = ['agent-run', 'verify'];

/** Handlers resolve to nothing, or to a result stored on the job (query jobs). */
async function dispatch(db: Db, job: Job, deps: WorkerDeps): Promise<unknown> {
  const writeDeps = { credentials: deps.credentials, fetch: deps.fetch, ...deps.write };
  switch (job.type) {
    case 'write-action':
      return executeWriteAction(db, job, writeDeps);
    case 'jira-transitions':
      return listJiraTransitions(db, job, writeDeps);
    case 'detect-tools':
      return detectTools(db);
    case 'sync':
      await syncProfile(db, job.profileId, {
        fixturesDir: deps.fixturesDir,
        credentials: deps.credentials,
        fetch: deps.fetch,
      });
      // Fresh MR states may mean worktrees to clean up.
      if (
        (await getProfile(db, job.profileId))?.settings.gitlab.projects.some((p) => p.localPath) &&
        !(await hasPendingJob(db, 'cleanup-worktrees', job.profileId))
      )
        await enqueueJob(db, { type: 'cleanup-worktrees', profileId: job.profileId });
      return;
    case 'cleanup-worktrees':
      return cleanupWorktrees(db, job.profileId, deps.run);
    case 'remove-worktree':
      return removeWorktree(db, job, deps.run);
    case 'delete-profile-files':
      return deleteProfileFiles(job.profileId);
    case 'agent-run':
      return executeRun(db, job.runId, { fixturesDir: deps.fixturesDir, ...deps.run });
    case 'open-terminal':
      return openTerminal(db, job, deps.terminal);
    case 'verify':
      return executeVerification(db, job, {
        fixturesDir: deps.fixturesDir,
        blobs: new FileBlobStore(getDataDir()),
        credentials: deps.credentials,
        secrets: deps.secrets,
        fetch: deps.fetch,
        runner: deps.run?.runner,
        ...deps.verify,
      });
  }
}

/** Run one queued job matching `filter`. Returns the job's promise, or null when none is queued. */
export async function startNextJob(
  db: Db,
  deps: WorkerDeps,
  filter: ClaimFilter = {},
): Promise<{ profileId: string | null; done: Promise<void> } | null> {
  const row = await claimNextJob(db, new Date(), filter);
  if (!row) return null;
  const log = deps.log ?? console.log;
  const parsed = JobSchema.safeParse(row.payload);
  if (!parsed.success) {
    await finishJob(db, row.id, `Invalid job payload: ${parsed.error.message}`);
    return { profileId: row.profileId, done: Promise.resolve() };
  }
  const started = Date.now();
  const done = (async () => {
    try {
      const result = await dispatch(db, parsed.data, deps);
      await finishJob(db, row.id, undefined, result ?? null);
      log(`job ${row.type} done in ${Date.now() - started}ms`);
    } catch (err) {
      const message = redactSecrets(err instanceof Error ? err.message : String(err));
      await finishJob(db, row.id, message);
      log(`job ${row.type} failed: ${message}`);
    }
  })();
  return { profileId: row.profileId, done };
}

/** Run one queued non-run job to completion. Returns false when the queue is empty. */
export async function processNextJob(
  db: Db,
  deps: WorkerDeps,
  filter: ClaimFilter = { excludeTypes: POOLED },
): Promise<boolean> {
  const started = await startNextJob(db, deps, filter);
  if (!started) return false;
  await started.done;
  return true;
}

/**
 * Agent runs execute concurrently, beside syncs, up to each profile's
 * `claude.maxParallelRuns`; the rest stay queued.
 */
export class RunPool {
  private readonly active = new Map<string, number>();
  private readonly running = new Set<Promise<void>>();

  constructor(
    private readonly db: Db,
    private readonly deps: WorkerDeps,
  ) {}

  get size(): number {
    return this.running.size;
  }

  /** Start as many queued runs as capacity allows. */
  async fill(): Promise<void> {
    const limits = new Map(
      (await listProfiles(this.db)).map((p) => [p.id, p.settings.claude.maxParallelRuns]),
    );
    for (;;) {
      const full = [...this.active]
        .filter(([id, n]) => n >= (limits.get(id) ?? 2))
        .map(([id]) => id);
      const started = await startNextJob(this.db, this.deps, {
        types: POOLED,
        excludeProfileIds: full,
      });
      if (!started) return;
      const id = started.profileId ?? '';
      this.active.set(id, (this.active.get(id) ?? 0) + 1);
      const tracked = started.done.finally(() => {
        this.active.set(id, (this.active.get(id) ?? 1) - 1);
        this.running.delete(tracked);
      });
      this.running.add(tracked);
    }
  }

  /** Wait for every started run (tests, shutdown). */
  async drain(): Promise<void> {
    while (this.running.size > 0) await Promise.all([...this.running]);
  }
}

/** Queue a sync for each profile whose interval has elapsed. */
export async function scheduleDueSyncs(db: Db, now = new Date()): Promise<void> {
  for (const profile of await listProfiles(db)) {
    if (await hasPendingJob(db, 'sync', profile.id)) continue;
    const states = await getSyncStates(db, profile.id);
    const lastAttempt = Math.min(
      ...['jira', 'gitlab'].map(
        (s) => states.find((x) => x.source === s)?.lastAttemptAt?.getTime() ?? 0,
      ),
    );
    const intervalMs = profile.settings.syncIntervalMinutes * 60_000;
    if (now.getTime() - lastAttempt >= intervalMs) {
      await enqueueJob(db, { type: 'sync', profileId: profile.id });
    }
  }
}
