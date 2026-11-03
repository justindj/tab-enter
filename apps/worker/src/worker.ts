import { JobSchema, redactSecrets, type CredentialProvider, type Job } from '@tab-enter/core';
import type { FetchLike } from '@tab-enter/connectors';
import {
  claimNextJob,
  enqueueJob,
  finishJob,
  getSyncStates,
  hasPendingJob,
  listProfiles,
  type Db,
} from '@tab-enter/db';
import { deleteProfileFiles } from './handlers/delete-profile-files';
import { detectTools } from './handlers/detect-tools';
import { syncProfile } from './handlers/sync';

export interface WorkerDeps {
  fixturesDir: string;
  /** Tokens for live Jira/GitLab syncs (from the OS keychain in production). */
  credentials?: CredentialProvider;
  fetch?: FetchLike;
  log?: (message: string) => void;
}

async function dispatch(db: Db, job: Job, deps: WorkerDeps): Promise<void> {
  switch (job.type) {
    case 'detect-tools':
      return detectTools(db);
    case 'sync':
      return syncProfile(db, job.profileId, {
        fixturesDir: deps.fixturesDir,
        credentials: deps.credentials,
        fetch: deps.fetch,
      });
    case 'delete-profile-files':
      return deleteProfileFiles(job.profileId);
  }
}

/** Run one queued job. Returns false when the queue is empty. */
export async function processNextJob(db: Db, deps: WorkerDeps): Promise<boolean> {
  const row = await claimNextJob(db);
  if (!row) return false;
  const log = deps.log ?? console.log;
  const parsed = JobSchema.safeParse(row.payload);
  if (!parsed.success) {
    await finishJob(db, row.id, `Invalid job payload: ${parsed.error.message}`);
    return true;
  }
  const started = Date.now();
  try {
    await dispatch(db, parsed.data, deps);
    await finishJob(db, row.id);
    log(`job ${row.type} done in ${Date.now() - started}ms`);
  } catch (err) {
    const message = redactSecrets(err instanceof Error ? err.message : String(err));
    await finishJob(db, row.id, message);
    log(`job ${row.type} failed: ${message}`);
  }
  return true;
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
