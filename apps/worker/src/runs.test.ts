import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReplayRunner, runCommand } from '@tab-enter/claude';
import { DEFAULT_PRESETS, parseProfileSettings, type AgentEvent } from '@tab-enter/core';
import {
  createProfile,
  createRun,
  ensureDemoProfile,
  getActiveProfile,
  getRun,
  listRunEvents,
  requestRunCancel,
  updateProfile,
  usageSummary,
} from '@tab-enter/db';
import { createTestDb } from '@tab-enter/db/test-support';
import { beforeAll, describe, expect, it } from 'vitest';
import { executeRun } from './handlers/agent-run';
import { claudeCommand, terminalLaunch } from './handlers/open-terminal';
import { RunPool } from './worker';
import { branchNameFor, ensureWorktree, parseWorktreeList, worktreePath } from './worktree';

const fixturesDir = fileURLToPath(new URL('../../../fixtures', import.meta.url));
const replay = (delayMs = 0) =>
  new ReplayRunner({
    taskFixture: path.join(fixturesDir, 'claude/work-ticket.stream.jsonl'),
    analysisFixture: path.join(fixturesDir, 'claude/code-review.result.json'),
    delayMs,
  });

process.env.TAB_ENTER_HOME = mkdtempSync(path.join(os.tmpdir(), 'tab-enter-home-'));

async function demoRun(prompt = 'Fix SHOP-101') {
  const db = await createTestDb();
  await ensureDemoProfile(db);
  const profile = (await getActiveProfile(db))!;
  const runId = await createRun(db, {
    profileId: profile.id,
    preset: 'work-ticket',
    prompt,
    modelRequested: 'sonnet',
    issueKey: 'SHOP-101',
  });
  return { db, profile, runId };
}

describe('executeRun', () => {
  it('streams a demo run into run_events and records session, usage and files', async () => {
    const { db, runId } = await demoRun();
    await executeRun(db, runId, { fixturesDir, runner: () => replay(), pollMs: 20 });

    const run = (await getRun(db, runId))!;
    expect(run).toMatchObject({
      status: 'succeeded',
      sessionId: '5f0c1d2e-0000-4000-8000-000000000001',
      modelUsed: 'claude-sonnet-5-5',
      costUsd: 0.0842,
      outputTokens: 620,
      numTurns: 6,
      error: null,
    });
    expect(run.diffSummary?.filesChanged).toEqual([
      '/work/acme-shop/src/login/validate.ts',
      '/work/acme-shop/src/login/validate.test.ts',
    ]);
    expect(run.cwd).toMatch(/demo-workspace$/);

    const events = await listRunEvents(db, runId);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
    expect(events[0]!.event.type).toBe('init');
    expect(events.at(-1)!.event.type).toBe('result');
    expect((await listRunEvents(db, runId, events.length - 2)).length).toBe(1);
  });

  it('continues a run in the same session and folder', async () => {
    const { db, profile, runId } = await demoRun();
    await executeRun(db, runId, { fixturesDir, runner: () => replay(), pollMs: 20 });
    const parent = (await getRun(db, runId))!;

    const childId = await createRun(db, {
      profileId: profile.id,
      preset: 'work-ticket',
      prompt: 'Also handle uppercase',
      modelRequested: 'sonnet',
      parentRunId: runId,
    });
    let resumed: string | undefined;
    await executeRun(db, childId, {
      fixturesDir,
      pollMs: 20,
      runner: () => ({
        id: 'spy',
        detect: async () => {
          throw new Error('unused');
        },
        async *run(req) {
          resumed = req.resumeSessionId;
          yield* replay().run(req, new AbortController().signal);
        },
      }),
    });
    const child = (await getRun(db, childId))!;
    expect(resumed).toBe(parent.sessionId);
    expect(child).toMatchObject({ cwd: parent.cwd, issueKey: 'SHOP-101', parentRunId: runId });
  });

  it('cancels a running run when asked', async () => {
    const { db, runId } = await demoRun();
    const running = executeRun(db, runId, { fixturesDir, runner: () => replay(50), pollMs: 20 });
    await new Promise((r) => setTimeout(r, 120));
    await requestRunCancel(db, runId);
    await running;
    const run = (await getRun(db, runId))!;
    expect(run.status).toBe('cancelled');
    expect(run.endedAt).toBeInstanceOf(Date);
  });

  it('cancels a queued run without starting it', async () => {
    const { db, runId } = await demoRun();
    await requestRunCancel(db, runId);
    let started = false;
    await executeRun(db, runId, {
      fixturesDir,
      runner: () => {
        started = true;
        return replay();
      },
    });
    expect(started).toBe(false);
    expect((await getRun(db, runId))!.status).toBe('cancelled');
  });

  it('refuses to run for a client that has not approved Claude Code', async () => {
    const db = await createTestDb();
    const profileId = await createProfile(db, { name: 'Client' });
    const runId = await createRun(db, {
      profileId,
      preset: 'work-ticket',
      prompt: 'x',
      modelRequested: 'sonnet',
      issueKey: 'ABC-1',
    });
    await executeRun(db, runId, { fixturesDir, runner: () => replay() });
    expect(await getRun(db, runId)).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('not approved'),
    });
  });

  it('redacts secrets that appear in the stream', async () => {
    const { db, runId } = await demoRun();
    await executeRun(db, runId, {
      fixturesDir,
      runner: () => ({
        id: 'leaky',
        detect: async () => {
          throw new Error('unused');
        },
        async *run(): AsyncIterable<AgentEvent> {
          yield { type: 'text', text: 'found glpat-abcdefghijklmnopqrstuvwx in .env' };
        },
      }),
    });
    const [ev] = await listRunEvents(db, runId);
    expect(JSON.stringify(ev!.event)).not.toContain('glpat-abcdefghijklmnopqrstuvwx');
    expect((await getRun(db, runId))!.status).toBe('failed'); // no result event
  });

  it('adds runs to usage totals', async () => {
    const { db, profile, runId } = await demoRun();
    await executeRun(db, runId, { fixturesDir, runner: () => replay(), pollMs: 20 });
    const usage = await usageSummary(db, profile.id, new Date(Date.now() - 86_400_000));
    expect(usage.total).toMatchObject({ runs: 1, costUsd: 0.0842, outputTokens: 620 });
    expect(usage.today.runs).toBe(1);
    expect(usage.byPreset[0]).toMatchObject({ key: 'work-ticket', runs: 1 });
    expect(usage.byTicket[0]).toMatchObject({ key: 'SHOP-101' });
  });
});

describe('RunPool', () => {
  it('runs at most maxParallelRuns per profile at once', async () => {
    const db = await createTestDb();
    await ensureDemoProfile(db);
    const profile = (await getActiveProfile(db))!;
    await updateProfile(db, profile.id, {
      settings: parseProfileSettings({ claude: { maxParallelRuns: 1 } }),
    });
    for (let i = 0; i < 2; i++) {
      await createRun(db, {
        profileId: profile.id,
        preset: 'work-ticket',
        prompt: `run ${i}`,
        modelRequested: 'sonnet',
        issueKey: 'SHOP-101',
      });
    }
    const pool = new RunPool(db, {
      fixturesDir,
      log: () => {},
      run: { runner: () => replay(5), pollMs: 20 },
    });
    await pool.fill();
    expect(pool.size).toBe(1);
    await pool.drain();
    await pool.fill();
    expect(pool.size).toBe(1);
    await pool.drain();
  });
});

describe('worktrees', () => {
  let origin: string;
  let clone: string;
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  beforeAll(() => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'tab-enter-git-'));
    origin = path.join(root, 'origin.git');
    clone = path.join(root, 'shop');
    git(root, 'init', '--bare', '--initial-branch=main', origin);
    git(root, 'clone', origin, clone);
    git(clone, 'config', 'user.email', 'test@example.com');
    git(clone, 'config', 'user.name', 'Test');
    writeFileSync(path.join(clone, 'README.md'), 'hi\n');
    git(clone, 'add', '.');
    git(clone, 'commit', '-m', 'init');
    git(clone, 'push', 'origin', 'main');
    git(clone, 'push', 'origin', 'main:feature/ABC-2-existing');
    git(clone, 'remote', 'set-head', 'origin', 'main');
  });

  it('creates a new branch worktree from the default branch, beside the clone', async () => {
    const wt = await ensureWorktree(runCommand, 'git', {
      clonePath: clone,
      key: 'ABC-1',
      newBranch: branchNameFor('ABC-1', 'Fix the login: validation!'),
    });
    expect(wt.branch).toBe('feature/ABC-1-fix-the-login-validation');
    expect(path.resolve(wt.cwd)).toBe(worktreePath(clone, 'ABC-1'));
    expect(wt.cwd).toContain('.tab-enter-worktrees');
    expect(git(wt.cwd, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(wt.branch);
    // The user's checkout is untouched.
    expect(git(clone, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main');

    const again = await ensureWorktree(runCommand, 'git', {
      clonePath: clone,
      key: 'ABC-1',
      newBranch: wt.branch,
    });
    expect(path.resolve(again.cwd)).toBe(path.resolve(wt.cwd));
  });

  it('checks out an MR branch from origin, and reuses it under another key', async () => {
    const wt = await ensureWorktree(runCommand, 'git', {
      clonePath: clone,
      key: 'mr-7',
      branch: 'feature/ABC-2-existing',
    });
    expect(git(wt.cwd, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('feature/ABC-2-existing');
    const reused = await ensureWorktree(runCommand, 'git', {
      clonePath: clone,
      key: 'ABC-2',
      branch: 'feature/ABC-2-existing',
    });
    expect(path.resolve(reused.cwd)).toBe(path.resolve(wt.cwd));
  });

  it('refuses a branch checked out in the user’s own clone', async () => {
    await expect(
      ensureWorktree(runCommand, 'git', { clonePath: clone, key: 'x', branch: 'main' }),
    ).rejects.toThrow(/checked out in/);
  });

  it('refuses odd branch names and non-repositories', async () => {
    await expect(
      ensureWorktree(runCommand, 'git', { clonePath: clone, key: 'x', branch: '--upload-pack=x' }),
    ).rejects.toThrow(/unusual branch/i);
    await expect(
      ensureWorktree(runCommand, 'git', { clonePath: os.tmpdir(), key: 'x', newBranch: 'a' }),
    ).rejects.toThrow(/not a git repository/);
  });

  it('parses git worktree list output', () => {
    expect(
      parseWorktreeList(
        'worktree /code/shop\nHEAD abc\nbranch refs/heads/main\n\nworktree /code/x\nHEAD def\ndetached\n',
      ),
    ).toEqual([
      { path: '/code/shop', branch: 'main' },
      { path: '/code/x', branch: null },
    ]);
  });
});

describe('terminal launch', () => {
  const find = (have: string[]) => async (name: string) =>
    have.includes(name) ? `/bin/${name}` : null;

  it('prefers Windows Terminal, resuming the session', async () => {
    expect(
      await terminalLaunch('C:\\wt\\ABC-1', claudeCommand('s-1'), 'win32', find(['wt'])),
    ).toEqual({ file: '/bin/wt', args: ['-d', 'C:\\wt\\ABC-1', 'claude', '--resume', 's-1'] });
  });

  it('uses Terminal.app on macOS and refuses unsafe paths', async () => {
    const mac = await terminalLaunch('/w/ABC-1', claudeCommand(null), 'darwin', find([]));
    expect(mac.args[1]).toContain(`cd '/w/ABC-1' && claude`);
    await expect(terminalLaunch(`/w/a'b`, ['claude'], 'darwin', find([]))).rejects.toThrow(
      /Unusual characters/,
    );
  });

  it('explains what to run when no terminal is found', async () => {
    await expect(terminalLaunch('/w/x', ['claude'], 'linux', find([]))).rejects.toThrow(
      /Run this in \/w\/x: claude/,
    );
  });
});

describe('presets', () => {
  it('ships a work-ticket preset the runs above use', () => {
    expect(DEFAULT_PRESETS['work-ticket'].mode).toBe('task');
  });
});
