import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { findOnPath, runCommand, type RunCommand } from '@tab-enter/claude';
import type { WatchedProject } from '@tab-enter/core';
import { getMergeRequest, getProfileDir, listIssues, type Db, type Profile } from '@tab-enter/db';
import { branchNameFor, ensureWorktree, type Worktree } from './worktree';

// Where a run (or an interactive terminal) works: the git worktree for its
// ticket or MR. Demo profiles get a scratch folder instead.

export interface WorkTarget {
  issueKey: string | null;
  mrKey: string | null;
  projectId: string | null;
}

export class WorkspaceError extends Error {}

export interface WorkspaceDeps {
  run?: RunCommand;
  findGit?: () => Promise<string | null>;
}

function findProject(profile: Profile, projectId: string | null, projectPath?: string) {
  const projects = profile.settings.gitlab.projects;
  if (projectId || projectPath) {
    return projects.find((p) => p.id === projectId || (projectPath && p.path === projectPath));
  }
  const withClone = projects.filter((p) => p.localPath);
  return withClone.length === 1 ? withClone[0] : undefined;
}

function needsClone(project: WatchedProject | undefined, label: string): string {
  if (!project) {
    throw new WorkspaceError(
      `No watched project for ${label}. Add it under Settings → Connections → Watched projects, with "= <local clone path>".`,
    );
  }
  if (!project.localPath) {
    throw new WorkspaceError(
      `Set a local clone path for ${project.path || project.id} in Settings → Watched projects ("${project.path || project.id} = C:\\path\\to\\clone").`,
    );
  }
  return project.localPath;
}

export async function resolveWorkspace(
  db: Db,
  profile: Profile,
  target: WorkTarget,
  deps: WorkspaceDeps = {},
): Promise<Worktree & { projectId: string | null }> {
  if (profile.isDemo) {
    const cwd = path.join(getProfileDir(profile.id), 'demo-workspace');
    await mkdir(cwd, { recursive: true });
    return { cwd, branch: 'demo', warnings: [], projectId: target.projectId };
  }

  const gitPath = await (deps.findGit ?? (() => findOnPath('git')))();
  if (!gitPath) throw new WorkspaceError('git was not found on PATH.');
  const run = deps.run ?? runCommand;

  if (target.mrKey) {
    const mr = await getMergeRequest(db, profile.id, target.mrKey);
    if (!mr) throw new WorkspaceError(`Merge request ${target.mrKey} isn't in the synced data.`);
    const project = findProject(profile, mr.ref.projectId, mr.projectPath);
    const clonePath = needsClone(project, mr.projectPath);
    const wt = await ensureWorktree(run, gitPath, {
      clonePath,
      key: target.issueKey ?? `mr-${mr.ref.iid}`,
      branch: mr.sourceBranch,
    });
    return { ...wt, projectId: mr.ref.projectId };
  }

  if (!target.issueKey) throw new WorkspaceError('A run needs a ticket or a merge request.');
  const project = findProject(profile, target.projectId);
  const clonePath = needsClone(
    project,
    target.projectId ?? 'this ticket (pick the project when several are watched)',
  );
  const issue = (await listIssues(db, profile.id)).find((i) => i.key === target.issueKey);
  const wt = await ensureWorktree(run, gitPath, {
    clonePath,
    key: target.issueKey,
    newBranch: branchNameFor(target.issueKey, issue?.summary ?? ''),
  });
  return { ...wt, projectId: project?.id ?? target.projectId };
}
