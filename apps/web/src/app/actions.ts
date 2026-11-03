'use server';

import { createGitLabHost, createJiraTracker } from '@tab-enter/connectors';
import {
  isIssueKey,
  parseProfileSettings,
  parseWatchedProjects,
  redactSecrets,
  type ProfileSettings,
} from '@tab-enter/core';
import {
  addSecretName,
  changeManualLink,
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
import { PatCredentialProvider, SECRET_NAMES } from '@tab-enter/secrets';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getSecretStore } from '@/lib/secrets';

// Server actions. Everything here only writes SQLite or the secret store;
// anything touching git, Claude Code or files is queued for the worker. The one
// network call is Test connection, which needs an immediate answer (see
// docs/decisions.md).

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
  jiraBoardId: z
    .string()
    .trim()
    .refine((v) => v === '' || /^\d+$/.test(v), 'The board id is a number (from the board URL).'),
  jiraDoneStatuses: z.string(),
  gitlabBaseUrl: httpUrl,
  gitlabToken: z.string(),
  gitlabProjects: z.string(),
});

const csv = (text: string) =>
  text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export async function saveConnectionsAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = ConnectionsSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  const input = parsed.data;
  const profile = await requireProfile(input.profileId);
  if (profile.isDemo) return { error: 'The demo profile has no connections.' };

  let projects;
  try {
    projects = parseWatchedProjects(input.gitlabProjects);
  } catch {
    return { error: 'Watched projects: one GitLab path or id per line.' };
  }
  const settings: ProfileSettings = parseProfileSettings({
    ...profile.settings,
    jira: {
      ...profile.settings.jira,
      deployment: input.jiraDeployment,
      baseUrl: input.jiraBaseUrl,
      email: input.jiraEmail,
      boardId: input.jiraBoardId || undefined,
      doneStatuses: csv(input.jiraDoneStatuses),
    },
    gitlab: {
      ...profile.settings.gitlab,
      baseUrl: input.gitlabBaseUrl || 'https://gitlab.com',
      projects,
    },
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
  if (!(await hasPendingJob(db, 'sync', profile.id))) {
    await enqueueJob(db, { type: 'sync', profileId: profile.id });
  }
  revalidatePath('/', 'layout');
  return { ok: 'Saved. Syncing now.' };
}

/**
 * Manually link or unlink one of my MRs and a ticket on the active profile.
 * Overrides the branch/title/description rules and survives later syncs.
 */
export async function setMRLinkAction(
  mrKey: string,
  issueKey: string,
  linked: boolean,
): Promise<ActionResult> {
  const db = await getDb();
  const profile = await getActiveProfile(db);
  if (!profile) return { error: 'No active profile.' };
  const key = issueKey.trim().toUpperCase();
  const { keyRegex } = profile.settings;
  if (!isIssueKey(key, keyRegex)) {
    return { error: `“${issueKey}” doesn’t look like a ticket key (pattern ${keyRegex}).` };
  }
  const found = await changeManualLink(db, profile.id, { mrKey, issueKey: key, linked }, keyRegex);
  if (!found) return { error: 'That merge request is no longer in the synced data. Refresh.' };
  revalidatePath('/', 'layout');
  return { ok: linked ? `Linked to ${key}.` : `Unlinked from ${key}.` };
}

export interface ConnectionTestResult {
  jira: ActionResult;
  gitlab: ActionResult;
}

/**
 * Calls each service's "who am I" endpoint with the saved settings and token.
 * Tokens are read server-side and only the outcome is returned to the browser.
 */
export async function testConnectionsAction(profileId: string): Promise<ConnectionTestResult> {
  const profile = await requireProfile(profileId);
  if (profile.isDemo) {
    const demo = { error: 'The demo profile has no connections.' };
    return { jira: demo, gitlab: demo };
  }
  const credentials = new PatCredentialProvider(
    await getSecretStore(),
    async () => profile.settings,
  );
  const opts = { profileId, settings: profile.settings, credentials };

  const describe = async (who: () => Promise<{ displayName: string; username?: string }>) => {
    try {
      const user = await who();
      const name = user.username ? `${user.displayName} (${user.username})` : user.displayName;
      return { ok: `Connected as ${name}.` };
    } catch (err) {
      return { error: redactSecrets(err instanceof Error ? err.message : String(err)) };
    }
  };
  const [jira, gitlab] = await Promise.all([
    describe(() => createJiraTracker(opts).getCurrentUser()),
    describe(() => createGitLabHost(opts).getCurrentUser()),
  ]);
  return { jira, gitlab };
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
