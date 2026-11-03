'use server';

import { parseProfileSettings } from '@tab-enter/core';
import {
  createProfile,
  dismissSetup,
  enqueueJob,
  getActiveProfile,
  getDb,
  hasPendingJob,
  listProfiles,
  setActiveProfile,
  updateProfile,
} from '@tab-enter/db';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { deleteProfileAction, type ActionResult } from '@/app/actions';

// First-run setup: a guided path through the same settings as the Settings
// page. Connections are saved and tested by Settings' own form and actions.

const NameSchema = z.string().trim().min(1, 'Give the profile a name.').max(60);

export async function startSetupAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const name = NameSchema.safeParse(formData.get('name'));
  if (!name.success) return { error: name.error.issues[0]?.message ?? 'Enter a name.' };
  const db = await getDb();
  const id = await createProfile(db, { name: name.data });
  await setActiveProfile(db, id);
  revalidatePath('/', 'layout');
  redirect('/setup?step=connect');
}

export async function setupClaudeAction(formData: FormData): Promise<void> {
  const db = await getDb();
  const profile = await getActiveProfile(db);
  if (!profile || profile.isDemo) redirect('/setup');
  const settings = parseProfileSettings({
    ...profile.settings,
    claude: { ...profile.settings.claude, approvedForClient: formData.get('approved') === 'on' },
  });
  await updateProfile(db, profile.id, { settings });
  revalidatePath('/', 'layout');
  redirect('/setup?step=done');
}

/** Finish: optionally remove the demo profile, sync the new one, open Now. */
export async function finishSetupAction(formData: FormData): Promise<void> {
  const db = await getDb();
  const profile = await getActiveProfile(db);
  if (!profile || profile.isDemo) redirect('/setup');
  if (formData.get('removeDemo') === 'on') {
    for (const demo of (await listProfiles(db)).filter((p) => p.isDemo)) {
      await deleteProfileAction(demo.id);
    }
    await setActiveProfile(db, profile.id);
  }
  await dismissSetup(db);
  if (!(await hasPendingJob(db, 'sync', profile.id))) {
    await enqueueJob(db, { type: 'sync', profileId: profile.id });
  }
  revalidatePath('/', 'layout');
  redirect('/');
}

/** "Explore the demo first": stop sending first-run visits to setup. */
export async function skipSetupAction(): Promise<void> {
  await dismissSetup(await getDb());
  revalidatePath('/', 'layout');
  redirect('/');
}
