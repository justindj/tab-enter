import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseProfileSettings,
  type AgentEvent,
  type AgentRunner,
  type IssueDetail,
  type MergeRequest,
} from '@tab-enter/core';
import {
  createProfile,
  createVerification,
  ensureDemoProfile,
  getActiveProfile,
  getDataDir,
  getVerification,
  listRecentRuns,
  replaceSyncedData,
  updateProfile,
  type Db,
} from '@tab-enter/db';
import { FileBlobStore } from '@tab-enter/db/blob-store';
import { createTestDb } from '@tab-enter/db/test-support';
import { fakeFetch } from '@tab-enter/connectors/test-support';
import { MemorySecretStore, PatCredentialProvider, SECRET_NAMES } from '@tab-enter/secrets';
import { chromium } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeVerification } from './handlers/verify';
import { syncProfile } from './handlers/sync';
import { resolveStepUrl } from './walkthrough';

const fixturesDir = fileURLToPath(new URL('../../../fixtures', import.meta.url));
process.env.TAB_ENTER_HOME = mkdtempSync(path.join(os.tmpdir(), 'tab-enter-home-'));
const blobs = new FileBlobStore(getDataDir());

const html = async (db: Db, id: string) => {
  const row = (await getVerification(db, id))!;
  return row.blobKey ? Buffer.from((await blobs.get(row.blobKey))!).toString('utf8') : '';
};

describe('demo verification', () => {
  async function demo(issueKey: string, mode: 'auto' | 'ui' | 'backend' = 'auto', rerun = false) {
    const db = await createTestDb();
    await ensureDemoProfile(db);
    const profile = (await getActiveProfile(db))!;
    await syncProfile(db, profile.id, { fixturesDir });
    const id = await createVerification(db, { profileId: profile.id, issueKey, mrKey: null });
    await executeVerification(
      db,
      { profileId: profile.id, artifactId: id, mode, rerun },
      { fixturesDir, blobs },
    );
    return { db, id, profile };
  }

  it('simulates the walkthrough and builds a slideshow, without claiming "verified"', async () => {
    const { db, id } = await demo('SHOP-099');
    const row = (await getVerification(db, id))!;
    expect(row).toMatchObject({ mode: 'ui', mrKey: '42!11', status: 'issues_found', error: null });
    expect(row.criteria).toEqual([{ text: 'Links are valid for 60 minutes', result: 'partial' }]);
    expect(row.summary).toContain('Verification of SHOP-099');
    const page = await html(db, id);
    expect(page).toContain('A 61-minute-old link is rejected');
    expect(page).toContain('Demo data (simulated screenshots)');
    expect(page).toContain('data:image/svg+xml;base64,');
    expect(row.scriptBlobKey).toMatch(/walkthrough\.json$/);
  });

  it('falls back to test evidence for backend tickets and flags missing tests', async () => {
    const { db, id } = await demo('SHOP-096');
    expect(await getVerification(db, id)).toMatchObject({
      mode: 'backend',
      status: 'needs_coverage',
    });
    expect(await html(db, id)).toContain('No test files changed.');
  });

  it('explains when there is no saved walkthrough to re-run', async () => {
    const { db, id } = await demo('SHOP-096', 'ui', true);
    expect(await getVerification(db, id)).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('no saved walkthrough'),
    });
  });
});

describe('walkthrough safety', () => {
  it('stays on the configured origin', () => {
    expect(resolveStepUrl('http://127.0.0.1:4000', '/login')).toBe('http://127.0.0.1:4000/login');
    expect(() => resolveStepUrl('http://127.0.0.1:4000', 'https://evil.example.com/x')).toThrow(
      /Refusing to open/,
    );
  });
});

const doneIssue = (key: string, criteria: string[]): IssueDetail => ({
  key,
  summary: `${key} change`,
  status: 'Done',
  statusCategory: 'done',
  priority: null,
  rank: null,
  issueType: 'Story',
  url: `https://jira.example.test/browse/${key}`,
  inOpenSprint: true,
  updatedAt: new Date().toISOString(),
  completedAt: new Date().toISOString(),
  description: '',
  acceptanceCriteria: criteria,
  comments: [],
});

const mergedMR = (iid: number, key: string) =>
  ({
    ref: { projectId: '7', iid },
    projectPath: 'acme/x',
    title: `${key} change`,
    state: 'merged',
    webUrl: `https://gitlab.example.test/acme/x/-/merge_requests/${iid}`,
    pipelineStatus: 'success',
    updatedAt: new Date().toISOString(),
    mergedAt: new Date().toISOString(),
    linesAdded: 1,
    linesRemoved: 0,
    targetBranch: 'main',
    sourceBranch: `feature/${key}`,
  }) as MergeRequest;

async function seed(db: Db, profileId: string, issue: IssueDetail, mr: MergeRequest) {
  await replaceSyncedData(db, profileId, {
    issues: [issue],
    mergeRequests: [{ mr, isMine: true, isReviewer: false, needsMyReview: false }],
    links: [{ mrKey: `7!${mr.ref.iid}`, links: [{ issueKey: issue.key, source: 'title' }] }],
  });
}

/** A clone with an origin, so verification can make its worktree. */
function gitRepo() {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const root = mkdtempSync(path.join(os.tmpdir(), 'tab-enter-verify-'));
  const origin = path.join(root, 'origin.git');
  const clone = path.join(root, 'work');
  git(root, 'init', '--bare', '--initial-branch=main', origin);
  git(root, 'clone', origin, clone);
  writeFileSync(path.join(clone, 'a.txt'), '1\n');
  git(clone, 'add', '.');
  git(clone, '-c', 'user.email=a@example.com', '-c', 'user.name=A', 'commit', '-m', 'init');
  git(clone, 'push', 'origin', 'main');
  return { root, clone };
}

describe('repo Playwright tests', () => {
  it('runs the repo’s own specs instead of asking Claude for a walkthrough', async () => {
    const { root, clone } = gitRepo();
    const db = await createTestDb();
    const profileId = await createProfile(db, { name: 'Client' });
    await updateProfile(db, profileId, {
      settings: parseProfileSettings({
        claude: { approvedForClient: true },
        gitlab: {
          projects: [
            {
              id: '7',
              path: 'acme/x',
              localPath: clone,
              verification: {
                baseUrl: 'http://127.0.0.1:4999',
                specCommand: 'npx playwright test e2e/',
                testCredentialsSecret: 'test-credentials:7',
              },
            },
          ],
        },
      }),
    });
    const secrets = new MemorySecretStore();
    await secrets.set(
      profileId,
      'test-credentials:7',
      JSON.stringify({ username: 'qa@example.com', password: 'pw-123' }),
    );
    await seed(db, profileId, doneIssue('X-2', ['Orders list loads']), mergedMR(4, 'X-2'));

    const png = path.join(root, 'shot.png');
    writeFileSync(png, Buffer.from('89504e47', 'hex'));
    const calls: { command: string; cwd: string; env: NodeJS.ProcessEnv }[] = [];
    const runShell = async (
      command: string,
      cwd: string,
      opts: { env?: NodeJS.ProcessEnv } = {},
    ) => {
      calls.push({ command, cwd, env: opts.env ?? {} });
      writeFileSync(
        opts.env!.PLAYWRIGHT_JSON_OUTPUT_NAME!,
        JSON.stringify({
          suites: [
            {
              title: 'orders.spec.ts',
              specs: [
                {
                  title: 'lists orders',
                  tests: [
                    {
                      status: 'expected',
                      results: [{ attachments: [{ contentType: 'image/png', path: png }] }],
                    },
                  ],
                },
                {
                  title: 'filters by date',
                  tests: [
                    {
                      status: 'unexpected',
                      results: [{ error: { message: 'expect(locator).toBeVisible() failed' } }],
                    },
                  ],
                },
              ],
            },
          ],
        }),
      );
      return { code: 1, timedOut: false, output: '' };
    };
    const prompts: string[] = [];
    const runner = (): AgentRunner => ({
      id: 'fake',
      detect: async () => {
        throw new Error('unused');
      },
      async *run(req): AsyncIterable<AgentEvent> {
        prompts.push(req.prompt);
        yield {
          type: 'result',
          sessionId: 's',
          isError: false,
          subtype: 'success',
          resultText: JSON.stringify({
            criteria: [{ text: 'Orders list loads', result: 'partial', note: 'one spec failed' }],
            summary: 'One spec fails.',
          }),
          numTurns: 1,
          durationMs: 1,
          models: ['m'],
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            costUsd: 0,
          },
        };
      },
    });

    const id = await createVerification(db, { profileId, issueKey: 'X-2', mrKey: null });
    await executeVerification(
      db,
      { profileId, artifactId: id, mode: 'ui', rerun: false },
      { fixturesDir, blobs, secrets, runner, runShell },
    );

    const row = (await getVerification(db, id))!;
    expect(row).toMatchObject({ status: 'issues_found', mode: 'ui', error: null });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe('npx playwright test e2e/ --reporter=json');
    expect(calls[0]!.cwd).toContain('.tab-enter-worktrees');
    expect(calls[0]!.env).toMatchObject({
      BASE_URL: 'http://127.0.0.1:4999',
      TEST_USERNAME: 'qa@example.com',
      TEST_PASSWORD: 'pw-123',
    });
    // Only the assessment asks Claude; the spec results (not credentials) are its evidence.
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('FAILED orders.spec.ts › filters by date');
    expect(prompts[0]).not.toContain('pw-123');
    const page = await html(db, id);
    expect(page).toContain('Playwright tests');
    expect(page).toContain('data:image/png;base64,');
    expect(page).not.toContain('pw-123');
  });
});

// A real browser run: a tiny local app, a fake Claude that writes the steps and
// the assessment, and Playwright driving the installed Edge/Chrome.
describe('real walkthrough with Playwright', async () => {
  let browserAvailable = false;
  for (const channel of ['msedge', 'chrome'] as const) {
    try {
      await (await chromium.launch({ channel, headless: true })).close();
      browserAvailable = true;
      break;
    } catch {
      // try the next one
    }
  }

  let server: http.Server;
  let baseUrl = '';
  const seenLogins: string[] = [];
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      res.setHeader('Content-Type', 'text/html');
      if (url.pathname === '/login' && req.method === 'POST') {
        let body = '';
        req.on('data', (d) => (body += d));
        req.on('end', () => {
          const form = new URLSearchParams(body);
          seenLogins.push(`${form.get('email')}:${form.get('password')}`);
          res.end(
            /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.get('email') ?? '')
              ? '<h1>Welcome back</h1>'
              : '<p role="alert">Enter a valid email address</p>',
          );
        });
        return;
      }
      res.end(
        `<form method="post" action="/login"><label>Email <input name="email"></label><label>Password <input name="password" type="password"></label><button>Sign in</button></form>`,
      );
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server?.close());

  it.skipIf(!browserAvailable)(
    'runs Claude’s steps, fills keychain credentials, screenshots, and passes',
    async () => {
      const db = await createTestDb();
      const profileId = await createProfile(db, { name: 'Client' });
      await updateProfile(db, profileId, {
        settings: parseProfileSettings({
          claude: { approvedForClient: true },
          gitlab: {
            projects: [
              {
                id: '7',
                path: 'acme/x',
                verification: { baseUrl, testCredentialsSecret: 'test-credentials:7' },
              },
            ],
          },
        }),
      });
      const secrets = new MemorySecretStore();
      await secrets.set(
        profileId,
        'test-credentials:7',
        JSON.stringify({ username: 'qa@example.com', password: 'pw-123' }),
      );

      const issue: IssueDetail = {
        key: 'X-1',
        summary: 'Validate email on login',
        status: 'Done',
        statusCategory: 'done',
        priority: null,
        rank: null,
        issueType: 'Bug',
        url: 'https://jira.example.test/browse/X-1',
        inOpenSprint: true,
        updatedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        description: '',
        acceptanceCriteria: ['Invalid emails show an error', 'Valid users can sign in'],
        comments: [],
      };
      const mr = {
        ref: { projectId: '7', iid: 3 },
        projectPath: 'acme/x',
        title: 'X-1 Validate',
        state: 'merged',
        webUrl: 'https://gitlab.example.test/acme/x/-/merge_requests/3',
        pipelineStatus: 'success',
        updatedAt: issue.updatedAt,
        mergedAt: issue.updatedAt,
        linesAdded: 1,
        linesRemoved: 0,
        targetBranch: 'main',
        sourceBranch: 'feature/X-1',
      } as MergeRequest;
      await replaceSyncedData(db, profileId, {
        issues: [issue],
        mergeRequests: [{ mr, isMine: true, isReviewer: false, needsMyReview: false }],
        links: [{ mrKey: '7!3', links: [{ issueKey: 'X-1', source: 'title' }] }],
      });

      const walkthrough = {
        title: 'Login validation',
        steps: [
          { action: 'goto', path: '/login' },
          { action: 'fill', selector: 'input[name=email]', value: 'jo@' },
          { action: 'click', text: 'Sign in' },
          { action: 'expectText', text: 'Enter a valid email address' },
          { action: 'screenshot', caption: 'Invalid email is rejected' },
          { action: 'goto', path: '/login' },
          { action: 'fill', selector: 'input[name=email]', value: '{{TEST_USER}}' },
          { action: 'fill', selector: 'input[name=password]', value: '{{TEST_PASSWORD}}' },
          { action: 'click', text: 'Sign in' },
          { action: 'expectText', text: 'Welcome back' },
          { action: 'screenshot', caption: 'A valid user signs in' },
        ],
      };
      const prompts: string[] = [];
      const runner = (): AgentRunner => ({
        id: 'fake',
        detect: async () => {
          throw new Error('unused');
        },
        async *run(req): AsyncIterable<AgentEvent> {
          prompts.push(req.prompt);
          const answer = req.preset.label.startsWith('Verification')
            ? walkthrough
            : {
                criteria: issue.acceptanceCriteria.map((text) => ({
                  text,
                  result: 'verified',
                  note: 'seen in walkthrough',
                })),
                summary: 'Both paths work.',
              };
          yield { type: 'init', sessionId: 's', model: 'm', tools: [] };
          yield {
            type: 'result',
            sessionId: 's',
            isError: false,
            subtype: 'success',
            resultText: JSON.stringify(answer),
            numTurns: 1,
            durationMs: 1,
            models: ['m'],
            usage: {
              inputTokens: 1,
              outputTokens: 1,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
              costUsd: 0.001,
            },
          };
        },
      });

      const id = await createVerification(db, { profileId, issueKey: 'X-1', mrKey: null });
      await executeVerification(
        db,
        { profileId, artifactId: id, mode: 'ui', rerun: false },
        { fixturesDir, blobs, secrets, runner },
      );

      const row = (await getVerification(db, id))!;
      expect(row.error).toBeNull();
      expect(row).toMatchObject({ status: 'passed', mode: 'ui' });
      expect(seenLogins).toEqual(['jo@:', 'qa@example.com:pw-123']);
      // Credentials reach the browser, never a prompt or the slideshow.
      expect(prompts.join('\n')).not.toContain('pw-123');
      expect(prompts[0]).toContain('{{TEST_USER}}');
      const page = await html(db, id);
      expect(page).not.toContain('pw-123');
      expect(page.match(/data:image\/png;base64,/g)).toHaveLength(2);
      expect(page).toContain('Fill input[name=password] with ••••');
      // Both Claude calls are ordinary runs with usage.
      expect((await listRecentRuns(db, profileId)).map((r) => r.preset).sort()).toEqual([
        'short-text',
        'verification-script',
      ]);

      // Re-running the saved walkthrough needs no Claude for the script.
      prompts.length = 0;
      const again = await createVerification(db, { profileId, issueKey: 'X-1', mrKey: null });
      await executeVerification(
        db,
        { profileId, artifactId: again, mode: 'ui', rerun: true },
        { fixturesDir, blobs, secrets, runner },
      );
      expect(await getVerification(db, again)).toMatchObject({ status: 'passed' });
      expect(prompts).toHaveLength(1); // the assessment only
    },
    60_000,
  );

  it.skipIf(!browserAvailable)(
    'captures "before" screenshots from the target branch beside the change’s',
    async () => {
      // A free port, then an app whose page differs between main and the MR branch.
      const port = await new Promise<number>((resolve) => {
        const s = http.createServer().listen(0, '127.0.0.1', () => {
          const p = (s.address() as AddressInfo).port;
          s.close(() => resolve(p));
        });
      });
      const app = (text: string) =>
        `require('http').createServer((q,r)=>{r.setHeader('Content-Type','text/html');r.end('<h1>${text}</h1>')}).listen(${port},'127.0.0.1')`;
      const { clone } = gitRepo();
      const git = (...args: string[]) =>
        execFileSync('git', args, {
          cwd: clone,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      writeFileSync(path.join(clone, 'server.js'), app('Old page'));
      git('add', '.');
      git('-c', 'user.email=a@example.com', '-c', 'user.name=A', 'commit', '-m', 'old');
      git('push', 'origin', 'main');
      git('checkout', '-b', 'feature/X-4');
      writeFileSync(path.join(clone, 'server.js'), app('New page'));
      git('-c', 'user.email=a@example.com', '-c', 'user.name=A', 'commit', '-am', 'new');
      git('push', 'origin', 'feature/X-4');
      git('checkout', 'main'); // the user's clone is on main; tab-enter uses worktrees

      const db = await createTestDb();
      const profileId = await createProfile(db, { name: 'Client' });
      await updateProfile(db, profileId, {
        settings: parseProfileSettings({
          claude: { approvedForClient: true },
          verification: { captureBefore: true },
          gitlab: {
            projects: [
              {
                id: '7',
                path: 'acme/x',
                localPath: clone,
                verification: {
                  baseUrl: `http://127.0.0.1:${port}`,
                  startCommand: 'node server.js',
                },
              },
            ],
          },
        }),
      });
      await seed(db, profileId, doneIssue('X-4', ['Shows the new page']), {
        ...mergedMR(6, 'X-4'),
        state: 'opened',
        mergedAt: null,
      });

      const runner = (): AgentRunner => ({
        id: 'fake',
        detect: async () => {
          throw new Error('unused');
        },
        async *run(req): AsyncIterable<AgentEvent> {
          const answer = req.preset.label.startsWith('Verification')
            ? {
                title: 'New page',
                steps: [
                  { action: 'goto', path: '/' },
                  { action: 'screenshot', caption: 'Home page' },
                  { action: 'expectText', text: 'New page' },
                ],
              }
            : { criteria: [{ text: 'Shows the new page', result: 'verified', note: 'seen' }] };
          yield {
            type: 'result',
            sessionId: 's',
            isError: false,
            subtype: 'success',
            resultText: JSON.stringify(answer),
            numTurns: 1,
            durationMs: 1,
            models: ['m'],
            usage: {
              inputTokens: 1,
              outputTokens: 1,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
              costUsd: 0,
            },
          };
        },
      });

      const id = await createVerification(db, { profileId, issueKey: 'X-4', mrKey: null });
      await executeVerification(
        db,
        { profileId, artifactId: id, mode: 'ui', rerun: false },
        { fixturesDir, blobs, runner },
      );
      const row = (await getVerification(db, id))!;
      expect(row.error).toBeNull();
      expect(row.status).toBe('passed'); // the "before" run failing its check doesn't count
      const page = await html(db, id);
      expect(page).toContain('Before (target branch)');
      expect(page.match(/data:image\/png;base64,/g)).toHaveLength(2);
    },
    120_000,
  );

  it.skipIf(!browserAvailable)(
    'smoke-checks the UI pages a backend change maps to, with coverage from GitLab',
    async () => {
      const db = await createTestDb();
      const profileId = await createProfile(db, { name: 'Client' });
      const settings = parseProfileSettings({
        gitlab: {
          baseUrl: 'https://gitlab.example.com',
          projects: [
            {
              id: '7',
              path: 'acme/x',
              verification: { baseUrl, uiPages: 'api/** => /login\nweb/** => /never' },
            },
          ],
        },
      });
      await updateProfile(db, profileId, { settings });
      await seed(
        db,
        profileId,
        doneIssue('X-3', ['Orders API returns totals']),
        mergedMR(5, 'X-3'),
      );
      const store = new MemorySecretStore();
      await store.set(profileId, SECRET_NAMES.gitlabToken, 'g');
      const { fetch } = fakeFetch(({ url }) => {
        const p = url.pathname.replace('/api/v4', '');
        if (p === '/projects/7/merge_requests/5')
          return {
            body: {
              iid: 5,
              project_id: 7,
              title: 'X-3 change',
              state: 'merged',
              source_branch: 'feature/X-3',
              target_branch: 'main',
              web_url: 'https://gitlab.example.com/acme/x/-/merge_requests/5',
              references: { full: 'acme/x!5' },
              head_pipeline: { id: 90, status: 'success' },
            },
          };
        if (p === '/projects/7/merge_requests/5/diffs')
          return { body: [{ new_path: 'api/orders.go', diff: '+total := sum(lines)' }] };
        if (p === '/projects/7/pipelines/90') return { body: { coverage: '72.5' } };
        if (p === '/projects/7/pipelines') return { body: [{ id: 80 }] };
        if (p === '/projects/7/pipelines/80') return { body: { coverage: '71.0' } };
        if (p.endsWith('/approvals') || p.endsWith('/discussions')) return { body: [] };
        return undefined;
      });

      const id = await createVerification(db, { profileId, issueKey: 'X-3', mrKey: null });
      await executeVerification(
        db,
        { profileId, artifactId: id, mode: 'auto', rerun: false },
        {
          fixturesDir,
          blobs,
          fetch,
          credentials: new PatCredentialProvider(store, async () => settings),
        },
      );

      const row = (await getVerification(db, id))!;
      // Backend change with no tests: still "needs coverage", now with UI evidence attached.
      expect(row).toMatchObject({ mode: 'backend', status: 'needs_coverage', error: null });
      const page = await html(db, id);
      expect(page).toContain('UI smoke check');
      expect(page).toContain('Smoke check: /login');
      expect(page).not.toContain('/never');
      expect(page.match(/data:image\/png;base64,/g)).toHaveLength(1);
      expect(page).toContain('Coverage: <strong>72.5%</strong>');
      expect(page).toContain('+1.5');
    },
    60_000,
  );
});
