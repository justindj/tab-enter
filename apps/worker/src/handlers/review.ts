import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { findOnPath, runCommand } from '@tab-enter/claude';
import { DemoCodeHost, type DemoGitLabFixture } from '@tab-enter/connectors';
import { assembleDiff, buildReviewPrompt, splitGitDiff, type ReviewFinding } from '@tab-enter/core';
import {
  getMergeRequest,
  listCodeReviews,
  listIssues,
  type Db,
  type Profile,
  type RunRow,
} from '@tab-enter/db';
import type { WorkspaceDeps } from '../workspace';

// Builds a code-review prompt from the MR's diff. Real profiles diff the
// reviewer's worktree (fast-forwarded to the MR head); a re-review diffs only
// what changed since the last reviewed commit, when that commit is known.

export interface PreparedReview {
  prompt: string;
  headSha: string;
  incrementalFrom: string | null;
  excludedFiles: string[];
  truncated: boolean;
  notes: string[];
}

const MAX_DIFF_BYTES = 20 * 1024 * 1024;

export async function prepareReview(
  db: Db,
  profile: Profile,
  run: RunRow,
  cwd: string,
  deps: WorkspaceDeps & { fixturesDir: string },
): Promise<PreparedReview> {
  const mr = await getMergeRequest(db, profile.id, run.mrKey!);
  if (!mr)
    throw new Error(`Merge request ${run.mrKey} isn't in the synced data. Refresh and retry.`);
  const issueKey = run.issueKey;
  const issue = issueKey
    ? (await listIssues(db, profile.id)).find((i) => i.key === issueKey)
    : undefined;
  const settings = profile.settings;
  const notes: string[] = [];

  // The last review that produced a usable result, for incremental re-reviews.
  const previous = (await listCodeReviews(db, profile.id, run.mrKey!)).find((r) => r.result.review);

  let files: { path: string; diff: string }[];
  let headSha = mr.headSha;
  let incrementalFrom: string | null = null;

  if (profile.isDemo) {
    const fixture = JSON.parse(
      await readFile(path.join(deps.fixturesDir, 'demo/gitlab.json'), 'utf8'),
    ) as DemoGitLabFixture;
    files = (await new DemoCodeHost(fixture).getMRDetail(mr.ref)).diff;
    if (previous) notes.push('Demo: no git history, so this re-review covers the whole diff.');
  } else {
    const git = await (deps.findGit ?? (() => findOnPath('git')))();
    if (!git) throw new Error('git was not found on PATH.');
    const run_ = deps.run ?? runCommand;
    const g = (args: string[], timeoutMs = 60_000) =>
      run_(git, ['-C', cwd, ...args], { timeoutMs });

    const fetch = await g(
      ['fetch', '--quiet', 'origin', mr.sourceBranch, mr.targetBranch],
      120_000,
    );
    if (fetch.code !== 0)
      notes.push(`git fetch failed, reviewing local refs: ${fetch.stderr.trim().slice(0, 200)}`);
    const ff = await g(['merge', '--ff-only', '--quiet', `origin/${mr.sourceBranch}`]);
    if (ff.code !== 0) {
      notes.push(
        'Could not fast-forward the review worktree to the MR head (local commits?); reviewing its current HEAD.',
      );
    }
    headSha = (await g(['rev-parse', 'HEAD'])).stdout.trim() || mr.headSha;
    if (mr.headSha && headSha !== mr.headSha) {
      notes.push(
        `The worktree is at ${headSha.slice(0, 12)}, GitLab reports ${mr.headSha.slice(0, 12)}. Refresh if the MR just changed.`,
      );
    }

    let base = `origin/${mr.targetBranch}...HEAD`;
    if (previous && previous.reviewedSha !== headSha) {
      const known = await g(['cat-file', '-e', `${previous.reviewedSha}^{commit}`]);
      if (known.code === 0) {
        base = `${previous.reviewedSha}..HEAD`;
        incrementalFrom = previous.reviewedSha;
      } else {
        notes.push(
          'The previously reviewed commit is gone (force-push?); reviewing the whole diff.',
        );
      }
    }
    const diff = await g(['diff', '--no-color', '--no-ext-diff', '--find-renames', base], 120_000);
    if (diff.code !== 0) throw new Error(`git diff failed: ${diff.stderr.trim().slice(0, 300)}`);
    if (diff.stdout.length > MAX_DIFF_BYTES)
      notes.push('The diff is very large; only part of it is sent.');
    files = splitGitDiff(diff.stdout.slice(0, MAX_DIFF_BYTES));
  }

  const assembled = assembleDiff(
    files,
    settings.reviewExcludeGlobs,
    settings.contextCaps.diffChars,
  );
  const previousBlockers: ReviewFinding[] = previous?.result.review?.blockers ?? [];
  const prompt = buildReviewPrompt({
    mr,
    issue,
    diff: assembled.diff,
    truncated: assembled.truncated,
    excludedFiles: assembled.excludedFiles,
    previous: incrementalFrom ? { sha: incrementalFrom, blockers: previousBlockers } : null,
    caps: settings.contextCaps,
  });
  return {
    prompt,
    headSha,
    incrementalFrom,
    excludedFiles: assembled.excludedFiles,
    truncated: assembled.truncated,
    notes,
  };
}
