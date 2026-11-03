'use client';

import {
  formatBlockers,
  formatFinding,
  formatReview,
  VERDICT_LABELS,
  type ReviewFinding,
  type ReviewResult,
  type StoredReview,
  type Verdict,
} from '@tab-enter/core';
import { Check, Copy, MessageSquarePlus, Play, RefreshCw, ThumbsUp } from 'lucide-react';
import { WriteButton } from '@/components/write-button';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import type { ActionResult } from '@/app/actions';
import { startReviewAction } from '@/app/runs/actions';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export const VERDICT_TONE: Record<Verdict, 'success' | 'warning' | 'danger'> = {
  approve: 'success',
  approve_with_comments: 'warning',
  request_changes: 'danger',
};

/** Refresh the server-rendered page while a review is running. */
export function AutoRefresh({ active }: { active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => router.refresh(), 2000);
    return () => clearInterval(timer);
  }, [active, router]);
  return null;
}

function CopyButton({ text, label, small }: { text: string; label: string; small?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      variant={small ? 'ghost' : 'outline'}
      title={label}
      className={small ? 'h-6 px-1.5' : undefined}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // clipboard blocked; nothing else to do
        }
      }}
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {small ? <span className="sr-only">{label}</span> : copied ? 'Copied' : label}
    </Button>
  );
}

export function ReviewButton({
  mrKey,
  blocker,
  reviewed,
  changed,
}: {
  mrKey: string;
  blocker: string | null;
  reviewed: boolean;
  changed: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ActionResult>({});
  const label = !reviewed ? 'Review with Claude' : changed ? 'Re-review changes' : 'Review again';
  return (
    <span className="flex items-center gap-2">
      <Button
        size="sm"
        variant={reviewed && !changed ? 'outline' : 'default'}
        disabled={pending || blocker !== null}
        title={
          blocker ??
          (changed
            ? 'Sends only what changed since the last review, plus its blockers'
            : 'Read-only review in a worktree at the MR head')
        }
        onClick={() => startTransition(async () => setResult(await startReviewAction(mrKey)))}
      >
        {reviewed ? <RefreshCw className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
        {label}
      </Button>
      {result.error && (
        <span role="alert" className="text-xs text-danger">
          {result.error}
        </span>
      )}
    </span>
  );
}

function Findings({
  title,
  items,
  tone,
}: {
  title: string;
  items: ReviewFinding[];
  tone: 'danger' | 'muted';
}) {
  if (items.length === 0) return null;
  return (
    <div>
      <h4 className={cn('mb-1 text-xs font-semibold', tone === 'danger' && 'text-danger')}>
        {title} ({items.length})
      </h4>
      <ul className="grid gap-1">
        {items.map((f, i) => (
          <li key={i} className="group flex items-start gap-2 text-sm">
            <span className="min-w-0 flex-1">
              {f.file && (
                <code className="mr-1.5 text-xs text-muted-foreground">
                  {f.file}
                  {f.line ? `:${f.line}` : ''}
                </code>
              )}
              {f.reason}
            </span>
            <CopyButton text={formatFinding(f)} label="Copy this comment" small />
          </li>
        ))}
      </ul>
    </div>
  );
}

interface Writes {
  mrKey: string;
  headSha: string;
  open: boolean;
  allowComment: boolean;
  allowApprove: boolean;
}

const OFF = (name: string) => `“${name}” is off. Turn it on in Settings → Write actions.`;

/** Post selected findings (one comment, or on their lines) and approve: all confirmed. */
function ReviewWrites({
  review,
  reviewedSha,
  writes,
}: {
  review: ReviewResult;
  reviewedSha: string;
  writes: Writes;
}) {
  const items = [
    ...review.blockers.map((f) => ({ kind: 'Blocker', f })),
    ...review.suggestions.map((f) => ({ kind: 'Suggestion', f })),
    ...review.questions.map((q) => ({
      kind: 'Question',
      f: { reason: q, file: null, line: null },
    })),
  ];
  const [selected, setSelected] = useState<Set<number>>(() => new Set(items.map((_, i) => i)));
  const chosen = items.filter((_, i) => selected.has(i));
  const lineItems = chosen.filter((c) => c.f.file && c.f.line);
  const body = chosen.map((c) => `- **${c.kind}:** ${formatFinding(c.f)}`).join('\n');
  const changed = writes.headSha !== reviewedSha;

  if (!writes.open) return null;
  return (
    <div className="grid gap-2 border-t pt-3">
      {items.length > 0 && (
        <fieldset className="grid gap-1">
          <legend className="mb-1 text-xs font-semibold">Post to GitLab</legend>
          {items.map((c, i) => (
            <label key={i} className="flex items-start gap-2 text-xs">
              <input
                type="checkbox"
                checked={selected.has(i)}
                onChange={() => {
                  const next = new Set(selected);
                  if (next.has(i)) next.delete(i);
                  else next.add(i);
                  setSelected(next);
                }}
                className="mt-0.5"
              />
              <span>
                <strong>{c.kind}:</strong> {formatFinding(c.f)}
              </span>
            </label>
          ))}
        </fieldset>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {items.length > 0 && (
          <>
            <WriteButton
              label={`Post as one comment (${chosen.length})`}
              icon={<MessageSquarePlus className="h-3.5 w-3.5" />}
              enabled={writes.allowComment && chosen.length > 0}
              disabledReason={
                writes.allowComment
                  ? 'Select at least one item.'
                  : OFF('Post comments on merge requests')
              }
              title="Post this comment?"
              where={`GitLab · ${writes.mrKey}`}
              preview={body}
              action={{ kind: 'mr-comment', mrKey: writes.mrKey, body }}
            />
            <WriteButton
              label={`Post on lines (${lineItems.length})`}
              icon={<MessageSquarePlus className="h-3.5 w-3.5" />}
              enabled={writes.allowComment && lineItems.length > 0}
              disabledReason={
                writes.allowComment
                  ? 'None of the selected items has a file and line.'
                  : OFF('Post comments on merge requests')
              }
              title={`Post ${lineItems.length} line comment${lineItems.length === 1 ? '' : 's'}?`}
              where={`GitLab · ${writes.mrKey}`}
              preview={lineItems
                .map((c) => `${c.f.file}:${c.f.line}\n  ${c.kind}: ${c.f.reason}`)
                .join('\n\n')}
              action={{
                kind: 'mr-diff-comments',
                mrKey: writes.mrKey,
                comments: lineItems.map((c) => ({
                  file: c.f.file!,
                  line: c.f.line!,
                  body: `**${c.kind}:** ${c.f.reason}`,
                })),
              }}
            />
          </>
        )}
        <WriteButton
          label="Approve"
          icon={<ThumbsUp className="h-3.5 w-3.5" />}
          variant={review.verdict === 'request_changes' ? 'outline' : 'default'}
          enabled={writes.allowApprove}
          disabledReason={OFF('Approve merge requests')}
          title={`Approve ${writes.mrKey}?`}
          where={`GitLab · ${writes.mrKey}`}
          preview={
            <>
              Approving commit <code>{reviewedSha.slice(0, 12)}</code>. If the MR has moved on
              since, GitLab refuses and nothing is approved.
              {changed && (
                <p className="mt-2 text-warning">
                  New commits arrived after this review (head {writes.headSha.slice(0, 12)}).
                  Re-review first, or this approval will be refused.
                </p>
              )}
              {review.verdict === 'request_changes' && (
                <p className="mt-2 text-danger">Claude recommended requesting changes.</p>
              )}
            </>
          }
          action={{ kind: 'mr-approve', mrKey: writes.mrKey, sha: reviewedSha }}
        />
      </div>
    </div>
  );
}

export function ReviewResultView({
  result,
  runId,
  reviewedSha,
  when,
  writes,
}: {
  result: StoredReview;
  runId: string | null;
  reviewedSha: string;
  when: string;
  writes?: Writes;
}) {
  const { review } = result;
  return (
    <div className="grid gap-3 rounded-md border bg-muted/30 p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {review && (
          <Badge tone={VERDICT_TONE[review.verdict]}>{VERDICT_LABELS[review.verdict]}</Badge>
        )}
        <span>
          Reviewed {when} at <code>{reviewedSha.slice(0, 12)}</code>
          {result.incrementalFrom && <> (changes since {result.incrementalFrom.slice(0, 12)})</>}
        </span>
        {runId && (
          <Link href={`/runs/${runId}`} className="underline-offset-2 hover:underline">
            Run log
          </Link>
        )}
        {review && (
          <span className="ml-auto flex gap-1.5">
            <CopyButton text={formatBlockers(review)} label="Copy blockers" />
            <CopyButton text={formatReview(review)} label="Copy full review" />
          </span>
        )}
      </div>
      {review ? (
        <>
          {review.summary && <p className="text-sm">{review.summary}</p>}
          <Findings title="Blockers" items={review.blockers} tone="danger" />
          <Findings title="Suggestions" items={review.suggestions} tone="muted" />
          {review.questions.length > 0 && (
            <div>
              <h4 className="mb-1 text-xs font-semibold">Questions ({review.questions.length})</h4>
              <ul className="grid gap-1">
                {review.questions.map((q, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm">
                    <span className="min-w-0 flex-1">{q}</span>
                    <CopyButton text={q} label="Copy this question" small />
                  </li>
                ))}
              </ul>
            </div>
          )}
          {review.blockers.length + review.suggestions.length + review.questions.length === 0 && (
            <p className="text-sm text-muted-foreground">No blockers, suggestions or questions.</p>
          )}
        </>
      ) : (
        <div className="grid gap-1">
          <p className="text-xs text-warning">
            Claude&apos;s reply didn&apos;t match the review format ({result.error}). Its raw text:
          </p>
          <pre className="max-h-80 overflow-auto rounded bg-muted p-2 text-xs whitespace-pre-wrap">
            {result.raw}
          </pre>
          {result.raw && <CopyButton text={result.raw} label="Copy text" />}
        </div>
      )}
      {review && writes && (
        <ReviewWrites review={review} reviewedSha={reviewedSha} writes={writes} />
      )}
      {(result.excludedFiles.length > 0 || result.truncated) && (
        <p className="text-xs text-muted-foreground">
          {result.excludedFiles.length > 0 &&
            `Left out by your exclusion globs: ${result.excludedFiles.join(', ')}. `}
          {result.truncated &&
            'The diff was cut to the size cap; Claude read the rest from the worktree as needed.'}
        </p>
      )}
    </div>
  );
}
