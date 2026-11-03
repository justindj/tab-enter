'use server';

import {
  describeWrite,
  isWriteAllowed,
  WRITE_SETTING,
  WRITE_SETTING_LABELS,
  WriteActionSchema,
  type WriteAction,
} from '@tab-enter/core';
import {
  createWriteAction,
  enqueueJob,
  getActiveProfile,
  getDb,
  getJob,
  getRun,
  getWriteAction,
} from '@tab-enter/db';
import { revalidatePath } from 'next/cache';

export interface WriteResult {
  ok?: string;
  error?: string;
  url?: string;
}

const WAIT_MS = 90_000;

/**
 * Perform a write the user just confirmed: log it with its exact payload,
 * have the worker do it, and wait for the outcome. Gated by Settings here and
 * again in the worker.
 */
export async function requestWriteAction(input: WriteAction): Promise<WriteResult> {
  const parsed = WriteActionSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid action.' };
  const action = parsed.data;
  const db = await getDb();
  const profile = await getActiveProfile(db);
  if (!profile) return { error: 'No active profile.' };
  if (!isWriteAllowed(profile.settings, action.kind)) {
    return {
      error: `“${WRITE_SETTING_LABELS[WRITE_SETTING[action.kind]].label}” is off. Turn it on in Settings → Write actions.`,
    };
  }
  let branch: string | null = null;
  if ('runId' in action) {
    const run = await getRun(db, action.runId);
    if (!run || run.profileId !== profile.id) return { error: 'Run not found.' };
    branch = run.branch;
  }
  const { summary, target } = describeWrite(action, { branch });
  const actionId = await createWriteAction(db, {
    profileId: profile.id,
    action: action.kind,
    target,
    summary,
    payload: action,
  });
  await enqueueJob(db, { type: 'write-action', profileId: profile.id, actionId });

  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400));
    const row = await getWriteAction(db, actionId);
    if (row?.status === 'done') {
      revalidatePath('/', 'layout');
      return { ok: row.result?.message ?? 'Done.', url: row.result?.url };
    }
    if (row?.status === 'failed') return { error: row.error ?? 'The write failed.' };
  }
  return { ok: 'Still working. See Settings → Write log for the outcome.' };
}

/** A ticket's workflow transitions (read via the worker). */
export async function loadTransitionsAction(
  issueKey: string,
): Promise<{ transitions?: { id: string; name: string; to: string }[]; error?: string }> {
  const db = await getDb();
  const profile = await getActiveProfile(db);
  if (!profile) return { error: 'No active profile.' };
  const jobId = await enqueueJob(db, { type: 'jira-transitions', profileId: profile.id, issueKey });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    const job = await getJob(db, jobId);
    if (job?.status === 'done') {
      return { transitions: (job.result as { id: string; name: string; to: string }[]) ?? [] };
    }
    if (job?.status === 'failed') return { error: job.error ?? 'Could not load transitions.' };
  }
  return { error: 'Timed out loading transitions.' };
}
