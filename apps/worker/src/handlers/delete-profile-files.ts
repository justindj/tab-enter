import { rm } from 'node:fs/promises';
import { getProfileDir } from '@tab-enter/db';

/** Remove a deleted profile's artifacts, run logs and message history from disk. */
export async function deleteProfileFiles(profileId: string): Promise<void> {
  await rm(getProfileDir(profileId), { recursive: true, force: true });
}
