'use server';

import { parseProfileSettings, type ProfileSettings } from '@tab-enter/core';
import {
  addSecretName,
  createProfile,
  deleteProfileRows,
  enqueueJob,
  ensureDemoProfile,
  getActiveProfile,
  getDb,
  getProfile,
  hasPendingJob,
  listProfiles,
  setActiveProfile,
  updateProfile,
} from '@tab-enter/db';
import { SECRET_NAMES } from '@tab-enter/secrets';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getSecretStore } from '@/lib/secrets';

// Server actions. Everything here only writes SQLite or the secret store;
// anything touching the network, git, or files is queued for the worker.

export interface ActionResult {
  ok?: string;
  error?: string;
}

async function requireProfile(profileId: string) {
  const profile = await getProfile(await getDb(), profileId);
  if (!profile) throw new Error('Profile not found.');
  return profile;
}

export async function switchProfile(profileId: string): Promise<void> {
  await requireProfile(profileId);
  await setActiveProfile(await getDb(), profileId);
  revalidatePath('/', 'layout');
}

export async function requestSync(): Promise<void> {
  const db = await getDb();
  const profile = await getActiveProfile(db);
  if (profile && !(await hasPendingJob(db, 'sync', profile.id))) {
    await enqueueJob(db, { type: 'sync', profileId: profile.id });
  }
  revalidatePath('/', 'layout');
}

export async function requestToolDetection(): Promise<void> {
  const db = await getDb();
  if (!(await hasPendingJob(db, 'detect-tools'))) await enqueueJob(db, { type: 'detect-tools' });
  revalidatePath('/settings');
}

const ProfileNameSchema = z.string().trim().min(1, 'Give the profile a name.').max(60);

export async function createProfileAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const name = ProfileNameSchema.safeParse(formData.get('name'));
  if (!name.success) return { error: name.error.issues[0]?.message };
  const db = await getDb();
  const id = await createProfile(db, { name: name.data });
  await setActiveProfile(db, id);
  revalidatePath('/', 'layout');
  return { ok: `Created “${name.data}”.` };
}

/** Wipes the profile's rows and keychain entries now, and its files via the worker. */
export async function deleteProfileAction(profileId: string): Promise<ActionResult> {
  const db = await getDb();
  if ((await listProfiles(db)).length <= 1) return { error: 'Keep at least one profile.' };
  await requireProfile(profileId);

  const secretNames = await deleteProfileRows(db, profileId);
  if (secretNames.length > 0) {
    const store = await getSecretStore();
    for (const name of secretNames) await store.delete(profileId, name);
  }
  await enqueueJob(db, { type: 'delete-profile-files', profileId });
  await ensureDemoProfile(db);
  const [first] = await listProfiles(db);
  if (first) await setActiveProfile(db, first.id);
  revalidatePath('/', 'layout');
  return { ok: 'Profile deleted.' };
}

const httpUrl = z
  .string()
  .trim()
  .refine((v) => v === '' || /^https?:\/\/[^\s]+$/i.test(v), 'Enter an http(s) URL.')
  .transform((v) => v.replace(/\/+$/, ''));

const ConnectionsSchema = z.object({
  profileId: z.string(),
  name: ProfileNameSchema,
  jiraDeployment: z.enum(['cloud', 'datacenter']),
  jiraBaseUrl: httpUrl,
  jiraEmail: z.string().trim(),
  jiraToken: z.string(),
  gitlabBaseUrl: httpUrl,
  gitlabToken: z.string(),
});

export async function saveConnectionsAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = ConnectionsSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  const input = parsed.data;
  const profile = await requireProfile(input.profileId);
  if (profile.isDemo) return { error: 'The demo profile has no connections.' };

  const settings: ProfileSettings = parseProfileSettings({
    ...profile.settings,
    jira: {
      ...profile.settings.jira,
      deployment: input.jiraDeployment,
      baseUrl: input.jiraBaseUrl,
      email: input.jiraEmail,
    },
    gitlab: { ...profile.settings.gitlab, baseUrl: input.gitlabBaseUrl || 'https://gitlab.com' },
  });
  const db = await getDb();
  await updateProfile(db, profile.id, { name: input.name, settings });

  // Blank token fields mean "keep the stored one".
  const tokens: [string, string][] = [
    [SECRET_NAMES.jiraToken, input.jiraToken.trim()],
    [SECRET_NAMES.gitlabToken, input.gitlabToken.trim()],
  ];
  try {
    const store = tokens.some(([, v]) => v) ? await getSecretStore() : null;
    for (const [name, value] of tokens) {
      if (!value || !store) continue;
      await store.set(profile.id, name, value);
      await addSecretName(db, profile.id, name);
    }
  } catch (err) {
    return {
      error: `Settings saved, but the token could not be stored: ${err instanceof Error ? err.message : err}`,
    };
  }
  revalidatePath('/', 'layout');
  return { ok: 'Saved.' };
}

const ClaudeSettingsSchema = z.object({
  profileId: z.string(),
  approvedForClient: z.literal('on').optional(),
  maxParallelRuns: z.coerce.number().int().min(1).max(8),
  rtkMode: z.enum(['off', 'global', 'per-run']),
});

export async function saveClaudeSettingsAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = ClaudeSettingsSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  const input = parsed.data;
  const profile = await requireProfile(input.profileId);
  const settings = parseProfileSettings({
    ...profile.settings,
    claude: {
      ...profile.settings.claude,
      approvedForClient: input.approvedForClient === 'on',
      maxParallelRuns: input.maxParallelRuns,
    },
    rtk: { ...profile.settings.rtk, mode: input.rtkMode },
  });
  await updateProfile(await getDb(), profile.id, { settings });
  revalidatePath('/', 'layout');
  return { ok: 'Saved.' };
}
