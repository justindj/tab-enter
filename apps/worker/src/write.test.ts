import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeFetch } from '@tab-enter/connectors/test-support';
import { describeWrite, parseProfileSettings, type WriteAction } from '@tab-enter/core';
import {
  createProfile,
  createRun,
  createWriteAction,
  enqueueJob,
  ensureDemoProfile,
  getActiveProfile,
  getJob,
  getRun,
  getWriteAction,
  hasPendingJob,
  updateProfile,
  updateRun,
  type Db,
} from '@tab-enter/db';
import { createTestDb } from '@tab-enter/db/test-support';
import { MemorySecretStore, PatCredentialProvider, SECRET_NAMES } from '@tab-enter/secrets';
import { describe, expect, it } from 'vitest';
import { executeWriteAction } from './handlers/write-action';
import { processNextJob } from './worker';

const fixturesDir = fileURLToPath(new URL('../../../fixtures', import.meta.url));

async function log(db: Db, profileId: string, action: WriteAction) {
  return createWriteAction(db, {
    profileId,
    action: action.kind,
    ...describeWrite(action),
    payload: action,
  });
}

async function liveProfile(db: Db, writes: Record<string, boolean>) {
  const id = await createProfile(db, { name: 'Client' });
  const settings = parseProfileSettings({
    jira: { baseUrl: 'https://jira.example.com', email: 'dev@example.com' },
    gitlab: { baseUrl: 'https://gitlab.example.com' },
    writeActions: writes,
  });
  await updateProfile(db, id, { settings });
  const store = new MemorySecretStore();
  await store.set(id, SECRET_NAMES.jiraToken, 'j');
  await store.set(id, SECRET_NAMES.gitlabToken, 'g');
  return { id, credentials: new PatCredentialProvider(store, async () => settings) };
}

describe('write actions', () => {
  it('refuses an action that is turned off, even if one was logged', async () => {
    const db = await createTestDb();
    const { id, credentials } = await liveProfile(db, {});
    const actionId = await log(db, id, { kind: 'mr-approve', mrKey: '42!12', sha: 'abcdef1' });
    const { fetch, seen } = fakeFetch(() => ({ body: {} }));
    await executeWriteAction(db, { profileId: id, actionId }, { credentials, fetch });
    expect(await getWriteAction(db, actionId)).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('turned off'),
    });
    expect(seen).toHaveLength(0);
  });

  it('simulates writes in the demo profile', async () => {
    const db = await createTestDb();
    await ensureDemoProfile(db);
    const demo = (await getActiveProfile(db))!;
    await updateProfile(db, demo.id, {
      settings: parseProfileSettings({ writeActions: { gitlabApprove: true } }),
    });
    const actionId = await log(db, demo.id, { kind: 'mr-approve', mrKey: '42!21', sha: 'abcdef1' });
    await executeWriteAction(db, { profileId: demo.id, actionId }, {});
    expect(await getWriteAction(db, actionId)).toMatchObject({
      status: 'done',
      result: { message: expect.stringContaining('simulated') },
    });
  });

  it('posts line comments, falling back to a general comment off the diff, then resyncs', async () => {
    const db = await createTestDb();
    const { id, credentials } = await liveProfile(db, { gitlabComment: true });
    const mr = {
      web_url: 'https://gitlab.example.com/a/b/-/merge_requests/12',
      diff_refs: { base_sha: 'b', start_sha: 's', head_sha: 'h' },
    };
    const { fetch, seen } = fakeFetch(({ method, url, body }) => {
      if (method === 'GET') return { body: mr };
      if (url.pathname.endsWith('/discussions')) {
        const line = (body as { position: { new_line: number } }).position.new_line;
        return line === 999
          ? { status: 400, body: { message: 'line_code can not be blank' } }
          : { status: 201, body: { notes: [{ id: 1 }] } };
      }
      return { status: 201, body: { id: 2 } };
    });
    const actionId = await log(db, id, {
      kind: 'mr-diff-comments',
      mrKey: '42!12',
      comments: [
        { file: 'a.ts', line: 3, body: 'Null check' },
        { file: 'b.ts', line: 999, body: 'Rename' },
      ],
    });
    await executeWriteAction(db, { profileId: id, actionId }, { credentials, fetch });
    expect(await getWriteAction(db, actionId)).toMatchObject({
      status: 'done',
      result: { message: 'Posted 1 line comment and 1 general (line not in the diff).' },
    });
    const general = seen.find((r) => r.method === 'POST' && r.url.pathname.endsWith('/notes'));
    expect(general?.body).toEqual({ body: '`b.ts:999`: Rename' });
  });

  it('records API failures without retrying', async () => {
    const db = await createTestDb();
    const { id, credentials } = await liveProfile(db, { gitlabApprove: true });
    const { fetch, seen } = fakeFetch(() => ({
      status: 401,
      body: { message: '401 Unauthorized' },
    }));
    const actionId = await log(db, id, { kind: 'mr-approve', mrKey: '42!12', sha: 'abcdef1' });
    await executeWriteAction(db, { profileId: id, actionId }, { credentials, fetch });
    expect(await getWriteAction(db, actionId)).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('401'),
    });
    expect(seen).toHaveLength(1);
    expect(await hasPendingJob(db, 'sync', id)).toBe(false);
  });

  it('runs a Jira transitions query and stores the result on the job', async () => {
    const db = await createTestDb();
    const { id, credentials } = await liveProfile(db, {});
    const { fetch } = fakeFetch(() => ({
      body: { transitions: [{ id: '31', name: 'Done', to: { name: 'Done' } }] },
    }));
    const jobId = await enqueueJob(db, {
      type: 'jira-transitions',
      profileId: id,
      issueKey: 'A-1',
    });
    await processNextJob(db, { fixturesDir, credentials, fetch, log: () => {} });
    expect((await getJob(db, jobId))?.result).toEqual([{ id: '31', name: 'Done', to: 'Done' }]);
  });
});

describe('git push', () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

  function repo() {
    const root = mkdtempSync(path.join(os.tmpdir(), 'tab-enter-push-'));
    const origin = path.join(root, 'origin.git');
    const clone = path.join(root, 'work');
    git(root, 'init', '--bare', '--initial-branch=main', origin);
    git(root, 'clone', origin, clone);
    git(clone, 'config', 'user.email', 'a@example.com');
    git(clone, 'config', 'user.name', 'A');
    writeFileSync(path.join(clone, 'a.txt'), '1\n');
    git(clone, 'add', '.');
    git(clone, 'commit', '-m', 'init');
    git(clone, 'push', 'origin', 'main');
    return { origin, clone };
  }

  async function runOn(db: Db, profileId: string, cwd: string, branch: string) {
    const runId = await createRun(
      db,
      { profileId, preset: 'work-ticket', prompt: 'x', modelRequested: 'sonnet', issueKey: 'A-1' },
      undefined,
      { enqueue: false },
    );
    await updateRun(db, runId, { cwd, branch, status: 'succeeded' });
    return runId;
  }

  it('pushes the run branch to origin, without force', async () => {
    const { origin, clone } = repo();
    git(clone, 'checkout', '-b', 'feature/A-1-fix');
    writeFileSync(path.join(clone, 'a.txt'), '2\n');
    git(clone, 'commit', '-am', 'A-1 fix');
    const db = await createTestDb();
    const { id } = await liveProfile(db, { gitPush: true });
    const runId = await runOn(db, id, clone, 'feature/A-1-fix');

    const actionId = await log(db, id, { kind: 'git-push', runId });
    await executeWriteAction(db, { profileId: id, actionId }, {});
    expect(await getWriteAction(db, actionId)).toMatchObject({
      status: 'done',
      result: { message: expect.stringContaining('Pushed feature/A-1-fix') },
    });
    expect(git(origin, 'rev-parse', 'feature/A-1-fix')).toBe(git(clone, 'rev-parse', 'HEAD'));
    expect((await getRun(db, runId))?.diffSummary?.commits).toEqual([]);

    // Diverged history is rejected, not forced.
    git(clone, 'reset', '--hard', 'main');
    writeFileSync(path.join(clone, 'a.txt'), '3\n');
    git(clone, 'commit', '-am', 'rewrite');
    const again = await log(db, id, { kind: 'git-push', runId });
    await executeWriteAction(db, { profileId: id, actionId: again }, {});
    expect(await getWriteAction(db, again)).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('git push failed'),
    });
  });

  it('never pushes protected branches', async () => {
    const { clone } = repo();
    const db = await createTestDb();
    const { id } = await liveProfile(db, { gitPush: true });
    const runId = await runOn(db, id, clone, 'main');
    const actionId = await log(db, id, { kind: 'git-push', runId });
    await executeWriteAction(db, { profileId: id, actionId }, {});
    expect(await getWriteAction(db, actionId)).toMatchObject({
      status: 'failed',
      error: 'tab-enter never pushes main.',
    });
  });
});
