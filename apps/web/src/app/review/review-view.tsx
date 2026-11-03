'use client';

import {
  formatBlockers,
  formatFinding,
  formatReview,
  VERDICT_LABELS,
  type ReviewFinding,
  type StoredReview,
  type Verdict,
} from '@tab-enter/core';
import { Check, Copy, Play, RefreshCw } from 'lucide-react';
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

export function ReviewResultView({
  result,
  runId,
  reviewedSha,
  when,
}: {
  result: StoredReview;
  runId: string | null;
  reviewedSha: string;
  when: string;
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
