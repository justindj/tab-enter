import os from 'node:os';
import path from 'node:path';

/** Root of all local data: database, artifacts, run logs, worktree metadata. */
export function getDataDir(): string {
  return process.env.TAB_ENTER_HOME ?? path.join(os.homedir(), '.tab-enter');
}

export function getDatabaseUrl(): string {
  return process.env.TAB_ENTER_DB_URL ?? `file:${path.join(getDataDir(), 'tab-enter.db')}`;
}

/** Each profile gets its own folder; nothing is shared between profiles. */
export function getProfileDir(profileId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(profileId)) throw new Error(`Invalid profile id: ${profileId}`);
  return path.join(getDataDir(), 'profiles', profileId);
}
