import { fileURLToPath } from 'node:url';
import { fakeFetch, loadContractFixture } from '@tab-enter/connectors/test-support';
import { parseProfileSettings } from '@tab-enter/core';
import {
  updateProfile,
  type Db,
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
import { MemorySecretStore, PatCredentialProvider, SECRET_NAMES } from '@tab-enter/secrets';
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
    // Completed 6 days ago: past the 3-day display retention but inside the 7-day
    // sync horizon that daily reports need (completedSyncDays).
    expect(issues.map((i) => i.key)).toContain('SHOP-096');
    // A teammate's ticket linked from an MR I review: synced, but not mine.
    expect(issues.find((i) => i.key === 'SHOP-120')).toMatchObject({ assignedToMe: false });

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
});

/* eslint-disable @typescript-eslint/no-explicit-any */
describe('live sync', () => {
  const jira = loadContractFixture<any>('jira-cloud.json');
  const gl = loadContractFixture<any>('gitlab.json');
  const now = new Date('2026-06-01T12:00:00.000Z');

  async function liveProfile(db: Db) {
    const id = await createProfile(db, { name: 'Client' });
    const settings = parseProfileSettings({
      jira: { baseUrl: 'https://shop.example.com', email: 'dev@example.com' },
      gitlab: {
        baseUrl: 'https://gitlab.example.com',
        projects: [{ id: '42', path: 'acme/shop' }],
      },
    });
    await updateProfile(db, id, { settings });
    const store = new MemorySecretStore();
    await store.set(id, SECRET_NAMES.jiraToken, 'jira-secret');
    await store.set(id, SECRET_NAMES.gitlabToken, 'gitlab-secret');
    const credentials = new PatCredentialProvider(store, async () => settings);
    return { id, credentials };
  }

  function server({ jiraStatus = 200 } = {}) {
    const mrs: any[] = [...gl.createdOpenPages[0], ...gl.createdMerged, ...gl.reviewOpen];
    return fakeFetch(({ url, body }) => {
      const q = url.searchParams;
      if (url.host === 'shop.example.com') {
        if (jiraStatus !== 200) return { status: jiraStatus, body: {} };
        // Teammates' tickets linked from MRs I review: SHOP-120 is readable, others aren't.
        const single = /\/rest\/api\/3\/issue\/([A-Z]+-\d+)$/.exec(url.pathname);
        if (single) {
          return single[1] === 'SHOP-120'
            ? {
                body: {
                  key: 'SHOP-120',
                  fields: {
                    summary: 'Coupon codes',
                    status: { name: 'In Review', statusCategory: { key: 'indeterminate' } },
                    issuetype: { name: 'Story' },
                    updated: '2026-05-31T09:30:00.000+0000',
                  },
                },
              }
            : { status: 404, body: { errorMessages: ['Issue does not exist'] } };
        }
        const jql = (body as { jql: string }).jql;
        if (jql.includes('openSprints()')) return { body: jira.sprint };
        if (jql.includes('statusCategory = Done')) return { body: jira.done };
        return { body: { issues: jira.activePages.flatMap((p: any) => p.issues), isLast: true } };
      }
      const p = url.pathname.replace('/api/v4', '');
      if (p === '/user') return { body: gl.user };
      if (p === '/merge_requests') {
        if (q.get('scope') === 'created_by_me') {
          return { body: q.get('state') === 'opened' ? gl.createdOpenPages[0] : gl.createdMerged };
        }
        return { body: q.get('state') === 'opened' ? gl.reviewOpen : [] };
      }
      const m = /^\/projects\/42\/merge_requests\/(\d+)(\/\w+)?$/.exec(p);
      const key = `42!${m?.[1]}`;
      const base = mrs.find((mr) => `42!${mr.iid}` === key);
      if (!m || !base) return undefined;
      if (!m[2]) return { body: { ...base, ...gl.single[key] } };
      if (m[2] === '/approvals') return { body: gl.approvals[key] ?? {} };
      if (m[2] === '/discussions') return { body: gl.discussions[key] ?? [] };
      return { body: gl.diffs[key] ?? [] };
    });
  }

  it('syncs Jira and GitLab into SQLite and links them', async () => {
    const db = await createTestDb();
    const { id, credentials } = await liveProfile(db);
    const { fetch, seen } = server();

    await syncProfile(db, id, { fixturesDir, credentials, fetch, now });

    const issues = await listIssues(db, id);
    expect(issues.map((i) => i.key).sort()).toEqual([
      'SHOP-099',
      'SHOP-101',
      'SHOP-112',
      'SHOP-118',
      'SHOP-120', // linked from MR !21 I review; SHOP-121 (!22) isn't readable and is skipped
    ]);
    expect(issues.find((i) => i.key === 'SHOP-118')).toMatchObject({ inOpenSprint: false });
    expect(issues.find((i) => i.key === 'SHOP-120')).toMatchObject({ assignedToMe: false });

    const mrs = await listMergeRequests(db, id);
    expect(mrs.map((m) => [m.mr.ref.iid, m.isMine, m.needsMyReview]).sort()).toEqual([
      [11, true, false],
      [12, true, false],
      [21, false, true],
      [22, false, false],
    ]);
    expect(await listLinks(db, id)).toContainEqual({
      mrKey: '42!12',
      issueKey: 'SHOP-101',
      source: 'branch',
    });

    const states = await getSyncStates(db, id);
    expect(states.every((s) => s.lastError === null && s.lastSyncedAt)).toBe(true);

    // Tokens only ever travel in headers, to their own service.
    const jiraAuth = `Basic ${Buffer.from('dev@example.com:jira-secret').toString('base64')}`;
    expect(
      seen
        .filter((r) => r.url.host === 'shop.example.com')
        .every((r) => r.headers.Authorization === jiraAuth),
    ).toBe(true);
    expect(
      seen
        .filter((r) => r.url.host === 'gitlab.example.com')
        .every((r) => r.headers['PRIVATE-TOKEN'] === 'gitlab-secret'),
    ).toBe(true);
    expect(seen.some((r) => r.url.toString().includes('secret'))).toBe(false);
  });

  it('keeps the last good Jira data when only Jira fails', async () => {
    const db = await createTestDb();
    const { id, credentials } = await liveProfile(db);
    await syncProfile(db, id, { fixturesDir, credentials, fetch: server().fetch, now });

    await syncProfile(db, id, {
      fixturesDir,
      credentials,
      fetch: server({ jiraStatus: 401 }).fetch,
      now,
    });

    expect((await listIssues(db, id)).length).toBe(5); // 4 mine + SHOP-120 from a review
    expect((await listMergeRequests(db, id)).length).toBe(4);
    const states = await getSyncStates(db, id);
    expect(states.find((s) => s.source === 'jira')?.lastError).toMatch(/renew it in Settings/);
    expect(states.find((s) => s.source === 'gitlab')?.lastError).toBeNull();
  });

  it('records a clear error when no token is stored', async () => {
    const db = await createTestDb();
    const { id } = await liveProfile(db);
    const credentials = new PatCredentialProvider(new MemorySecretStore(), async () =>
      parseProfileSettings({}),
    );
    await expect(
      syncProfile(db, id, { fixturesDir, credentials, fetch: server().fetch, now }),
    ).rejects.toThrow(/No Jira token/);
    const states = await getSyncStates(db, id);
    expect(states.find((s) => s.source === 'gitlab')?.lastError).toMatch(/No GitLab token/);
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
