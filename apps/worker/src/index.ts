import { defaultProfileSettings } from '@tab-enter/core';
import {
  enqueueJob,
  ensureDemoProfile,
  failOrphanedRuns,
  failOrphanedVerifications,
  getDataDir,
  getDb,
  getProfile,
  hasPendingJob,
  requeueStaleJobs,
} from '@tab-enter/db';
import { ensureDataDir, runMigrations } from '@tab-enter/db/migrate';
import {
  createSecretStore,
  PatCredentialProvider,
  SECRET_NAMES,
  type SecretStore,
} from '@tab-enter/secrets';
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
  await failOrphanedVerifications(db);
  const orphaned = await failOrphanedRuns(db);
  if (orphaned > 0) log(`marked ${orphaned} interrupted run(s) as failed`);
  await requeueStaleJobs(db, new Date(Date.now() - STALE_LOCK_MS));
  if (!(await hasPendingJob(db, 'detect-tools'))) await enqueueJob(db, { type: 'detect-tools' });

  // Opened lazily: a missing keychain only matters once a live profile syncs.
  let store: Promise<SecretStore> | null = null;
  const openStore = () =>
    (store ??= createSecretStore({
      dataDir: getDataDir(),
      passphrase: process.env.TAB_ENTER_PASSPHRASE,
    }).catch((err: unknown) => {
      store = null;
      throw err;
    }));
  const lazyStore: SecretStore = {
    kind: 'keychain',
    get: async (profileId, name) => (await openStore()).get(profileId, name),
    set: () => Promise.reject(new Error('The worker never writes secrets.')),
    delete: () => Promise.reject(new Error('The worker never deletes secrets.')),
  };
  // The single exception: importing a GitLab token from glab, at the user's request.
  const gitlabTokenWriter: Pick<SecretStore, 'set'> = {
    set: async (profileId, name, value) => {
      if (name !== SECRET_NAMES.gitlabToken)
        throw new Error('The worker only writes GitLab tokens.');
      return (await openStore()).set(profileId, name, value);
    },
  };
  const credentials = new PatCredentialProvider(
    lazyStore,
    async (profileId) => (await getProfile(db, profileId))?.settings ?? defaultProfileSettings(),
  );

  const deps = {
    fixturesDir: getFixturesDir(),
    credentials,
    secrets: lazyStore,
    gitlabTokenWriter,
    log,
  };
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
