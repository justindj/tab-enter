'use server';

import { enqueueJob, getDb, getWorktree, setWorktreeStatus } from '@tab-enter/db';
import { revalidatePath } from 'next/cache';
import type { ActionResult } from '@/app/actions';

// Worktree cleanup decisions. The removal itself is a worker job (only the
// worker touches git); these only record the user's choice.

async function pendingRow(id: string) {
  const db = await getDb();
  const row = await getWorktree(db, id);
  return row?.status === 'needs_confirmation' ? { db, row } : null;
}

export async function confirmRemoveWorktree(id: string): Promise<ActionResult> {
  const found = await pendingRow(id);
  if (!found) return { error: 'That worktree is no longer waiting for a decision.' };
  await enqueueJob(found.db, {
    type: 'remove-worktree',
    profileId: found.row.profileId,
    worktreeId: id,
  });
  revalidatePath('/settings');
  return { ok: 'Removing…' };
}

export async function keepWorktree(id: string): Promise<ActionResult> {
  const found = await pendingRow(id);
  if (!found) return { error: 'That worktree is no longer waiting for a decision.' };
  await setWorktreeStatus(found.db, id, 'kept');
  revalidatePath('/settings');
  return { ok: 'Kept. tab-enter won’t ask about it again.' };
}
