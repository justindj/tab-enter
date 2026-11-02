import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DemoCodeHost,
  DemoIssueTracker,
  type DemoGitLabFixture,
  type DemoJiraFixture,
} from './demo';
import { ConnectorError } from './types';

const load = <T>(name: string): T =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`../../../fixtures/demo/${name}`, import.meta.url)), 'utf8'),
  ) as T;

const now = new Date('2026-06-01T12:00:00.000Z');
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);

describe('DemoIssueTracker', () => {
  const jira = new DemoIssueTracker(load<DemoJiraFixture>('jira.json'), now);

  it('shifts fixture timestamps so the anchor is now', async () => {
    const done = await jira.listMyRecentlyCompleted(daysAgo(3));
    expect(done.map((i) => i.key)).toEqual(['SHOP-099']);
    expect(done[0]?.completedAt).toBe('2026-05-31T10:00:00.000Z');
  });

  it('filters active issues by sprint', async () => {
    const sprint = await jira.listMyActiveIssues({ sprintOnly: true });
    const all = await jira.listMyActiveIssues({ sprintOnly: false });
    expect(sprint.map((i) => i.key)).not.toContain('SHOP-118');
    expect(all.map((i) => i.key)).toContain('SHOP-118');
    expect(all.every((i) => i.statusCategory !== 'done')).toBe(true);
    expect(all[0]).not.toHaveProperty('description');
  });

  it('ranks unstarted sprint issues by rank', async () => {
    expect((await jira.rankNextCandidates()).map((i) => i.key)).toEqual(['SHOP-112', 'SHOP-115']);
  });

  it('returns details and a typed not-found error', async () => {
    expect((await jira.getIssue('SHOP-101')).acceptanceCriteria).toHaveLength(3);
    await expect(jira.getIssue('NOPE-1')).rejects.toBeInstanceOf(ConnectorError);
  });
});

describe('DemoCodeHost', () => {
  const gitlab = new DemoCodeHost(load<DemoGitLabFixture>('gitlab.json'), now);

  it('lists my open and recently merged MRs', async () => {
    expect((await gitlab.listMyOpenMRs()).map((m) => m.ref.iid)).toEqual([12, 14, 15, 16, 17]);
    expect((await gitlab.listMyRecentlyMergedMRs(daysAgo(3))).map((m) => m.ref.iid)).toEqual([11]);
  });

  it('lists review requests, hiding ones I already approved by default', async () => {
    expect(
      (await gitlab.listReviewRequests({ includeCompleted: false })).map((m) => m.ref.iid),
    ).toEqual([21, 22]);
    expect(
      (await gitlab.listReviewRequests({ includeCompleted: true })).map((m) => m.ref.iid),
    ).toEqual([21, 22, 19]);
  });

  it('returns MR detail with discussions but without the demo role', async () => {
    const detail = await gitlab.getMRDetail({ projectId: '42', iid: 12 });
    expect(detail.discussions).toHaveLength(2);
    expect(detail).not.toHaveProperty('role');
  });
});
