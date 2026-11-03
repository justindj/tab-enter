import { z } from 'zod';
import { truncate } from './context';
import type { ProfileSettings } from './settings';
import type { IssueDetail, MergeRequest } from './types';

// Code review with Claude (spec 4.5): the prompt, the structured result Claude
// must return, and how results are turned into text to copy. Approving is
// never automated: the verdict is a recommendation for the human.

export const VERDICTS = ['approve', 'approve_with_comments', 'request_changes'] as const;
export type Verdict = (typeof VERDICTS)[number];

export const VERDICT_LABELS: Record<Verdict, string> = {
  approve: 'Approve',
  approve_with_comments: 'Approve with comments',
  request_changes: 'Request changes',
};

const FindingSchema = z.object({
  file: z.string().optional().nullable(),
  line: z.coerce.number().int().positive().optional().nullable(),
  // Models sometimes say "text" or "comment"; accept them as the reason.
  reason: z.string().min(1),
});

export const ReviewResultSchema = z.preprocess(
  (raw) => {
    if (!raw || typeof raw !== 'object') return raw;
    const fix = (items: unknown) =>
      Array.isArray(items)
        ? items.map((i) =>
            i && typeof i === 'object' && !('reason' in i)
              ? {
                  ...i,
                  reason:
                    (i as { text?: unknown; comment?: unknown }).text ??
                    (i as { comment?: unknown }).comment,
                }
              : i,
          )
        : items;
    const r = raw as Record<string, unknown>;
    return { ...r, blockers: fix(r.blockers), suggestions: fix(r.suggestions) };
  },
  z.object({
    summary: z.string().default(''),
    blockers: z.array(FindingSchema).default([]),
    suggestions: z.array(FindingSchema).default([]),
    questions: z.array(z.string()).default([]),
    verdict: z.enum(VERDICTS),
  }),
);
export type ReviewResult = z.infer<typeof ReviewResultSchema>;
export type ReviewFinding = ReviewResult['blockers'][number];

/** What's stored per review: the parsed result, or the raw text when it never validated. */
export interface StoredReview {
  review: ReviewResult | null;
  raw: string | null;
  error: string | null;
  /** Reviewed only the changes since an earlier review at this commit. */
  incrementalFrom: string | null;
  /** Files left out by the review exclusion globs. */
  excludedFiles: string[];
  truncated: boolean;
}

const JSON_SHAPE = `{
  "summary": "one or two sentences",
  "blockers": [{ "file": "path", "line": 12, "reason": "what must change and why" }],
  "suggestions": [{ "file": "path", "line": 30, "reason": "non-blocking improvement" }],
  "questions": ["question for the author"],
  "verdict": "approve" | "approve_with_comments" | "request_changes"
}`;

export interface ReviewPromptInput {
  mr: Pick<
    MergeRequest,
    'title' | 'description' | 'sourceBranch' | 'targetBranch' | 'webUrl' | 'author'
  >;
  issue?: IssueDetail;
  diff: string;
  truncated: boolean;
  excludedFiles: string[];
  /** Re-review: the previous review's blockers and the commit it covered. */
  previous?: { sha: string; blockers: ReviewFinding[] } | null;
  caps: ProfileSettings['contextCaps'];
}

export function buildReviewPrompt(input: ReviewPromptInput): string {
  const { mr, issue, previous } = input;
  const parts = [
    `You are reviewing merge request "${mr.title}" by ${mr.author} (${mr.webUrl}), branch ${mr.sourceBranch} into ${mr.targetBranch}. The working directory is checked out at the MR's head; read files for context when the diff isn't enough. Do not modify anything.`,
  ];
  if (mr.description.trim()) {
    parts.push(`MR description:\n${truncate(mr.description, 1500)}`);
  }
  if (issue) {
    parts.push(
      `Ticket ${issue.key}: ${issue.summary}\nAcceptance criteria:\n${
        issue.acceptanceCriteria.length
          ? issue.acceptanceCriteria.map((c) => `- ${c}`).join('\n')
          : '(none written)'
      }`,
    );
  }
  if (previous) {
    parts.push(
      `This is a re-review. The diff below is only what changed since your previous review (commit ${previous.sha.slice(0, 12)}). Previous blockers, check whether each is now fixed:\n${
        previous.blockers.length
          ? previous.blockers.map((b) => `- ${formatLocation(b)}${b.reason}`).join('\n')
          : '(none)'
      }`,
    );
  }
  const notes = [
    input.excludedFiles.length
      ? `Not shown (lockfiles/generated, by config): ${input.excludedFiles.slice(0, 20).join(', ')}${input.excludedFiles.length > 20 ? ', …' : ''}.`
      : '',
    input.truncated
      ? `The diff was cut at ${input.caps.diffChars} characters; read the remaining files directly if needed.`
      : '',
  ].filter(Boolean);
  parts.push(
    `Diff:\n\`\`\`diff\n${input.diff || '(empty)'}\n\`\`\`${notes.length ? `\n${notes.join(' ')}` : ''}`,
  );
  parts.push(
    `Blockers are problems that must be fixed before merging (bugs, security, broken acceptance criteria). Suggestions are optional improvements. Questions are things you need the author to clarify. Keep each reason to one or two sentences.\n\nReply with only this JSON object, no prose and no code fence:\n${JSON_SHAPE}`,
  );
  return parts.join('\n\n');
}

/** Follow-up when the answer didn't validate (sent once, in the same session). */
export function reviewRetryPrompt(error: string): string {
  return `That reply wasn't valid: ${error}\nReply again with only the JSON object in the requested shape, nothing else.`;
}

/** Find and validate the JSON object in Claude's reply. */
export function parseReviewResult(
  text: string,
): { ok: true; review: ReviewResult } | { ok: false; error: string } {
  const trimmed = text.trim();
  const fence = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(trimmed);
  const candidate = fence
    ? fence[1]!
    : trimmed.slice(trimmed.indexOf('{'), trimmed.lastIndexOf('}') + 1);
  if (!candidate.trim()) return { ok: false, error: 'no JSON object found' };
  let json: unknown;
  try {
    json = JSON.parse(candidate);
  } catch (err) {
    return { ok: false, error: `invalid JSON (${err instanceof Error ? err.message : err})` };
  }
  const parsed = ReviewResultSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: `${issue?.path.join('.') || 'result'}: ${issue?.message}` };
  }
  return { ok: true, review: parsed.data };
}

// ------------------------------------------------------------- diff hygiene

/** Convert a review exclusion glob (`**`, `*`, `?`) to a RegExp over forward-slash paths. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*' && glob[i + 1] === '*') {
      // "**/" matches zero or more directories; a trailing "**" matches anything.
      if (glob[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export function isExcluded(path: string, globs: string[]): boolean {
  const p = path.replace(/\\/g, '/');
  return globs.some((g) => globToRegExp(g).test(p));
}

/**
 * Join per-file diffs for the prompt: excluded files dropped, the rest cut at
 * `maxChars` (whole files first, so a big file doesn't hide every other one).
 */
export function assembleDiff(
  files: { path: string; diff: string }[],
  globs: string[],
  maxChars: number,
): { diff: string; excludedFiles: string[]; truncated: boolean } {
  const excludedFiles: string[] = [];
  const kept: string[] = [];
  let size = 0;
  let truncated = false;
  const included = files.filter((f) => {
    if (isExcluded(f.path, globs)) {
      excludedFiles.push(f.path);
      return false;
    }
    return true;
  });
  // Smaller files first: more of the change fits before the cap.
  for (const f of [...included].sort((a, b) => a.diff.length - b.diff.length)) {
    const block = `--- ${f.path}\n${f.diff.trimEnd()}`;
    if (size + block.length > maxChars) {
      truncated = true;
      const room = maxChars - size;
      if (room > 500) kept.push(`${block.slice(0, room)}\n[… cut]`);
      break;
    }
    kept.push(block);
    size += block.length + 1;
  }
  return { diff: kept.join('\n'), excludedFiles, truncated };
}

/** Split `git diff` output into per-file chunks (paths from the b/ side). */
export function splitGitDiff(text: string): { path: string; diff: string }[] {
  const out: { path: string; diff: string }[] = [];
  for (const chunk of text.split(/^(?=diff --git )/m)) {
    if (!chunk.startsWith('diff --git ')) continue;
    const header = /^diff --git a\/(.+?) b\/(.+)$/m.exec(chunk);
    const plus = /^\+\+\+ b\/(.+)$/m.exec(chunk);
    const path = plus?.[1] ?? header?.[2] ?? 'unknown';
    const body = chunk.slice(chunk.search(/^@@/m) >= 0 ? chunk.search(/^@@/m) : chunk.length);
    out.push({ path, diff: body || '(binary or mode change)' });
  }
  return out;
}

// ------------------------------------------------------------- copy text

export function formatLocation(f: ReviewFinding): string {
  if (!f.file) return '';
  return `${f.file}${f.line ? `:${f.line}` : ''}: `;
}

export function formatFinding(f: ReviewFinding): string {
  return `${formatLocation(f)}${f.reason}`;
}

export function formatBlockers(review: ReviewResult): string {
  return review.blockers.length
    ? review.blockers.map((b) => `- ${formatFinding(b)}`).join('\n')
    : 'No blockers.';
}

/** The whole review as Markdown, ready to paste into GitLab. */
export function formatReview(review: ReviewResult): string {
  const section = (title: string, lines: string[]) =>
    lines.length ? [`**${title}**`, ...lines.map((l) => `- ${l}`), ''] : [];
  return [
    ...(review.summary ? [review.summary, ''] : []),
    ...section('Blockers', review.blockers.map(formatFinding)),
    ...section('Suggestions', review.suggestions.map(formatFinding)),
    ...section('Questions', review.questions),
    `Recommendation: ${VERDICT_LABELS[review.verdict]}`,
  ]
    .join('\n')
    .trim();
}
