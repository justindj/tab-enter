import {
  enqueueJob,
  ensureDemoProfile,
  getDb,
  hasPendingJob,
  requeueStaleJobs,
} from '@tab-enter/db';
import { ensureDataDir, runMigrations } from '@tab-enter/db/migrate';
import { getFixturesDir } from './paths';
import { processNextJob, scheduleDueSyncs } from './worker';

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
  await requeueStaleJobs(db, new Date(Date.now() - STALE_LOCK_MS));
  if (!(await hasPendingJob(db, 'detect-tools'))) await enqueueJob(db, { type: 'detect-tools' });

  const deps = { fixturesDir: getFixturesDir(), log };
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  log('started');
  while (!stopping) {
    try {
      await scheduleDueSyncs(db);
      while (!stopping && (await processNextJob(db, deps))) {
        // drain the queue
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
