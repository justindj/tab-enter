import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReplayRunner } from '@tab-enter/claude';
import {
  parseProfileSettings,
  type AgentEvent,
  type AgentRunner,
  type MergeRequest,
} from '@tab-enter/core';
import {
  createProfile,
  createRun,
  ensureDemoProfile,
  getActiveProfile,
  getRun,
  listCodeReviews,
  replaceSyncedData,
  updateProfile,
  type Db,
} from '@tab-enter/db';
import { createTestDb } from '@tab-enter/db/test-support';
import { describe, expect, it } from 'vitest';
import { syncProfile } from './handlers/sync';
import { executeRun } from './handlers/agent-run';

const fixturesDir = fileURLToPath(new URL('../../../fixtures', import.meta.url));
process.env.TAB_ENTER_HOME = mkdtempSync(path.join(os.tmpdir(), 'tab-enter-home-'));

const VALID = JSON.stringify({
  summary: 'Fine.',
  blockers: [{ file: 'src/a.ts', line: 2, reason: 'Off by one.' }],
  suggestions: [],
  questions: [],
  verdict: 'request_changes',
});

/** A fake Claude that answers each prompt with the next reply and records prompts. */
function scripted(replies: string[]) {
  const prompts: { prompt: string; resume?: string }[] = [];
  const runner: AgentRunner = {
    id: 'scripted',
    detect: async () => {
      throw new Error('unused');
    },
    async *run(req): AsyncIterable<AgentEvent> {
      prompts.push({ prompt: req.prompt, resume: req.resumeSessionId });
      yield { type: 'init', sessionId: 'sess-1', model: 'claude-sonnet-5-5', tools: ['Read'] };
      yield {
        type: 'result',
        sessionId: 'sess-1',
        isError: false,
        subtype: 'success',
        resultText: replies.shift() ?? '',
        numTurns: 2,
        durationMs: 10,
        models: ['claude-sonnet-5-5'],
        usage: {
          inputTokens: 100,
          outputTokens: 10,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costUsd: 0.01,
        },
      };
    },
  };
  return { runner, prompts };
}

async function demoReview(db: Db) {
  await ensureDemoProfile(db);
  const profile = (await getActiveProfile(db))!;
  await syncProfile(db, profile.id, { fixturesDir });
  const runId = await createRun(db, {
    profileId: profile.id,
    preset: 'code-review',
    prompt: '(built by the worker)',
    modelRequested: 'sonnet',
    mrKey: '42!21',
    issueKey: 'SHOP-120',
  });
  return { profile, runId };
}

describe('code review runs', () => {
  it('reviews a demo MR: builds the prompt from the diff and stores the structured result', async () => {
    const db = await createTestDb();
    const { profile, runId } = await demoReview(db);
    const replay = new ReplayRunner({
      taskFixture: path.join(fixturesDir, 'claude/work-ticket.stream.jsonl'),
      analysisFixture: path.join(fixturesDir, 'claude/code-review.result.json'),
      delayMs: 0,
    });
    await executeRun(db, runId, { fixturesDir, runner: () => replay, pollMs: 20 });

    const run = (await getRun(db, runId))!;
    expect(run.status).toBe('succeeded');
    expect(run.prompt).toContain('--- src/api/wishlist.ts');
    expect(run.prompt).toContain('Not shown (lockfiles/generated, by config): pnpm-lock.yaml');
    expect(run.prompt).not.toContain('lockfile noise');
    // SHOP-120 is a teammate's ticket, synced only for its acceptance criteria.
    expect(run.prompt).toContain("- Other users' wishlists are never readable");

    const [review] = await listCodeReviews(db, profile.id, '42!21');
    expect(review).toMatchObject({
      runId,
      reviewedSha: '0718293a4b5c6d7e8f9012345678901234567890',
    });
    expect(review!.result.review).toMatchObject({
      verdict: 'request_changes',
      blockers: [{ file: 'src/api/wishlist.ts', line: 4 }],
      questions: [expect.stringContaining('deleted product')],
    });
    expect(review!.result.excludedFiles).toEqual(['pnpm-lock.yaml']);
  });

  it('asks once more in the same session when the reply is not valid JSON', async () => {
    const db = await createTestDb();
    const { profile, runId } = await demoReview(db);
    const { runner, prompts } = scripted(['Looks good to me!', VALID]);
    await executeRun(db, runId, { fixturesDir, runner: () => runner, pollMs: 20 });

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toMatchObject({ resume: 'sess-1' });
    expect(prompts[1]!.prompt).toContain("wasn't valid: no JSON object found");
    const [review] = await listCodeReviews(db, profile.id, '42!21');
    expect(review!.result.review?.blockers).toHaveLength(1);
    // Both answers count towards usage.
    expect(await getRun(db, runId)).toMatchObject({ inputTokens: 200, costUsd: 0.02, numTurns: 4 });
  });

  it('keeps the raw text when the retry is still invalid', async () => {
    const db = await createTestDb();
    const { profile, runId } = await demoReview(db);
    const { runner } = scripted(['nope', 'still nope']);
    await executeRun(db, runId, { fixturesDir, runner: () => runner, pollMs: 20 });
    const [review] = await listCodeReviews(db, profile.id, '42!21');
    expect(review!.result).toMatchObject({ review: null, raw: 'still nope' });
  });
});

describe('incremental re-review against a real git repo', () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

  it('diffs only what changed since the last reviewed commit, with the previous blockers', async () => {
    // origin with main and an MR branch, plus the reviewer's clone
    const root = mkdtempSync(path.join(os.tmpdir(), 'tab-enter-review-'));
    const origin = path.join(root, 'origin.git');
    const author = path.join(root, 'author');
    const clone = path.join(root, 'reviewer');
    git(root, 'init', '--bare', '--initial-branch=main', origin);
    git(root, 'clone', origin, author);
    git(author, 'config', 'user.email', 'a@example.com');
    git(author, 'config', 'user.name', 'A');
    writeFileSync(path.join(author, 'a.ts'), 'export const a = 1;\n');
    git(author, 'add', '.');
    git(author, 'commit', '-m', 'init');
    git(author, 'push', 'origin', 'main');
    git(author, 'checkout', '-b', 'feature/X-1');
    writeFileSync(path.join(author, 'a.ts'), 'export const a = 2;\n');
    writeFileSync(path.join(author, 'pnpm-lock.yaml'), 'lock: 1\n');
    git(author, 'add', '.');
    git(author, 'commit', '-m', 'first');
    git(author, 'push', 'origin', 'feature/X-1');
    const firstSha = git(author, 'rev-parse', 'HEAD');
    git(root, 'clone', origin, clone);

    const db = await createTestDb();
    const profileId = await createProfile(db, { name: 'Client' });
    await updateProfile(db, profileId, {
      settings: parseProfileSettings({
        claude: { approvedForClient: true },
        gitlab: { projects: [{ id: '7', path: 'acme/x', localPath: clone }] },
      }),
    });
    const mr: MergeRequest = {
      ref: { projectId: '7', iid: 3 },
      projectPath: 'acme/x',
      title: 'X-1 Change a',
      description: '',
      sourceBranch: 'feature/X-1',
      targetBranch: 'main',
      state: 'opened',
      draft: false,
      author: 'sam',
      webUrl: 'https://gitlab.example.test/acme/x/-/merge_requests/3',
      detailedMergeStatus: 'not_approved',
      hasConflicts: false,
      pipelineStatus: 'success',
      approvedBy: [],
      approvalsRequired: 1,
      unresolvedThreads: 0,
      changesRequested: false,
      reviewers: ['me'],
      linesAdded: 1,
      linesRemoved: 1,
      headSha: firstSha,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      mergedAt: null,
    };
    const sync = (headSha: string) =>
      replaceSyncedData(db, profileId, {
        issues: [],
        mergeRequests: [
          { mr: { ...mr, headSha }, isMine: false, isReviewer: true, needsMyReview: true },
        ],
        links: [],
      });
    const review = async () => {
      const runId = await createRun(db, {
        profileId,
        preset: 'code-review',
        prompt: '(built by the worker)',
        modelRequested: 'sonnet',
        mrKey: '7!3',
      });
      const { runner, prompts } = scripted([VALID]);
      await executeRun(db, runId, { fixturesDir, runner: () => runner, pollMs: 20 });
      return { run: (await getRun(db, runId))!, prompt: prompts[0]?.prompt ?? '' };
    };

    await sync(firstSha);
    const first = await review();
    expect(first.run.status).toBe('succeeded');
    expect(first.run.cwd).toContain('.tab-enter-worktrees');
    expect(first.prompt).toContain('-export const a = 1;');
    expect(first.prompt).toContain('Not shown (lockfiles/generated, by config): pnpm-lock.yaml');
    expect(first.prompt).not.toContain('re-review');

    // The author pushes a fix; the reviewer re-reviews.
    writeFileSync(path.join(author, 'b.ts'), 'export const b = 3;\n');
    git(author, 'add', '.');
    git(author, 'commit', '-m', 'second');
    git(author, 'push', 'origin', 'feature/X-1');
    const secondSha = git(author, 'rev-parse', 'HEAD');
    await sync(secondSha);

    const second = await review();
    expect(second.prompt).toContain(`since your previous review (commit ${firstSha.slice(0, 12)})`);
    expect(second.prompt).toContain('- src/a.ts:2: Off by one.');
    expect(second.prompt).toContain('+export const b = 3;');
    expect(second.prompt).not.toContain('export const a'); // already reviewed

    const reviews = await listCodeReviews(db, profileId, '7!3');
    expect(reviews.map((r) => [r.reviewedSha, r.result.incrementalFrom])).toEqual([
      [secondSha, firstSha],
      [firstSha, null],
    ]);
  });
});
