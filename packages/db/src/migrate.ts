import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/libsql/migrator';
import type { Db } from './client';
import { getDataDir } from './paths';

// Kept out of the main entry point: it touches the filesystem, so only the
// worker and CLI scripts import it, never the web app.

export const MIGRATIONS_DIR = fileURLToPath(new URL('../drizzle', import.meta.url));

export async function ensureDataDir(): Promise<void> {
  await mkdir(getDataDir(), { recursive: true });
}

export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
}
