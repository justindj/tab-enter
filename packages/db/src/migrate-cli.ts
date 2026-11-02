import { getDb } from './client';
import { ensureDataDir, runMigrations } from './migrate';
import { getDatabaseUrl } from './paths';

await ensureDataDir();
await runMigrations(await getDb());
console.log(`tab-enter: database ready (${getDatabaseUrl()})`);
