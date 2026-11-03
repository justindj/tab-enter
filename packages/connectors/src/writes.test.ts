import { describe, expect, it } from 'vitest';
import { GitLabCodeHost } from './gitlab';
import { JiraIssueTracker } from './jira';
import { fakeFetch, type FakeReply } from './test-support';

const gitlab = (handler: Parameters<typeof fakeFetch>[0]) => {
  const { fetch, seen } = fakeFetch(handler);
  const sleeps: number[] = [];
  const host = new GitLabCodeHost({
    baseUrl: 'https://gitlab.example.com',
    getHeaders: async () => ({ 'PRIVATE-TOKEN': 't' }),
    fetch,
    sleep: async (ms) => void sleeps.push(ms),
  });
  return { host, seen, sleeps };
};

const MR = {
  id: 1,
  iid: 12,
  project_id: 42,
  title: 'T',
  state: 'opened',
  source_branch: 'f',
  target_branch: 'main',
  web_url: 'https://gitlab.example.com/acme/shop/-/merge_requests/12',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  diff_refs: { base_sha: 'b', start_sha: 's', head_sha: 'h' },
};

describe('GitLab writes', () => {
  const ref = { projectId: '42', iid: 12 };

  it('posts a note and links to it', async () => {
    const { host, seen } = gitlab(({ method, url }): FakeReply | undefined => {
      if (method === 'POST' && url.pathname.endsWith('/notes'))
        return { status: 201, body: { id: 77 } };
      if (url.pathname.endsWith('/merge_requests/12')) return { body: MR };
      return undefined;
    });
    expect(await host.postNote(ref, 'Looks good')).toEqual({ url: `${MR.web_url}#note_77` });
    expect(seen.find((r) => r.method === 'POST')!.body).toEqual({ body: 'Looks good' });
  });

  it('places line comments with the MR diff refs', async () => {
    const { host, seen } = gitlab(({ method, url }) => {
      if (method === 'POST') return { status: 201, body: { notes: [{ id: 5 }] } };
      if (url.pathname.endsWith('/merge_requests/12')) return { body: MR };
      return undefined;
    });
    await host.postDiffNote(ref, { file: 'src/a.ts', line: 4, body: 'Fix' });
    expect(seen.find((r) => r.method === 'POST')!.body).toEqual({
      body: 'Fix',
      position: {
        position_type: 'text',
        base_sha: 'b',
        start_sha: 's',
        head_sha: 'h',
        new_path: 'src/a.ts',
        old_path: 'src/a.ts',
        new_line: 4,
      },
    });
  });

  it('approves only at the reviewed commit', async () => {
    const { host, seen } = gitlab(() => ({ status: 201, body: {} }));
    await host.approve(ref, 'abc1234');
    expect(seen[0]).toMatchObject({ method: 'POST', body: { sha: 'abc1234' } });
    expect(seen[0]!.url.pathname).toBe('/api/v4/projects/42/merge_requests/12/approve');
  });

  it('creates a merge request', async () => {
    const { host, seen } = gitlab(() => ({
      status: 201,
      body: { web_url: 'https://gitlab.example.com/x/-/merge_requests/9', iid: 9 },
    }));
    expect(
      await host.createMergeRequest({
        projectId: 'acme/shop',
        sourceBranch: 'f',
        targetBranch: 'main',
        title: 'T',
        description: 'D',
      }),
    ).toEqual({ url: 'https://gitlab.example.com/x/-/merge_requests/9', iid: 9 });
    expect(seen[0]!.url.pathname).toBe('/api/v4/projects/acme%2Fshop/merge_requests');
  });

  it('never retries a write after a server error (it may have gone through)', async () => {
    const { host, seen, sleeps } = gitlab(() => ({ status: 502, body: {} }));
    await expect(host.approve(ref, 'abc1234')).rejects.toThrow(/502/);
    expect(seen).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it('does retry a write that was rate limited (it was not processed)', async () => {
    let calls = 0;
    const { host, seen } = gitlab(() =>
      ++calls === 1 ? { status: 429, body: {} } : { status: 201, body: {} },
    );
    await host.approve(ref, 'abc1234');
    expect(seen).toHaveLength(2);
  });
});

describe('Jira writes', () => {
  const jira = (deployment: 'cloud' | 'datacenter', handler: Parameters<typeof fakeFetch>[0]) => {
    const { fetch, seen } = fakeFetch(handler);
    return {
      jira: new JiraIssueTracker({
        deployment,
        baseUrl: 'https://jira.example.com',
        getHeaders: async () => ({}),
        fetch,
      }),
      seen,
    };
  };

  it('comments in ADF on Cloud and plain text on Data Center', async () => {
    const cloud = jira('cloud', () => ({ status: 201, body: { id: '100' } }));
    expect(await cloud.jira.addComment('A-1', 'Line one\n\nLine two')).toEqual({
      url: 'https://jira.example.com/browse/A-1?focusedCommentId=100',
    });
    expect(cloud.seen[0]!.url.pathname).toBe('/rest/api/3/issue/A-1/comment');
    expect(cloud.seen[0]!.body).toEqual({
      body: {
        type: 'doc',
        version: 1,
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'Line one' }] },
          { type: 'paragraph', content: [] },
          { type: 'paragraph', content: [{ type: 'text', text: 'Line two' }] },
        ],
      },
    });
    const dc = jira('datacenter', () => ({ status: 201, body: { id: '7' } }));
    await dc.jira.addComment('A-1', 'Hi');
    expect(dc.seen[0]!.url.pathname).toBe('/rest/api/2/issue/A-1/comment');
    expect(dc.seen[0]!.body).toEqual({ body: 'Hi' });
  });

  it('lists transitions and performs one (204 No Content)', async () => {
    const { jira: j, seen } = jira('cloud', ({ method }) =>
      method === 'GET'
        ? { body: { transitions: [{ id: '31', name: 'Done', to: { name: 'Done' } }] } }
        : { status: 204, body: null },
    );
    expect(await j.listTransitions('A-1')).toEqual([{ id: '31', name: 'Done', to: 'Done' }]);
    await j.transition('A-1', '31');
    expect(seen[1]).toMatchObject({ method: 'POST', body: { transition: { id: '31' } } });
  });
});
