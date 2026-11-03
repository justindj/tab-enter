import { defaultProfileSettings } from '@tab-enter/core';
import {
  enqueueJob,
  ensureDemoProfile,
  failOrphanedRuns,
  getDataDir,
  getDb,
  getProfile,
  hasPendingJob,
  requeueStaleJobs,
} from '@tab-enter/db';
import { ensureDataDir, runMigrations } from '@tab-enter/db/migrate';
import { createSecretStore, PatCredentialProvider, type SecretStore } from '@tab-enter/secrets';
import { getFixturesDir } from './paths';
import { processNextJob, RunPool, scheduleDueSyncs } from './worker';

// The only process that touches git, Claude Code, RTK, Playwright, or the
// network. The web app talks to it exclusively through the jobs table.

const POLL_MS = 1000;
const STALE_LOCK_MS = 10 * 60_000;
const log = (message: string) => console.log(`[worker] ${message}`);

async function main() {
  await ensureDataDir();
  const db = await getDb();
  await runMigrations(db);
  await ensureDemoProfile(db);
  const orphaned = await failOrphanedRuns(db);
  if (orphaned > 0) log(`marked ${orphaned} interrupted run(s) as failed`);
  await requeueStaleJobs(db, new Date(Date.now() - STALE_LOCK_MS));
  if (!(await hasPendingJob(db, 'detect-tools'))) await enqueueJob(db, { type: 'detect-tools' });

  // Opened lazily: a missing keychain only matters once a live profile syncs.
  let store: Promise<SecretStore> | null = null;
  const lazyStore: SecretStore = {
    kind: 'keychain',
    get: async (profileId, name) => {
      store ??= createSecretStore({
        dataDir: getDataDir(),
        passphrase: process.env.TAB_ENTER_PASSPHRASE,
      }).catch((err: unknown) => {
        store = null;
        throw err;
      });
      return (await store).get(profileId, name);
    },
    set: () => Promise.reject(new Error('The worker never writes secrets.')),
    delete: () => Promise.reject(new Error('The worker never deletes secrets.')),
  };
  const credentials = new PatCredentialProvider(
    lazyStore,
    async (profileId) => (await getProfile(db, profileId))?.settings ?? defaultProfileSettings(),
  );

  const deps = { fixturesDir: getFixturesDir(), credentials, log };
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  const pool = new RunPool(db, deps);

  log('started');
  while (!stopping) {
    try {
      await scheduleDueSyncs(db);
      await pool.fill();
      while (!stopping && (await processNextJob(db, deps))) {
        // drain the queue of non-run jobs; runs keep going in the pool
        await pool.fill();
      }
    } catch (err) {
      log(`loop error: ${err instanceof Error ? err.message : String(err)}`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  log('stopped');
}

main().catch((err) => {
  console.error('[worker] fatal', err);
  process.exit(1);
});
