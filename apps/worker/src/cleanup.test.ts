import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCommand } from '@tab-enter/claude';
import { parseProfileSettings, type MergeRequest } from '@tab-enter/core';
import {
  createProfile,
  listWorktrees,
  replaceSyncedData,
  updateProfile,
  type Db,
} from '@tab-enter/db';
import { createTestDb } from '@tab-enter/db/test-support';
import { describe, expect, it } from 'vitest';
import { cleanupWorktrees, removeWorktree } from './handlers/cleanup-worktrees';
import { ensureWorktree } from './worktree';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function repo() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tab-enter-cleanup-'));
  const origin = path.join(root, 'origin.git');
  const clone = path.join(root, 'work');
  git(root, 'init', '--bare', '--initial-branch=main', origin);
  git(root, 'clone', origin, clone);
  for (const [k, v] of [
    ['user.email', 'a@example.com'],
    ['user.name', 'A'],
  ])
    git(clone, 'config', k!, v!);
  writeFileSync(path.join(clone, 'a.txt'), '1\n');
  git(clone, 'add', '.');
  git(clone, 'commit', '-m', 'init');
  git(clone, 'push', 'origin', 'main');
  return clone;
}

const mr = (iid: number, sourceBranch: string, state: MergeRequest['state']): MergeRequest => ({
  ref: { projectId: '42', iid },
  projectPath: 'acme/shop',
  title: `MR ${iid}`,
  description: '',
  sourceBranch,
  targetBranch: 'main',
  state,
  draft: false,
  author: 'dana',
  webUrl: `https://gitlab.example.com/acme/shop/-/merge_requests/${iid}`,
  detailedMergeStatus: 'mergeable',
  hasConflicts: false,
  pipelineStatus: 'success',
  approvedBy: [],
  approvalsRequired: 0,
  unresolvedThreads: 0,
  changesRequested: false,
  reviewers: [],
  linesAdded: 1,
  linesRemoved: 0,
  headSha: 'abc',
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-02T00:00:00Z',
  mergedAt: state === 'merged' ? '2026-11-02T00:00:00Z' : null,
});

async function setup(db: Db, clone: string) {
  const id = await createProfile(db, { name: 'Client' });
  await updateProfile(db, id, {
    settings: parseProfileSettings({
      gitlab: { projects: [{ id: '42', path: 'acme/shop', localPath: clone }] },
    }),
  });
  return id;
}

/** A tab-enter worktree on a new branch with one commit, optionally pushed. */
async function branchWorktree(clone: string, branch: string, push: boolean) {
  const wt = await ensureWorktree(runCommand, 'git', {
    clonePath: clone,
    key: branch,
    newBranch: branch,
  });
  writeFileSync(path.join(wt.cwd, `${branch.replace(/\W/g, '-')}.txt`), 'x\n');
  git(wt.cwd, 'add', '.');
  git(wt.cwd, '-c', 'user.email=a@example.com', '-c', 'user.name=A', 'commit', '-m', branch);
  if (push) git(wt.cwd, 'push', 'origin', branch);
  return wt.cwd;
}

describe('worktree cleanup', () => {
  it('removes clean worktrees of merged MRs and asks about ones with local work', async () => {
    const clone = repo();
    const merged = await branchWorktree(clone, 'feature/A-1', true);
    const unpushed = await branchWorktree(clone, 'feature/A-2', false);
    const open = await branchWorktree(clone, 'feature/A-3', true);
    const dirty = await branchWorktree(clone, 'feature/A-4', true);
    writeFileSync(path.join(dirty, 'a.txt'), 'edited\n');

    const db = await createTestDb();
    const profileId = await setup(db, clone);
    await replaceSyncedData(db, profileId, {
      issues: [],
      links: [],
      mergeRequests: [
        mr(1, 'feature/A-1', 'merged'),
        mr(2, 'feature/A-2', 'merged'),
        mr(3, 'feature/A-3', 'opened'),
        mr(4, 'feature/A-4', 'closed'),
      ].map((m) => ({ mr: m, isMine: true, isReviewer: false, needsMyReview: false })),
    });

    expect(await cleanupWorktrees(db, profileId)).toEqual({ removed: 1, needsConfirmation: 2 });
    expect(existsSync(merged)).toBe(false);
    expect(existsSync(open)).toBe(true);
    expect(existsSync(unpushed)).toBe(true);
    expect(existsSync(dirty)).toBe(true);
    // The local branch (and its commits) survive the worktree.
    expect(git(clone, 'branch', '--list', 'feature/A-1')).toContain('feature/A-1');

    const rows = await listWorktrees(db, profileId);
    const byBranch = Object.fromEntries(rows.map((r) => [r.branch, r]));
    expect(byBranch['feature/A-1']).toMatchObject({ status: 'removed', reason: 'merged' });
    expect(byBranch['feature/A-2']).toMatchObject({
      status: 'needs_confirmation',
      uncommitted: 0,
      unpushed: [expect.stringContaining('feature/A-2')],
    });
    expect(byBranch['feature/A-4']).toMatchObject({
      status: 'needs_confirmation',
      reason: 'closed',
      uncommitted: 1,
    });
    expect(byBranch['feature/A-3']).toBeUndefined();

    // The user confirms one; the worker removes it with --force.
    await removeWorktree(db, { profileId, worktreeId: byBranch['feature/A-4']!.id });
    expect(existsSync(dirty)).toBe(false);
    expect(
      (await listWorktrees(db, profileId)).find((r) => r.branch === 'feature/A-4'),
    ).toMatchObject({ status: 'removed' });
  });

  it('leaves demo profiles and folders outside the managed area alone', async () => {
    const db = await createTestDb();
    const demo = await createProfile(db, { name: 'Demo', isDemo: true });
    expect(await cleanupWorktrees(db, demo)).toEqual({ removed: 0, needsConfirmation: 0 });
  });
});
