'use server';

import type { Job } from '@tab-enter/core';
import { enqueueJob, getDb, getJob, getToolStatuses } from '@tab-enter/db';
import { revalidatePath } from 'next/cache';
import type { ActionResult } from '@/app/actions';

// Sign-in shortcuts. Both run in the worker: the web app never starts
// processes, and the GitLab token goes from glab straight to the keychain
// without passing through the browser or the jobs table.

async function runJob(job: Job, timeoutMs: number) {
  const db = await getDb();
  const id = await enqueueJob(db, job);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    const row = await getJob(db, id);
    if (row?.status === 'done') return { result: row.result };
    if (row?.status === 'failed') return { error: row.error ?? 'It failed.' };
  }
  return { error: 'Timed out waiting for the worker. Is `pnpm dev` still running?' };
}

export async function claudeLoginAction(): Promise<ActionResult> {
  const r = await runJob({ type: 'claude-login' }, 15_000);
  return r.error
    ? { error: r.error }
    : { ok: 'A terminal opened with `claude auth login`. Finish signing in in your browser.' };
}

/** Re-detect Claude Code; the setup page polls this after Log in. */
export async function recheckClaudeAction(): Promise<{ loggedIn: boolean | null }> {
  await runJob({ type: 'detect-tools' }, 20_000);
  const claude = (await getToolStatuses(await getDb())).claude;
  if (claude?.loggedIn) revalidatePath('/', 'layout');
  return { loggedIn: claude?.loggedIn ?? null };
}

export async function importGlabTokenAction(profileId: string): Promise<ActionResult> {
  const r = await runJob({ type: 'import-glab-token', profileId }, 45_000);
  if (r.error) return { error: r.error };
  const { username, host } = r.result as { username: string; host: string };
  const db = await getDb();
  await enqueueJob(db, { type: 'sync', profileId });
  revalidatePath('/', 'layout');
  return { ok: `Imported glab's token for ${host} (signed in as ${username}). Syncing now.` };
}
