import { fileURLToPath } from 'node:url';
import {
  createProfile,
  enqueueJob,
  ensureDemoProfile,
  getActiveProfile,
  getSyncStates,
  hasPendingJob,
  listIssues,
  listLinks,
  listMergeRequests,
} from '@tab-enter/db';
import { createTestDb } from '@tab-enter/db/test-support';
import { describe, expect, it } from 'vitest';
import { syncProfile } from './handlers/sync';
import { processNextJob, scheduleDueSyncs } from './worker';

const fixturesDir = fileURLToPath(new URL('../../../fixtures', import.meta.url));
const deps = { fixturesDir, log: () => {} };

describe('demo sync', () => {
  it('loads fixtures, links MRs to tickets and records sync state', async () => {
    const db = await createTestDb();
    await ensureDemoProfile(db);
    const profile = (await getActiveProfile(db))!;

    await syncProfile(db, profile.id, { fixturesDir });

    const issues = await listIssues(db, profile.id);
    expect(issues.map((i) => i.key)).toContain('SHOP-101');
    expect(issues.map((i) => i.key)).toContain('SHOP-099'); // recently completed
    expect(issues.map((i) => i.key)).not.toContain('SHOP-096'); // outside retention

    const mrs = await listMergeRequests(db, profile.id);
    expect(
      mrs
        .filter((m) => m.isMine)
        .map((m) => m.mr.ref.iid)
        .sort(),
    ).toEqual([11, 12, 14, 15, 16, 17]);
    expect(
      mrs
        .filter((m) => m.isReviewer)
        .map((m) => m.mr.ref.iid)
        .sort(),
    ).toEqual([19, 21, 22]);
    expect(
      mrs
        .filter((m) => m.needsMyReview)
        .map((m) => m.mr.ref.iid)
        .sort(),
    ).toEqual([21, 22]);

    const links = await listLinks(db, profile.id);
    expect(links).toContainEqual({ mrKey: '42!12', issueKey: 'SHOP-101', source: 'branch' });
    expect(links).toContainEqual({ mrKey: '42!14', issueKey: 'SHOP-104', source: 'title' });
    expect(links).toContainEqual({ mrKey: '42!16', issueKey: 'SHOP-110', source: 'branch' });
    expect(links.filter((l) => l.mrKey === '42!17')).toEqual([]); // unlinked MR

    const states = await getSyncStates(db, profile.id);
    expect(states.every((s) => s.lastError === null && s.lastSyncedAt)).toBe(true);
  });

  it('records a clear error for non-demo profiles until live connectors exist', async () => {
    const db = await createTestDb();
    const id = await createProfile(db, { name: 'Client' });
    await expect(syncProfile(db, id, { fixturesDir })).rejects.toThrow(/M1/);
    const [state] = await getSyncStates(db, id);
    expect(state?.lastError).toMatch(/M1/);
  });
});

describe('worker loop', () => {
  it('processes queued jobs and marks failures without throwing', async () => {
    const db = await createTestDb();
    const id = await createProfile(db, { name: 'Client' });
    await enqueueJob(db, { type: 'sync', profileId: id });
    expect(await processNextJob(db, deps)).toBe(true);
    expect(await processNextJob(db, deps)).toBe(false);
    expect(await hasPendingJob(db, 'sync', id)).toBe(false);
  });

  it('schedules a sync per profile only when due and not already queued', async () => {
    const db = await createTestDb();
    await ensureDemoProfile(db);
    const profile = (await getActiveProfile(db))!;
    await scheduleDueSyncs(db);
    await scheduleDueSyncs(db);
    expect(await hasPendingJob(db, 'sync', profile.id)).toBe(true);
    await processNextJob(db, deps);
    await scheduleDueSyncs(db);
    expect(await hasPendingJob(db, 'sync', profile.id)).toBe(false);
  });
});
