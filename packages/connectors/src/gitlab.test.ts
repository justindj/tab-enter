import { describe, expect, it } from 'vitest';
import { countDiffLines, GitLabCodeHost, mapPipelineStatus } from './gitlab';
import { fakeFetch, loadContractFixture, type FakeReply } from './test-support';
import { ConnectorError } from './types';

/* eslint-disable @typescript-eslint/no-explicit-any */
const gl = loadContractFixture<any>('gitlab.json');

const now = new Date('2026-06-01T12:00:00.000Z');
const since = new Date(now.getTime() - 3 * 86_400_000);
const allMRs: any[] = [...gl.createdOpenPages.flat(), ...gl.createdMerged, ...gl.reviewOpen];

function server() {
  return fakeFetch(({ url }): FakeReply | undefined => {
    const p = url.pathname.replace('/api/v4', '');
    const q = url.searchParams;
    if (p === '/user') return { body: gl.user };
    if (p === '/merge_requests') {
      if (q.get('scope') === 'created_by_me' && q.get('state') === 'opened') {
        const page = Number(q.get('page'));
        return {
          body: gl.createdOpenPages[page - 1],
          headers: { 'x-next-page': page === 1 ? '2' : '' },
        };
      }
      if (q.get('scope') === 'created_by_me' && q.get('state') === 'merged') {
        return { body: gl.createdMerged };
      }
      if (q.get('scope') === 'all' && q.get('reviewer_id') === '501') {
        return { body: q.get('state') === 'opened' ? gl.reviewOpen : [] };
      }
    }
    const m = /^\/projects\/(\d+)\/merge_requests\/(\d+)(\/\w+)?$/.exec(p);
    if (m) {
      const key = `${m[1]}!${m[2]}`;
      const base = allMRs.find((mr) => `${mr.project_id}!${mr.iid}` === key);
      if (!base) return undefined;
      switch (m[3]) {
        case undefined:
          return { body: { ...base, ...gl.single[key] } };
        case '/approvals':
          return { body: gl.approvals[key] ?? {} };
        case '/discussions':
          return { body: gl.discussions[key] ?? [] };
        case '/diffs':
          return { body: gl.diffs[key] ?? [] };
      }
    }
    return undefined;
  });
}

function host(
  fetch: ReturnType<typeof server>['fetch'],
  projects = [{ id: '42', path: 'acme/shop' }],
) {
  return new GitLabCodeHost({
    baseUrl: 'https://gitlab.example.com/',
    getHeaders: async () => ({ 'PRIVATE-TOKEN': 'test' }),
    projects,
    completedSince: since,
    fetch,
  });
}

describe('GitLabCodeHost', () => {
  it('reads the current user and sends the token header', async () => {
    const { fetch, seen } = server();
    expect(await host(fetch).getCurrentUser()).toEqual({
      id: '501',
      displayName: 'Dana Developer',
      username: 'dana',
    });
    expect(seen[0]!.url.toString()).toBe('https://gitlab.example.com/api/v4/user');
    expect(seen[0]!.headers['PRIVATE-TOKEN']).toBe('test');
  });

  it('lists my open MRs across pages, filtered to watched projects, with full status', async () => {
    const { fetch } = server();
    const mrs = await host(fetch).listMyOpenMRs();
    expect(mrs).toHaveLength(1);
    expect(mrs[0]).toMatchObject({
      ref: { projectId: '42', iid: 12 },
      projectPath: 'acme/shop',
      sourceBranch: 'feature/SHOP-101-email-validation',
      state: 'opened',
      draft: false,
      author: 'dana',
      detailedMergeStatus: 'requested_changes',
      hasConflicts: true,
      pipelineStatus: 'failed',
      approvedBy: [],
      approvalsRequired: 1,
      unresolvedThreads: 1,
      changesRequested: true,
      reviewers: ['riley'],
      linesAdded: 3,
      linesRemoved: 1,
      headSha: 'aaa111',
    });
  });

  it('returns every project when none are watched', async () => {
    const { fetch } = server();
    const mrs = await host(fetch, []).listMyOpenMRs();
    expect(mrs.map((m) => m.projectPath)).toEqual(['acme/shop', 'acme/other']);
    expect(mrs[1]).toMatchObject({ draft: true, pipelineStatus: 'none' });
  });

  it('lists recently merged MRs by merged_at, skipping threads and diffs', async () => {
    const { fetch, seen } = server();
    const merged = await host(fetch).listMyRecentlyMergedMRs(since);
    expect(merged.map((m) => [m.ref.iid, m.state, m.approvedBy])).toEqual([
      [11, 'merged', ['riley']],
    ]);
    const list = seen.find((r) => r.url.searchParams.get('state') === 'merged')!;
    expect(list.url.searchParams.get('updated_after')).toBe(since.toISOString());
    expect(seen.some((r) => /\/(discussions|diffs)$/.test(r.url.pathname))).toBe(false);
  });

  it('lists review requests and hides ones I already approved', async () => {
    const { fetch } = server();
    const gitlab = host(fetch);
    const all = await gitlab.listReviewRequests({ includeCompleted: true });
    const pending = await gitlab.listReviewRequests({ includeCompleted: false });
    expect(all.map((m) => m.ref.iid)).toEqual([21, 22]);
    expect(pending.map((m) => m.ref.iid)).toEqual([21]);
    expect(all[0]).toMatchObject({ pipelineStatus: 'pending', approvalsRequired: 0 });
  });

  it('returns MR detail with diffs and non-system discussions', async () => {
    const { fetch } = server();
    const detail = await host(fetch).getMRDetail({ projectId: '42', iid: 12 });
    expect(detail.diff).toEqual([{ path: 'src/login.ts', diff: gl.diffs['42!12'][0].diff }]);
    expect(detail.discussions).toEqual([
      {
        id: 'd1',
        resolved: false,
        notes: [
          {
            author: 'riley',
            body: 'Please handle uppercase domains.',
            createdAt: '2026-05-30T09:00:00.000Z',
            filePath: 'src/login.ts',
            line: 14,
          },
        ],
      },
      {
        id: 'd2',
        resolved: true,
        notes: [
          { author: 'riley', body: 'Nit: rename this.', createdAt: '2026-05-30T09:05:00.000Z' },
        ],
      },
    ]);
  });

  it('retries a 429 using Retry-After, then succeeds', async () => {
    let calls = 0;
    const waits: number[] = [];
    const { fetch } = fakeFetch(() =>
      ++calls === 1
        ? { status: 429, body: {}, headers: { 'Retry-After': '2' } }
        : { body: gl.user },
    );
    const gitlab = new GitLabCodeHost({
      baseUrl: 'https://gitlab.example.com',
      getHeaders: async () => ({}),
      fetch,
      sleep: async (ms) => void waits.push(ms),
    });
    expect((await gitlab.getCurrentUser()).username).toBe('dana');
    expect(waits).toEqual([2000]);
  });

  it('explains an SSO/VPN page served instead of JSON', async () => {
    const gitlab = new GitLabCodeHost({
      baseUrl: 'https://gitlab.example.com',
      getHeaders: async () => ({}),
      fetch: async () =>
        new Response('<html>Sign in</html>', { headers: { 'Content-Type': 'text/html' } }),
    });
    const err = await gitlab.getCurrentUser().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectorError);
    expect((err as Error).message).toMatch(/web page instead of API data/);
  });

  it('reports unreachable hosts as network errors', async () => {
    const gitlab = new GitLabCodeHost({
      baseUrl: 'https://gitlab.example.com',
      getHeaders: async () => ({}),
      fetch: async () => {
        throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
      },
      sleep: async () => {},
    });
    const err = await gitlab.getCurrentUser().catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'network' });
    expect((err as Error).message).toMatch(/connect to the VPN/);
  });
});

describe('helpers', () => {
  it('maps every GitLab pipeline status', () => {
    expect(mapPipelineStatus('waiting_for_resource')).toBe('pending');
    expect(mapPipelineStatus('canceling')).toBe('canceled');
    expect(mapPipelineStatus(undefined)).toBe('none');
  });

  it('counts diff lines without counting headers', () => {
    expect(countDiffLines('--- a/x\n+++ b/x\n@@\n+a\n-b\n c')).toEqual({ added: 1, removed: 1 });
  });
});
