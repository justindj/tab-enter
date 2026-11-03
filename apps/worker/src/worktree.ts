import { access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { RunCommand } from '@tab-enter/claude';

// One git worktree per ticket (or MR), created next to the user's clone under
// a tab-enter-managed folder: <clone parent>/.tab-enter-worktrees/<repo>/<key>.
// The user's own checkout is never switched or modified. Only `fetch` and
// `worktree add` touch the repository; nothing is ever pushed.

export interface WorktreeRequest {
  /** The user's local clone of the project. */
  clonePath: string;
  /** Folder name for the worktree, e.g. the ticket key or "mr-12". */
  key: string;
  /** Existing branch to check out (an MR's source branch)… */
  branch?: string;
  /** …or a new branch to create from the remote default branch. */
  newBranch?: string;
}

export interface Worktree {
  cwd: string;
  branch: string;
  /** Non-fatal problems, e.g. a fetch that failed while offline. */
  warnings: string[];
}

export class WorktreeError extends Error {}

const SAFE_REF = /^(?!.*\.\.)(?!\/)(?!.*\/$)[A-Za-z0-9._/-]+$/;

export function worktreePath(clonePath: string, key: string): string {
  const safeKey = key.replace(/[^A-Za-z0-9._-]+/g, '-');
  return path.join(
    path.dirname(path.resolve(clonePath)),
    '.tab-enter-worktrees',
    path.basename(path.resolve(clonePath)),
    safeKey,
  );
}

/** "feature/ABC-12-fix-login-validation" from a key and summary. */
export function branchNameFor(issueKey: string, summary: string): string {
  const slug = summary
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return `feature/${issueKey}${slug ? `-${slug}` : ''}`;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * A detached worktree at `origin/<branch>` (e.g. to verify merged work on
 * main), refreshed to the latest remote commit on every call. Never touches
 * a local branch, so it works even when the user's clone has that branch out.
 */
export async function ensureDetachedWorktree(
  run: RunCommand,
  gitPath: string,
  req: { clonePath: string; key: string; remoteBranch: string },
): Promise<Worktree> {
  const warnings: string[] = [];
  const git = (cwd: string, args: string[], timeoutMs = 60_000) =>
    run(gitPath, ['-C', cwd, ...args], { timeoutMs });
  if (!SAFE_REF.test(req.remoteBranch)) {
    throw new WorktreeError(`Refusing an unusual branch name: ${req.remoteBranch}`);
  }
  if ((await git(req.clonePath, ['rev-parse', '--show-toplevel'])).code !== 0) {
    throw new WorktreeError(`${req.clonePath} is not a git repository.`);
  }
  const fetch = await git(req.clonePath, ['fetch', '--quiet', 'origin', req.remoteBranch], 120_000);
  if (fetch.code !== 0)
    warnings.push(`git fetch failed, using local refs: ${fetch.stderr.trim().slice(0, 300)}`);
  const ref = `origin/${req.remoteBranch}`;
  const dir = worktreePath(req.clonePath, req.key);
  const result = (await exists(dir))
    ? await git(dir, ['checkout', '--quiet', '--detach', ref])
    : (await mkdir(path.dirname(dir), { recursive: true }),
      await git(req.clonePath, ['worktree', 'add', '--detach', dir, ref]));
  if (result.code !== 0) {
    throw new WorktreeError(`Could not check out ${ref}: ${result.stderr.trim().slice(0, 400)}`);
  }
  return { cwd: dir, branch: ref, warnings };
}

export async function ensureWorktree(
  run: RunCommand,
  gitPath: string,
  req: WorktreeRequest,
): Promise<Worktree> {
  const warnings: string[] = [];
  const git = async (cwd: string, args: string[], timeoutMs = 30_000) =>
    run(gitPath, ['-C', cwd, ...args], { timeoutMs });

  const branch = req.branch ?? req.newBranch;
  if (!branch || !SAFE_REF.test(branch)) {
    throw new WorktreeError(`Refusing an unusual branch name: ${branch ?? '(none)'}`);
  }
  const top = await git(req.clonePath, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0) {
    throw new WorktreeError(
      `${req.clonePath} is not a git repository. Check the local clone path in Settings → Watched projects.`,
    );
  }

  // A branch can only be checked out once: reuse our worktree that has it.
  const list = await git(req.clonePath, ['worktree', 'list', '--porcelain']);
  const owner = parseWorktreeList(list.stdout).find((w) => w.branch === branch);
  if (owner) {
    const ours = path.resolve(owner.path).includes(`${path.sep}.tab-enter-worktrees${path.sep}`);
    if (ours) return { cwd: owner.path, branch, warnings };
    throw new WorktreeError(
      `Branch ${branch} is checked out in ${owner.path}. Switch that checkout to another branch so tab-enter can create a separate worktree.`,
    );
  }

  const dir = worktreePath(req.clonePath, req.key);
  if (await exists(dir)) {
    const head = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (head.code === 0) return { cwd: dir, branch: head.stdout.trim(), warnings };
    throw new WorktreeError(
      `${dir} exists but isn't a working git worktree. Remove it (git worktree prune) and try again.`,
    );
  }
  await mkdir(path.dirname(dir), { recursive: true });

  const fetch = await git(req.clonePath, ['fetch', '--quiet', 'origin'], 120_000);
  if (fetch.code !== 0) {
    warnings.push(`git fetch failed, using local refs: ${fetch.stderr.trim().slice(0, 300)}`);
  }
  const hasLocal =
    (await git(req.clonePath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]))
      .code === 0;

  let add;
  if (hasLocal) {
    add = await git(req.clonePath, ['worktree', 'add', dir, branch], 60_000);
  } else if (req.branch) {
    add = await git(
      req.clonePath,
      ['worktree', 'add', '--track', '-b', branch, dir, `origin/${branch}`],
      60_000,
    );
  } else {
    const base = await defaultBase(git, req.clonePath);
    add = await git(
      req.clonePath,
      ['worktree', 'add', '--no-track', '-b', branch, dir, base],
      60_000,
    );
  }
  if (add.code !== 0) {
    throw new WorktreeError(`git worktree add failed: ${add.stderr.trim().slice(0, 500)}`);
  }
  return { cwd: dir, branch, warnings };
}

/** `git worktree list --porcelain` → paths and their branches (short names). */
export function parseWorktreeList(output: string): { path: string; branch: string | null }[] {
  return output
    .split(/\r?\n\r?\n/)
    .map((block) => {
      const lines = block.split(/\r?\n/);
      const wt = lines.find((l) => l.startsWith('worktree '))?.slice('worktree '.length);
      const ref = lines.find((l) => l.startsWith('branch '))?.slice('branch '.length);
      return wt ? { path: wt, branch: ref ? ref.replace(/^refs\/heads\//, '') : null } : null;
    })
    .filter((w): w is { path: string; branch: string | null } => w !== null);
}

/** origin's default branch (origin/HEAD), falling back to origin/main, then HEAD. */
async function defaultBase(
  git: (cwd: string, args: string[]) => ReturnType<RunCommand>,
  clone: string,
): Promise<string> {
  const head = await git(clone, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (head.code === 0 && head.stdout.trim()) return head.stdout.trim();
  for (const candidate of ['origin/main', 'origin/master']) {
    if ((await git(clone, ['rev-parse', '--verify', '--quiet', candidate])).code === 0) {
      return candidate;
    }
  }
  return 'HEAD';
}
