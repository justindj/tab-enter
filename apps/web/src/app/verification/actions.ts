'use server';

import { parseProfileSettings } from '@tab-enter/core';
import {
  addSecretName,
  createVerification,
  enqueueJob,
  getActiveProfile,
  getDb,
  getProfile,
  listVerifications,
  updateProfile,
} from '@tab-enter/db';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { ActionResult } from '@/app/actions';
import { getSecretStore } from '@/lib/secrets';

const StartSchema = z.object({
  issueKey: z.string().min(1),
  mode: z.enum(['auto', 'ui', 'backend']),
  rerun: z.boolean(),
});

/** Queue a verification job for a ticket of the active profile. */
export async function startVerificationAction(
  input: z.input<typeof StartSchema>,
): Promise<ActionResult> {
  const parsed = StartSchema.safeParse(input);
  if (!parsed.success) return { error: 'Invalid request.' };
  const db = await getDb();
  const profile = await getActiveProfile(db);
  if (!profile) return { error: 'No active profile.' };
  const running = (await listVerifications(db, profile.id, parsed.data.issueKey)).some(
    (v) => v.status === 'running',
  );
  if (running) return { error: 'A verification of this ticket is already running.' };
  const artifactId = await createVerification(db, {
    profileId: profile.id,
    issueKey: parsed.data.issueKey,
    mrKey: null,
  });
  await enqueueJob(db, {
    type: 'verify',
    profileId: profile.id,
    artifactId,
    mode: parsed.data.mode,
    rerun: parsed.data.rerun,
  });
  revalidatePath('/verification');
  return { ok: 'Verification started.' };
}

const httpUrl = z
  .string()
  .trim()
  .refine(
    (v) => v === '' || /^https?:\/\/[^\s]+$/i.test(v),
    'Test URLs start with http:// or https://.',
  )
  .transform((v) => v.replace(/\/+$/, ''));

const ProjectSchema = z.object({
  baseUrl: httpUrl,
  startCommand: z.string().trim().max(500),
  username: z.string().trim().max(200),
  password: z.string().max(500),
});

/**
 * Per-project verification settings. Test credentials go to the keychain as
 * one JSON entry per project; blank fields keep what's stored.
 */
export async function saveVerificationSettingsAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const profileId = String(formData.get('profileId') ?? '');
  const db = await getDb();
  const profile = await getProfile(db, profileId);
  if (!profile) return { error: 'Profile not found.' };
  if (profile.isDemo) return { error: 'The demo profile has no projects to configure.' };

  const projects = [...profile.settings.gitlab.projects];
  const store = await getSecretStore().catch(() => null);
  for (const [i, project] of projects.entries()) {
    const parsed = ProjectSchema.safeParse({
      baseUrl: formData.get(`p${i}.baseUrl`) ?? '',
      startCommand: formData.get(`p${i}.startCommand`) ?? '',
      username: formData.get(`p${i}.username`) ?? '',
      password: formData.get(`p${i}.password`) ?? '',
    });
    if (!parsed.success)
      return { error: `${project.path || project.id}: ${parsed.error.issues[0]?.message}` };
    const v = parsed.data;
    let secretName = project.verification.testCredentialsSecret;
    if (v.username || v.password) {
      if (!v.username || !v.password) {
        return {
          error: `${project.path || project.id}: enter both the test username and password.`,
        };
      }
      if (!store) return { error: 'No keychain is available to store test credentials.' };
      secretName = `test-credentials:${project.id}`.replace(/[^A-Za-z0-9:._-]/g, '-');
      await store.set(
        profile.id,
        secretName,
        JSON.stringify({ username: v.username, password: v.password }),
      );
      await addSecretName(db, profile.id, secretName);
    }
    projects[i] = {
      ...project,
      verification: {
        ...project.verification,
        baseUrl: v.baseUrl || undefined,
        startCommand: v.startCommand || undefined,
        testCredentialsSecret: secretName,
      },
    };
  }
  const settings = parseProfileSettings({
    ...profile.settings,
    gitlab: { ...profile.settings.gitlab, projects },
    verification: { captureVideo: formData.get('captureVideo') === 'on' },
  });
  await updateProfile(db, profile.id, { settings });
  revalidatePath('/', 'layout');
  return { ok: 'Saved.' };
}
