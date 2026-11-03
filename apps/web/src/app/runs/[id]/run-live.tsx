'use client';

import type { AgentEvent } from '@tab-enter/core';
import { Ban, Check, Copy, CornerDownRight, SquareTerminal } from 'lucide-react';
import { useEffect, useRef, useState, useTransition } from 'react';
import type { ActionResult } from '@/app/actions';
import {
  cancelRunAction,
  continueRunAction,
  getRunUpdate,
  openTerminalAction,
  type RunUpdate,
} from '@/app/runs/actions';
import { RUN_STATUS } from '@/components/run-list';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { formatDuration, formatTokens, formatUsd } from '@/lib/format';
import { cn } from '@/lib/utils';

const POLL_MS = 1000;

export function RunLive({
  initial,
  isDemo,
  softLimitUsd,
}: {
  initial: RunUpdate;
  isDemo: boolean;
  softLimitUsd: number | null;
}) {
  const [run, setRun] = useState(initial.run);
  const [events, setEvents] = useState(initial.events);
  const [now, setNow] = useState(() => Date.now());
  const [result, setResult] = useState<ActionResult>({});
  const [followUp, setFollowUp] = useState('');
  const [pending, startTransition] = useTransition();
  const logRef = useRef<HTMLOListElement>(null);
  const live = run.status === 'queued' || run.status === 'running';

  // Poll for new events while the run is live.
  const lastSeq = events.at(-1)?.seq ?? -1;
  useEffect(() => {
    if (!live) return;
    let stopped = false;
    const timer = setTimeout(async () => {
      try {
        const update = await getRunUpdate(run.id, lastSeq);
        if (stopped) return;
        setRun(update.run);
        if (update.events.length) setEvents((prev) => [...prev, ...update.events]);
      } catch {
        // transient (e.g. dev server reload); try again next tick
      }
      setNow(Date.now());
    }, POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [live, run.id, lastSeq, now]);

  // Keep the log pinned to the bottom while new events arrive, unless the user scrolled up.
  useEffect(() => {
    const el = logRef.current;
    if (!el || !live) return;
    const nearBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 200;
    if (nearBottom) el.lastElementChild?.scrollIntoView({ block: 'end' });
  }, [events.length, live]);

  const started = run.startedAt ? Date.parse(run.startedAt) : null;
  const ended = run.endedAt ? Date.parse(run.endedAt) : null;
  const elapsed = started ? (ended ?? now) - started : null;
  const status = RUN_STATUS[run.status];
  const tokens = (run.inputTokens ?? 0) + (run.outputTokens ?? 0);
  const overLimit = softLimitUsd !== null && (run.costUsd ?? 0) > softLimitUsd;
  const resumeCommand = run.sessionId ? `claude --resume ${run.sessionId}` : null;

  return (
    <div className="grid gap-5">
      <Card>
        <CardHeader
          title={
            <span className="flex items-center gap-2">
              <Badge tone={status.tone}>
                {run.cancelRequested && live ? 'Cancelling…' : status.label}
              </Badge>
              {elapsed !== null && (
                <span className="text-xs font-normal text-muted-foreground tabular-nums">
                  {formatDuration(elapsed)}
                </span>
              )}
              {run.costUsd !== null && (
                <span
                  className={cn(
                    'text-xs font-normal tabular-nums',
                    overLimit ? 'text-warning' : 'text-muted-foreground',
                  )}
                >
                  · {formatTokens(tokens)} · {formatUsd(run.costUsd)}
                  {overLimit && ` (over your ${formatUsd(softLimitUsd!)} per-run limit)`}
                </span>
              )}
            </span>
          }
          description={
            <span className="grid gap-0.5">
              {run.modelUsed && <span>Model: {run.modelUsed}</span>}
              {run.cwd && (
                <span>
                  Folder: <code>{run.cwd}</code>
                  {run.branch && run.branch !== 'demo' && (
                    <>
                      {' '}
                      on <code>{run.branch}</code>
                    </>
                  )}
                </span>
              )}
              {run.sessionId && (
                <span>
                  Session: <code>{run.sessionId}</code>
                </span>
              )}
            </span>
          }
          actions={
            <>
              {live && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending || run.cancelRequested}
                  onClick={() =>
                    startTransition(async () => setResult(await cancelRunAction(run.id)))
                  }
                >
                  <Ban className="h-3.5 w-3.5" /> Cancel
                </Button>
              )}
              {!isDemo && run.sessionId && run.cwd && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  title="Take over in your terminal: claude --resume in this run's folder"
                  onClick={() =>
                    startTransition(async () =>
                      setResult(await openTerminalAction({ runId: run.id })),
                    )
                  }
                >
                  <SquareTerminal className="h-3.5 w-3.5" /> Open in terminal
                </Button>
              )}
              {resumeCommand && <CopyButton text={resumeCommand} label="Copy resume command" />}
            </>
          }
        />
        {run.error && (
          <p role="alert" className="border-b px-4 py-2 text-sm text-danger">
            {run.error}
          </p>
        )}
        {(run.diffSummary?.filesChanged.length ?? 0) > 0 && (
          <div className="border-b px-4 py-2 text-xs">
            <span className="text-muted-foreground">Files changed: </span>
            {run.diffSummary!.filesChanged.map((f) => (
              <code key={f} className="mr-2">
                {shortPath(f, run.cwd)}
              </code>
            ))}
          </div>
        )}
        <ol ref={logRef} className="grid gap-2 p-4 text-sm" aria-live={live ? 'polite' : undefined}>
          {events.length === 0 && (
            <li className="text-muted-foreground">
              {run.status === 'queued' ? 'Waiting for the worker to start this run…' : 'No output.'}
            </li>
          )}
          {events.map(({ seq, event }) => (
            <EventLine key={seq} event={event} cwd={run.cwd} />
          ))}
          {live && run.status === 'running' && (
            <li className="animate-pulse text-xs text-muted-foreground">Working…</li>
          )}
        </ol>
      </Card>

      {!live && run.sessionId && (
        <Card>
          <CardHeader
            title="Continue"
            description="Sends a follow-up in the same Claude Code session and folder, so context isn't rebuilt."
          />
          <form
            className="grid gap-2 p-4"
            onSubmit={(e) => {
              e.preventDefault();
              startTransition(async () => {
                const r = await continueRunAction(run.id, followUp);
                if (r?.error) setResult(r);
              });
            }}
          >
            <textarea
              value={followUp}
              onChange={(e) => setFollowUp(e.target.value)}
              rows={3}
              placeholder="e.g. Also cover the signup form, then run the tests again."
              aria-label="Follow-up prompt"
              className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey))
                  e.currentTarget.form?.requestSubmit();
              }}
            />
            <div className="flex items-center gap-3">
              <Button type="submit" size="sm" disabled={pending || !followUp.trim()}>
                <CornerDownRight className="h-3.5 w-3.5" /> Continue
              </Button>
              <span className="text-xs text-muted-foreground">Ctrl+Enter to send</span>
            </div>
          </form>
        </Card>
      )}

      {(result.error || result.ok) && (
        <p
          role={result.error ? 'alert' : 'status'}
          className={cn('text-xs', result.error ? 'text-danger' : 'text-success')}
        >
          {result.error ?? result.ok}
        </p>
      )}
    </div>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      title={label}
      onClick={async () => {
        await navigator.clipboard.writeText(text).catch(() => {});
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      <span className="sr-only">{label}</span>
    </Button>
  );
}

function shortPath(file: string, cwd: string | null): string {
  if (!cwd) return file;
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const f = norm(file);
  const c = norm(cwd);
  return f.startsWith(`${c}/`) ? f.slice(c.length + 1) : f;
}

type ToolInput = Record<string, unknown>;

function describeTool(name: string, input: unknown, cwd: string | null): string {
  const i = (input && typeof input === 'object' ? input : {}) as ToolInput;
  const s = (k: string) => (typeof i[k] === 'string' ? (i[k] as string) : null);
  const file = s('file_path') ?? s('notebook_path');
  if (file) return shortPath(file, cwd);
  if (s('command')) return s('command')!;
  if (s('pattern')) return `${s('pattern')}${s('path') ? ` in ${shortPath(s('path')!, cwd)}` : ''}`;
  if (s('url')) return s('url')!;
  return '';
}

function EventLine({ event, cwd }: { event: AgentEvent; cwd: string | null }) {
  switch (event.type) {
    case 'init':
      return (
        <li className="text-xs text-muted-foreground">
          Session started{event.model ? ` · ${event.model}` : ''} · tools:{' '}
          {event.tools.join(', ') || 'none'}
        </li>
      );
    case 'text':
      return <li className="whitespace-pre-wrap">{event.text}</li>;
    case 'tool_use':
      return (
        <li className="flex items-baseline gap-2 text-xs">
          <Badge tone="info">{event.name}</Badge>
          <code className="truncate">{describeTool(event.name, event.input, cwd)}</code>
        </li>
      );
    case 'tool_result':
      return (
        <li>
          <details className="text-xs">
            <summary
              className={cn(
                'cursor-pointer',
                event.isError ? 'text-danger' : 'text-muted-foreground',
              )}
            >
              {event.isError ? 'Tool error' : 'Tool output'} ({event.content.split('\n').length}{' '}
              lines)
            </summary>
            <pre className="mt-1 max-h-80 overflow-auto rounded bg-muted p-2 whitespace-pre-wrap">
              {event.content}
            </pre>
          </details>
        </li>
      );
    case 'result':
      return (
        <li
          className={cn(
            'rounded-md border px-3 py-2',
            event.isError ? 'border-danger text-danger' : 'border-success',
          )}
        >
          <p className="text-xs font-medium">
            {event.isError ? `Ended with an error (${event.subtype})` : 'Finished'}
            {event.numTurns !== null && ` · ${event.numTurns} turns`}
            {event.durationMs !== null && ` · ${formatDuration(event.durationMs)}`}
          </p>
          {event.resultText && <p className="mt-1 whitespace-pre-wrap">{event.resultText}</p>}
        </li>
      );
    case 'error':
      return <li className="text-danger">{event.message}</li>;
  }
}
