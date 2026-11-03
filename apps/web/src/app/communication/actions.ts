'use server';

import { cleanPolishResult, polishPrompt } from '@tab-enter/core';
import {
  createRun,
  getActiveProfile,
  getDb,
  getRun,
  listRunEvents,
  saveMessage,
} from '@tab-enter/db';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { ActionResult } from '@/app/actions';

const CopiedSchema = z.object({
  kind: z.enum(['daily-report', 'review-request']),
  format: z.enum(['slack', 'plain']),
  body: z.string().trim().min(1).max(50_000),
  windowStart: z.string().datetime().nullable(),
  windowEnd: z.string().datetime().nullable(),
});

/** Record a copied message in history (newest 30 kept). */
export async function saveCopiedMessageAction(
  input: z.input<typeof CopiedSchema>,
): Promise<ActionResult> {
  const parsed = CopiedSchema.safeParse(input);
  if (!parsed.success) return { error: 'Nothing to save.' };
  const db = await getDb();
  const profile = await getActiveProfile(db);
  if (!profile) return { error: 'No active profile.' };
  const { windowStart, windowEnd, ...rest } = parsed.data;
  const saved = await saveMessage(db, {
    profileId: profile.id,
    ...rest,
    windowStart: windowStart ? new Date(windowStart) : null,
    windowEnd: windowEnd ? new Date(windowEnd) : null,
  });
  revalidatePath('/communication');
  return { ok: saved.duplicate ? 'Copied.' : 'Copied and saved to history.' };
}

const PolishSchema = z.object({
  text: z.string().trim().min(1, 'Nothing to polish.').max(20_000),
  style: z.enum(['concise', 'detailed']),
  format: z.enum(['slack', 'plain']),
});

/** Start a short-text Claude Code run that rewrites the message. */
export async function startPolishAction(
  input: z.input<typeof PolishSchema>,
): Promise<{ runId?: string; error?: string }> {
  const parsed = PolishSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  const db = await getDb();
  const profile = await getActiveProfile(db);
  if (!profile) return { error: 'No active profile.' };
  if (!profile.isDemo && !profile.settings.claude.approvedForClient) {
    return { error: 'Claude Code is not approved for this client.' };
  }
  const preset = profile.settings.claude.presets['short-text'];
  const runId = await createRun(db, {
    profileId: profile.id,
    preset: 'short-text',
    prompt: polishPrompt(parsed.data.text, parsed.data.style, parsed.data.format),
    modelRequested: preset.model,
  });
  return { runId };
}

export interface PolishStatus {
  done: boolean;
  text?: string;
  error?: string;
}

/** Poll a polish run; when it succeeds, return the rewritten text. */
export async function pollPolishAction(runId: string): Promise<PolishStatus> {
  const db = await getDb();
  const profile = await getActiveProfile(db);
  const run = await getRun(db, runId);
  if (!run || run.profileId !== profile?.id) return { done: true, error: 'Run not found.' };
  if (run.status === 'queued' || run.status === 'running') return { done: false };
  if (run.status !== 'succeeded') {
    return { done: true, error: run.error ?? `The polish run ${run.status}.` };
  }
  const events = await listRunEvents(db, runId);
  const result = events.map((e) => e.event).find((e) => e.type === 'result');
  const text = result?.type === 'result' ? result.resultText : null;
  if (!text?.trim()) return { done: true, error: 'Claude returned no text.' };
  return { done: true, text: cleanPolishResult(text) };
}
