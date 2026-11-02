import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDb, type Db } from './client';
import { runMigrations } from './migrate';

/** A migrated database in a fresh temp file (libsql transactions don't share :memory: dbs). */
export async function createTestDb(): Promise<Db> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tab-enter-db-'));
  const db = createDb(pathToFileURL(path.join(dir, 'test.db')).href);
  await runMigrations(db);
  return db;
}
