import { describe, expect, it } from 'vitest';
import { JiraIssueTracker, jqlString } from './jira';
import { fakeFetch, loadContractFixture, type FakeReply } from './test-support';
import { ConnectorError } from './types';

/* eslint-disable @typescript-eslint/no-explicit-any */
const cloud = loadContractFixture<any>('jira-cloud.json');
const dc = loadContractFixture<any>('jira-datacenter.json');

const now = new Date('2026-06-01T12:00:00.000Z');
const headers = async () => ({ Authorization: 'Basic test' });
const jqlOf = (body: unknown) => (body as { jql: string }).jql;

function cloudServer() {
  return fakeFetch(({ method, url, body }): FakeReply | undefined => {
    if (url.pathname === '/rest/api/3/myself') return { body: cloud.myself };
    if (method === 'POST' && url.pathname === '/rest/api/3/search/jql') {
      const jql = jqlOf(body);
      if (jql.includes('openSprints()')) return { body: cloud.sprint };
      if (jql.includes('statusCategory = Done')) return { body: cloud.done };
      const token = (body as { nextPageToken?: string }).nextPageToken;
      return { body: cloud.activePages[token === 'page-2-token' ? 1 : 0] };
    }
    return undefined;
  });
}

describe('JiraIssueTracker (Cloud)', () => {
  it('reads the current user from /rest/api/3/myself', async () => {
    const { fetch, seen } = cloudServer();
    const jira = new JiraIssueTracker({
      deployment: 'cloud',
      baseUrl: 'https://shop.example.com/',
      getHeaders: headers,
      fetch,
    });
    expect(await jira.getCurrentUser()).toEqual({
      id: '5b10ac8d82e05b22cc7d4ef5',
      displayName: 'Dana Developer',
      username: 'dev@example.com',
    });
    expect(seen[0]!.headers.Authorization).toBe('Basic test');
    expect(seen[0]!.url.toString()).toBe('https://shop.example.com/rest/api/3/myself');
  });

  it('pages through search/jql with nextPageToken and marks sprint membership', async () => {
    const { fetch, seen } = cloudServer();
    const jira = new JiraIssueTracker({
      deployment: 'cloud',
      baseUrl: 'https://shop.example.com',
      getHeaders: headers,
      fetch,
      now: () => now,
    });
    const all = await jira.listMyActiveIssues({ sprintOnly: false });
    expect(all.map((i) => [i.key, i.inOpenSprint, i.rank])).toEqual([
      ['SHOP-101', true, '000000'],
      ['SHOP-112', true, '000001'],
      ['SHOP-118', false, '000002'],
    ]);
    expect(all[0]).toMatchObject({
      status: 'In Progress',
      statusCategory: 'in_progress',
      priority: 'High',
      url: 'https://shop.example.com/browse/SHOP-101',
      updatedAt: '2026-05-31T09:30:00.000Z',
    });
    expect(all[0]).not.toHaveProperty('description');

    const searches = seen.filter((r) => r.url.pathname.endsWith('/search/jql'));
    const active = searches.filter((r) => !jqlOf(r.body).includes('openSprints'));
    expect(active).toHaveLength(2);
    expect(jqlOf(active[0]!.body)).toBe(
      'assignee = currentUser() AND statusCategory != Done ORDER BY Rank ASC',
    );
    expect((active[1]!.body as { nextPageToken: string }).nextPageToken).toBe('page-2-token');

    const sprint = await jira.listMyActiveIssues({ sprintOnly: true });
    expect(sprint.map((i) => i.key)).toEqual(['SHOP-101', 'SHOP-112']);
  });

  it('converts ADF descriptions and comments, and extracts acceptance criteria', async () => {
    const { fetch, seen } = cloudServer();
    const jira = new JiraIssueTracker({
      deployment: 'cloud',
      baseUrl: 'https://shop.example.com',
      getHeaders: headers,
      fetch,
    });
    await jira.listMyActiveIssues({ sprintOnly: false });
    const before = seen.length;
    const detail = await jira.getIssue('SHOP-101');
    expect(seen).toHaveLength(before); // served from the search results
    expect(detail.acceptanceCriteria).toEqual([
      'Invalid emails show an inline error',
      'The submit button stays disabled',
    ]);
    expect(detail.description).toContain('- The submit button stays disabled');
    expect(detail.comments).toEqual([
      {
        author: 'Pat Product',
        body: '@Dana Developer please also cover the signup form.',
        createdAt: '2026-05-30T14:00:00.000Z',
      },
    ]);
  });

  it('lists recently completed issues by resolution date', async () => {
    const { fetch, seen } = cloudServer();
    const jira = new JiraIssueTracker({
      deployment: 'cloud',
      baseUrl: 'https://shop.example.com',
      getHeaders: headers,
      fetch,
      now: () => now,
    });
    const since = new Date(now.getTime() - 3 * 86_400_000);
    const done = await jira.listMyRecentlyCompleted(since);
    expect(done.map((i) => [i.key, i.completedAt])).toEqual([
      ['SHOP-099', '2026-05-31T10:00:00.000Z'],
    ]);
    expect(jqlOf(seen[0]!.body)).toBe(
      'assignee = currentUser() AND statusCategory = Done AND updated >= -4320m ORDER BY updated DESC',
    );
  });

  it('ranks unstarted sprint issues as next candidates', async () => {
    const { fetch } = cloudServer();
    const jira = new JiraIssueTracker({
      deployment: 'cloud',
      baseUrl: 'https://shop.example.com',
      getHeaders: headers,
      fetch,
    });
    expect((await jira.rankNextCandidates()).map((i) => i.key)).toEqual(['SHOP-112']);
  });

  it('uses the board’s active sprints when a board id is set', async () => {
    const { fetch, seen } = fakeFetch(({ url, body }) => {
      if (url.pathname === '/rest/agile/1.0/board/7/sprint') {
        return { body: { values: [{ id: 31 }, { id: 32 }] } };
      }
      if (url.pathname === '/rest/api/3/search/jql') {
        return { body: jqlOf(body).includes('sprint in (') ? cloud.sprint : cloud.activePages[1] };
      }
      return undefined;
    });
    const jira = new JiraIssueTracker({
      deployment: 'cloud',
      baseUrl: 'https://shop.example.com',
      getHeaders: headers,
      boardId: '7',
      fetch,
    });
    await jira.listMyActiveIssues({ sprintOnly: false });
    expect(seen.find((r) => r.url.pathname.endsWith('/sprint'))!.url.search).toBe('?state=active');
    expect(seen.some((r) => r.body && jqlOf(r.body).includes('AND sprint in (31, 32)'))).toBe(true);
  });

  it('turns a 401 into a renew-your-token error', async () => {
    const { fetch } = fakeFetch(() => ({ status: 401, body: {} }));
    const jira = new JiraIssueTracker({
      deployment: 'cloud',
      baseUrl: 'https://shop.example.com',
      getHeaders: headers,
      fetch,
    });
    const err = await jira.getCurrentUser().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err).toMatchObject({ kind: 'auth' });
    expect((err as Error).message).toMatch(/renew it in Settings/);
  });
});

describe('JiraIssueTracker (Data Center)', () => {
  function dcServer() {
    return fakeFetch(({ method, url, body }) => {
      if (url.pathname === '/rest/api/2/myself') return { body: dc.myself };
      if (method === 'POST' && url.pathname === '/rest/api/2/search') {
        if (jqlOf(body).includes('openSprints()')) return { status: 400, body: dc.sprintError };
        const startAt = (body as { startAt: number }).startAt;
        return { body: dc.activePages[startAt === 0 ? 0 : 1] };
      }
      return undefined;
    });
  }

  it('uses REST v2 and the username', async () => {
    const { fetch, seen } = dcServer();
    const jira = new JiraIssueTracker({
      deployment: 'datacenter',
      baseUrl: 'https://jira.example.com',
      getHeaders: async () => ({ Authorization: 'Bearer pat' }),
      fetch,
    });
    expect(await jira.getCurrentUser()).toEqual({
      id: 'JIRAUSER10100',
      displayName: 'Dana Developer',
      username: 'dana',
    });
    expect(seen[0]!.headers.Authorization).toBe('Bearer pat');
  });

  it('pages with startAt/total and treats a missing sprint field as "no sprints"', async () => {
    const { fetch, seen } = dcServer();
    const jira = new JiraIssueTracker({
      deployment: 'datacenter',
      baseUrl: 'https://jira.example.com',
      getHeaders: headers,
      fetch,
    });
    const issues = await jira.listMyActiveIssues({ sprintOnly: true });
    expect(issues.map((i) => [i.key, i.inOpenSprint])).toEqual([
      ['OPS-7', true],
      ['OPS-9', true],
    ]);
    const starts = seen
      .filter((r) => !jqlOf(r.body).includes('openSprints'))
      .map((r) => (r.body as { startAt: number }).startAt);
    expect(starts).toEqual([0, 1]);
  });

  it('converts wiki markup and finds acceptance criteria', async () => {
    const { fetch } = dcServer();
    const jira = new JiraIssueTracker({
      deployment: 'datacenter',
      baseUrl: 'https://jira.example.com',
      getHeaders: headers,
      fetch,
    });
    await jira.listMyActiveIssues({ sprintOnly: false });
    const detail = await jira.getIssue('OPS-7');
    expect(detail.acceptanceCriteria).toEqual([
      'New certificates are installed',
      'Monitoring shows no TLS errors',
    ]);
    expect(detail.description).not.toContain('h3.');
  });

  it('excludes configured done-like statuses from active work', async () => {
    const { fetch, seen } = dcServer();
    const jira = new JiraIssueTracker({
      deployment: 'datacenter',
      baseUrl: 'https://jira.example.com',
      getHeaders: headers,
      doneStatuses: ['Ready for Release'],
      fetch,
    });
    await jira.listMyActiveIssues({ sprintOnly: false });
    expect(jqlOf(seen[0]!.body)).toContain('AND status not in ("Ready for Release")');
  });
});

describe('jqlString', () => {
  it('quotes and escapes', () => {
    expect(jqlString('Say "hi"\\')).toBe('"Say \\"hi\\"\\\\"');
  });
});
