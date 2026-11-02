import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { getDatabaseUrl } from './paths';
import * as schema from './schema';

export function createDb(url: string = getDatabaseUrl()) {
  const client = createClient({ url });
  return drizzle(client, { schema });
}

export type Db = ReturnType<typeof createDb>;

const globalForDb = globalThis as unknown as { tabEnterDb?: Promise<Db> };

/**
 * Process-wide connection. The web app and the worker both open the same file,
 * so use WAL and a busy timeout to let them write without "database is locked".
 */
export function getDb(): Promise<Db> {
  globalForDb.tabEnterDb ??= (async () => {
    const db = createDb();
    await db.run('PRAGMA journal_mode = WAL');
    await db.run('PRAGMA busy_timeout = 5000');
    await db.run('PRAGMA foreign_keys = ON');
    return db;
  })();
  return globalForDb.tabEnterDb;
}
