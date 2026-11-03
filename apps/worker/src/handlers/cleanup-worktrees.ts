import path from 'node:path';
import { findOnPath, runCommand } from '@tab-enter/claude';
import { mrKey } from '@tab-enter/core';
import {
  getProfile,
  getWorktree,
  listMergeRequests,
  listWorktrees,
  setWorktreeStatus,
  upsertWorktree,
  type Db,
} from '@tab-enter/db';
import type { WorkspaceDeps } from '../workspace';
import { parseWorktreeList } from '../worktree';

// Worktree cleanup (spec section 5): once a branch's MR has merged or closed,
// its tab-enter worktree is removed. A worktree with uncommitted changes or
// commits that aren't on any remote is never removed silently: it is recorded
// as needing confirmation and Settings asks the user. Only worktrees inside
// the tab-enter-managed folder are touched, and local branches are kept.

const MANAGED = /[\\/]\.tab-enter-worktrees[\\/]/;

export async function cleanupWorktrees(
  db: Db,
  profileId: string,
  deps: WorkspaceDeps = {},
): Promise<{ removed: number; needsConfirmation: number }> {
  const result = { removed: 0, needsConfirmation: 0 };
  const profile = await getProfile(db, profileId);
  if (!profile || profile.isDemo) return result;
  const projects = profile.settings.gitlab.projects.filter((p) => p.localPath);
  if (projects.length === 0) return result;
  const gitPath = await (deps.findGit ?? (() => findOnPath('git')))();
  if (!gitPath) return result;
  const run = deps.run ?? runCommand;
  const git = (cwd: string, args: string[]) =>
    run(gitPath, ['-C', cwd, ...args], { timeoutMs: 60_000 });

  const mrs = (await listMergeRequests(db, profileId)).map((m) => m.mr);
  const known = new Map((await listWorktrees(db, profileId)).map((w) => [w.path, w]));

  for (const project of projects) {
    const clonePath = path.resolve(project.localPath!);
    const list = await git(clonePath, ['worktree', 'list', '--porcelain']);
    if (list.code !== 0) continue;
    for (const wt of parseWorktreeList(list.stdout)) {
      const wtPath = path.resolve(wt.path);
      // Detached verification worktrees are reused for every check; leave them.
      if (!MANAGED.test(wtPath) || !wt.branch) continue;
      if (known.get(wtPath)?.status === 'kept') continue;
      const forBranch = mrs.filter(
        (m) =>
          m.sourceBranch === wt.branch &&
          (m.ref.projectId === project.id || (!!project.path && m.projectPath === project.path)),
      );
      if (forBranch.length === 0 || forBranch.some((m) => m.state === 'opened')) continue;
      const done = forBranch.find((m) => m.state === 'merged') ?? forBranch[0]!;

      const status = await git(wtPath, ['status', '--porcelain']);
      const unpushedLog = await git(wtPath, [
        'log',
        '--oneline',
        '--no-decorate',
        '-n',
        '20',
        'HEAD',
        '--not',
        '--remotes',
      ]);
      if (status.code !== 0 || unpushedLog.code !== 0) continue; // missing or broken: leave it
      const uncommitted = status.stdout.split('\n').filter((l) => l.trim()).length;
      const unpushed = unpushedLog.stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      const row = {
        profileId,
        path: wtPath,
        clonePath,
        branch: wt.branch,
        mrKey: mrKey(done.ref),
        reason: done.state,
        uncommitted,
        unpushed,
      };

      if (uncommitted > 0 || unpushed.length > 0) {
        await upsertWorktree(db, { ...row, status: 'needs_confirmation', error: null });
        result.needsConfirmation++;
        continue;
      }
      // No --force: git itself refuses if anything changed since the check.
      const removed = await git(clonePath, ['worktree', 'remove', wtPath]);
      await upsertWorktree(db, {
        ...row,
        status: removed.code === 0 ? 'removed' : 'needs_confirmation',
        error: removed.code === 0 ? null : removed.stderr.trim().slice(0, 400),
      });
      if (removed.code === 0) result.removed++;
      else result.needsConfirmation++;
    }
  }
  return result;
}

/** The user confirmed: remove a worktree even though it has local work. */
export async function removeWorktree(
  db: Db,
  job: { profileId: string; worktreeId: string },
  deps: WorkspaceDeps = {},
): Promise<void> {
  const row = await getWorktree(db, job.worktreeId);
  if (!row || row.profileId !== job.profileId || row.status !== 'needs_confirmation') return;
  if (!MANAGED.test(row.path))
    throw new Error('Refusing to remove a folder tab-enter does not manage.');
  const gitPath = await (deps.findGit ?? (() => findOnPath('git')))();
  if (!gitPath) throw new Error('git is not on PATH.');
  const run = deps.run ?? runCommand;
  const removed = await run(
    gitPath,
    ['-C', row.clonePath, 'worktree', 'remove', '--force', row.path],
    { timeoutMs: 60_000 },
  );
  if (removed.code === 0) await setWorktreeStatus(db, row.id, 'removed');
  else
    await setWorktreeStatus(db, row.id, 'needs_confirmation', removed.stderr.trim().slice(0, 400));
}
