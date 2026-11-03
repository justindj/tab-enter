import type { ProfileSettings } from './settings';
import type { IssueDetail, MergeRequest, PipelineFailure } from './types';

// Context builders: turn synced data into small, plain-text prompt blocks.
// Never raw API JSON. Every block respects the profile's size caps, because
// prompt size is token cost.

export type ContextCaps = ProfileSettings['contextCaps'];

const MAX_COMMENT_CHARS = 600;
const MAX_THREAD_CHARS = 800;
const MAX_THREADS = 15;

/** Cut to `max` characters on a line or word boundary, marking the cut. */
export function truncate(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const slice = t.slice(0, max);
  const cut = Math.max(slice.lastIndexOf('\n'), slice.lastIndexOf(' '));
  // Prefer a boundary unless it would throw away more than half the budget.
  return `${(cut > max * 0.5 ? slice.slice(0, cut) : slice).trimEnd()} […]`;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;
const ERROR_LINE = /\b(error|failed|failure|fatal|exception|panic|assert|expected|✕|✗|FAIL)\b/i;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '').replace(/\r(?!\n)/g, '\n');
}

/**
 * The part of a CI log worth sending: the tail, extended back to include the
 * first error-looking line near the end, within `maxLines`.
 */
export function errorFocusedTail(log: string, maxLines: number): string {
  const lines = stripAnsi(log)
    .split('\n')
    // GitLab section markers and blank noise
    .filter((l) => !/^section_(start|end):/.test(l) && l.trim() !== '');
  if (lines.length <= maxLines) return lines.join('\n');
  const tail = lines.slice(-maxLines);
  const window = lines.slice(-maxLines * 3, -maxLines);
  const firstError = window.findIndex((l) => ERROR_LINE.test(l));
  if (firstError < 0) return tail.join('\n');
  // Keep a few lines of the earliest error in the window, then the tail.
  const head = window.slice(firstError, firstError + Math.floor(maxLines / 4));
  return [...head, '[…]', ...tail.slice(head.length + 1)].join('\n');
}

export function ticketBlock(issue: IssueDetail, caps: ContextCaps): string {
  const parts = [
    `${issue.key}: ${issue.summary}`,
    `Type: ${issue.issueType} · Status: ${issue.status}${issue.priority ? ` · Priority: ${issue.priority}` : ''}`,
  ];
  if (issue.description.trim()) {
    parts.push('', 'Description:', truncate(issue.description, caps.descriptionChars));
  }
  return parts.join('\n');
}

export function acceptanceCriteriaBlock(issue: IssueDetail): string {
  if (issue.acceptanceCriteria.length === 0) return '(none written; infer from the description)';
  return issue.acceptanceCriteria.map((c) => `- ${c}`).join('\n');
}

export function commentsBlock(issue: IssueDetail, caps: ContextCaps): string {
  const recent = issue.comments.slice(-caps.commentsCount);
  if (recent.length === 0) return '';
  return recent.map((c) => `- ${c.author}: ${truncate(c.body, MAX_COMMENT_CHARS)}`).join('\n');
}

export function threadsBlock(mr: MergeRequest): string {
  const threads = mr.threads ?? [];
  if (threads.length === 0) {
    return mr.unresolvedThreads > 0
      ? `(${mr.unresolvedThreads} unresolved thread(s); open the MR to read them)`
      : '';
  }
  return threads
    .slice(0, MAX_THREADS)
    .map((t) => {
      const where = t.filePath ? ` (${t.filePath}${t.line ? `:${t.line}` : ''})` : '';
      return `- ${t.author}${where}: ${truncate(t.body, MAX_THREAD_CHARS)}`;
    })
    .join('\n');
}

export function pipelineBlock(failures: PipelineFailure[] | undefined, caps: ContextCaps): string {
  if (!failures?.length) return '';
  return failures
    .map(
      (f) =>
        `Job "${f.job}" (stage ${f.stage}) failed. Log tail:\n\`\`\`\n${errorFocusedTail(f.logTail, caps.jobLogTailLines)}\n\`\`\``,
    )
    .join('\n\n');
}

/** Rough token estimate (≈4 characters per token for English and code). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
