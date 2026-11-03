'use server';

import { PresetIdSchema, type AgentEvent } from '@tab-enter/core';
import {
  createRun,
  enqueueJob,
  getActiveProfile,
  getDb,
  getJob,
  getRun,
  listRunEvents,
  requestRunCancel,
  type RunRow,
} from '@tab-enter/db';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import type { ActionResult } from '@/app/actions';

// Claude Code runs. These only write SQLite (a run row plus a job); the worker
// does the git, terminal and Claude Code work.

const MAX_PROMPT_CHARS = 100_000;

async function activeProfile() {
  const db = await getDb();
  const profile = await getActiveProfile(db);
  if (!profile) throw new Error('No active profile.');
  return { db, profile };
}

/** A run of the active profile, so one profile can never touch another's runs. */
async function ownRun(
  runId: string,
): Promise<{ db: Awaited<ReturnType<typeof getDb>>; run: RunRow }> {
  const { db, profile } = await activeProfile();
  const run = await getRun(db, runId);
  if (!run || run.profileId !== profile.id) throw new Error('Run not found.');
  return { db, run };
}

const StartSchema = z.object({
  preset: PresetIdSchema,
  prompt: z.string().trim().min(1, 'The prompt is empty.').max(MAX_PROMPT_CHARS),
  issueKey: z.string().nullable(),
  mrKey: z.string().nullable(),
  projectId: z.string().nullable(),
});

export async function startRunAction(input: z.input<typeof StartSchema>): Promise<ActionResult> {
  const parsed = StartSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid run.' };
  const { db, profile } = await activeProfile();
  if (!profile.isDemo && !profile.settings.claude.approvedForClient) {
    return { error: 'Claude Code is not approved for this client. Copy the prompt instead.' };
  }
  const preset = profile.settings.claude.presets[parsed.data.preset];
  const runId = await createRun(db, {
    profileId: profile.id,
    ...parsed.data,
    modelRequested: preset.model,
  });
  revalidatePath('/');
  redirect(`/runs/${runId}`);
}

export async function continueRunAction(runId: string, prompt: string): Promise<ActionResult> {
  const { db, run } = await ownRun(runId);
  const text = prompt.trim();
  if (!text) return { error: 'Write what Claude should do next.' };
  if (text.length > MAX_PROMPT_CHARS) return { error: 'That prompt is too long.' };
  if (!run.sessionId) return { error: 'This run has no session to continue.' };
  if (run.status === 'queued' || run.status === 'running') {
    return { error: 'Wait for this run to finish (or cancel it) before continuing.' };
  }
  const childId = await createRun(db, {
    profileId: run.profileId,
    preset: run.preset,
    prompt: text,
    modelRequested: run.modelRequested,
    parentRunId: run.id,
  });
  redirect(`/runs/${childId}`);
}

export async function cancelRunAction(runId: string): Promise<ActionResult> {
  const { db } = await ownRun(runId);
  await requestRunCancel(db, runId);
  revalidatePath(`/runs/${runId}`);
  return { ok: 'Cancelling…' };
}

const TargetSchema = z.object({
  issueKey: z.string().nullable(),
  mrKey: z.string().nullable(),
  projectId: z.string().nullable(),
});

/**
 * Ask the worker to open Claude Code in the user's terminal, and wait briefly
 * for the outcome so errors (no clone path, demo profile…) show inline.
 */
export async function openTerminalAction(
  input: { runId: string } | { target: z.input<typeof TargetSchema> },
): Promise<ActionResult> {
  const { db, profile } = await activeProfile();
  let jobId: string;
  if ('runId' in input) {
    await ownRun(input.runId);
    jobId = await enqueueJob(db, {
      type: 'open-terminal',
      profileId: profile.id,
      runId: input.runId,
    });
  } else {
    const target = TargetSchema.parse(input.target);
    jobId = await enqueueJob(db, { type: 'open-terminal', profileId: profile.id, target });
  }
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const job = await getJob(db, jobId);
    if (job?.status === 'done') return { ok: 'Opened Claude Code in a terminal.' };
    if (job?.status === 'failed') return { error: job.error ?? 'Could not open a terminal.' };
    await new Promise((r) => setTimeout(r, 250));
  }
  return { ok: 'Queued. A terminal will open when the worker gets to it.' };
}

export interface RunUpdate {
  run: Pick<
    RunRow,
    | 'id'
    | 'status'
    | 'sessionId'
    | 'modelUsed'
    | 'error'
    | 'cwd'
    | 'branch'
    | 'inputTokens'
    | 'outputTokens'
    | 'cacheReadTokens'
    | 'costUsd'
    | 'numTurns'
    | 'cancelRequested'
    | 'diffSummary'
  > & { startedAt: string | null; endedAt: string | null };
  events: { seq: number; event: AgentEvent }[];
}

/** New events since `afterSeq` plus the run's current state, for the live log. */
export async function getRunUpdate(runId: string, afterSeq: number): Promise<RunUpdate> {
  const { db, run } = await ownRun(runId);
  const events = await listRunEvents(db, runId, afterSeq);
  return {
    run: {
      id: run.id,
      status: run.status,
      sessionId: run.sessionId,
      modelUsed: run.modelUsed,
      error: run.error,
      cwd: run.cwd,
      branch: run.branch,
      inputTokens: run.inputTokens,
      outputTokens: run.outputTokens,
      cacheReadTokens: run.cacheReadTokens,
      costUsd: run.costUsd,
      numTurns: run.numTurns,
      cancelRequested: run.cancelRequested,
      diffSummary: run.diffSummary,
      startedAt: run.startedAt?.toISOString() ?? null,
      endedAt: run.endedAt?.toISOString() ?? null,
    },
    events: events.map(({ seq, event }) => ({ seq, event })),
  };
}
