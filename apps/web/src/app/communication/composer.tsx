'use client';

import type { MessageFormat, MessageKind, PolishStyle } from '@tab-enter/core';
import { Check, Copy, RotateCcw, Sparkles, Undo2 } from 'lucide-react';
import { useEffect, useRef, useState, useTransition, type KeyboardEvent } from 'react';
import type { ActionResult } from '@/app/actions';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { pollPolishAction, saveCopiedMessageAction, startPolishAction } from './actions';

export interface GeneratedMessage {
  kind: MessageKind;
  slack: string;
  plain: string;
  windowStart: string | null;
  windowEnd: string | null;
}

const POLISH_TIMEOUT_MS = 120_000;

function isTyping(target: EventTarget | null) {
  return target instanceof HTMLElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

/** Copy text, falling back to a hidden textarea when the async clipboard is blocked. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

/**
 * An editable generated message with a Slack/plain toggle, Copy (also `c`
 * when the card has focus), and the optional Polish with Claude.
 */
export function Composer({
  message,
  polishBlocker,
  title,
}: {
  message: GeneratedMessage;
  /** Why polishing is unavailable, or null. */
  polishBlocker: string | null;
  title: string;
}) {
  const [format, setFormat] = useState<MessageFormat>('slack');
  const [texts, setTexts] = useState({ slack: message.slack, plain: message.plain });
  const [undo, setUndo] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [result, setResult] = useState<ActionResult>({});
  const [polishing, setPolishing] = useState(false);
  const [pending, startTransition] = useTransition();
  const cancelled = useRef(false);

  // A regenerated message (new window, new sync) replaces local edits. Compare
  // text, not identity: every server refresh (e.g. after Copy) sends a new object.
  const [source, setSource] = useState(message);
  if (source.slack !== message.slack || source.plain !== message.plain) {
    setSource(message);
    setTexts({ slack: message.slack, plain: message.plain });
    setUndo(null);
  }
  // Reset on every mount: Strict Mode mounts, unmounts and remounts in development.
  useEffect(() => {
    cancelled.current = false;
    return () => {
      cancelled.current = true;
    };
  }, []);

  const text = texts[format];
  const edited = text !== message[format];

  const copy = () =>
    startTransition(async () => {
      if (!(await copyText(text))) {
        setResult({ error: 'Copy failed: select the text and copy it by hand.' });
        return;
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      setResult(
        await saveCopiedMessageAction({
          kind: message.kind,
          format,
          body: text,
          windowStart: message.windowStart,
          windowEnd: message.windowEnd,
        }),
      );
    });

  const polish = (style: PolishStyle) =>
    startTransition(async () => {
      setResult({});
      const started = await startPolishAction({ text, style, format });
      if (!started.runId) return setResult({ error: started.error });
      setPolishing(true);
      const deadline = Date.now() + POLISH_TIMEOUT_MS;
      try {
        while (!cancelled.current && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 1000));
          const status = await pollPolishAction(started.runId);
          if (!status.done) continue;
          if (status.error || !status.text) return setResult({ error: status.error });
          setUndo(text);
          setTexts({ ...texts, [format]: status.text });
          return setResult({ ok: 'Polished by Claude. Check it before sending.' });
        }
        if (!cancelled.current) setResult({ error: 'Polishing is taking too long; see Runs.' });
      } finally {
        setPolishing(false);
      }
    });

  return (
    <div
      tabIndex={0}
      aria-label={`${title}: press c to copy`}
      className="grid gap-2 rounded-md p-1 outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      onKeyDown={(e: KeyboardEvent) => {
        if (e.key === 'c' && !e.metaKey && !e.ctrlKey && !e.altKey && !isTyping(e.target)) {
          e.preventDefault();
          copy();
        }
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-md border p-0.5 text-xs" role="group" aria-label="Format">
          {(['slack', 'plain'] as const).map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={format === f}
              onClick={() => setFormat(f)}
              className={cn(
                'rounded px-2 py-1',
                format === f
                  ? 'bg-accent font-medium'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {f === 'slack' ? 'Slack' : 'Plain text'}
            </button>
          ))}
        </div>
        <Button size="sm" onClick={copy} disabled={pending && !polishing} title="Copy (c)">
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
        {edited && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setTexts({ ...texts, [format]: message[format] });
              setUndo(null);
            }}
            title="Discard edits and regenerate from the template"
          >
            <RotateCcw className="h-3.5 w-3.5" /> Reset
          </Button>
        )}
        <span className="ml-auto flex items-center gap-1.5">
          {polishing && <Badge tone="info">Polishing…</Badge>}
          {undo !== null && !polishing && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setTexts({ ...texts, [format]: undo });
                setUndo(null);
              }}
            >
              <Undo2 className="h-3.5 w-3.5" /> Undo polish
            </Button>
          )}
          {(['concise', 'detailed'] as const).map((style) => (
            <Button
              key={style}
              size="sm"
              variant="outline"
              disabled={pending || polishBlocker !== null}
              title={polishBlocker ?? 'Rewrite with Claude Code (short-text preset, no tools)'}
              onClick={() => polish(style)}
            >
              <Sparkles className="h-3.5 w-3.5" />
              {style === 'concise' ? 'More concise' : 'More detailed'}
            </Button>
          ))}
        </span>
      </div>
      <textarea
        value={text}
        onChange={(e) => setTexts({ ...texts, [format]: e.target.value })}
        rows={Math.min(24, Math.max(6, text.split('\n').length + 1))}
        aria-label={`${title} (${format === 'slack' ? 'Slack mrkdwn' : 'plain text'})`}
        className="w-full rounded-md border bg-background px-3 py-2 font-mono text-xs leading-relaxed"
      />
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

export function HistoryList({
  items,
}: {
  items: {
    id: string;
    kind: MessageKind;
    format: MessageFormat;
    body: string;
    createdAt: string;
  }[];
}) {
  const [copiedId, setCopiedId] = useState<string | null>(null);
  return (
    <ul className="divide-y">
      {items.map((m) => (
        <li key={m.id} className="px-4 py-2">
          <details>
            <summary className="flex cursor-pointer items-center gap-2 text-sm">
              <Badge tone={m.kind === 'daily-report' ? 'info' : 'muted'}>
                {m.kind === 'daily-report' ? 'Daily report' : 'Review request'}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {new Date(m.createdAt).toLocaleString()} ·{' '}
                {m.format === 'slack' ? 'Slack' : 'plain'}
              </span>
              <span className="min-w-0 flex-1 truncate">{m.body.split('\n')[0]}</span>
            </summary>
            <div className="mt-2 grid gap-2">
              <pre className="max-h-80 overflow-auto rounded bg-muted p-2 text-xs whitespace-pre-wrap">
                {m.body}
              </pre>
              <div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    if (await copyText(m.body)) {
                      setCopiedId(m.id);
                      setTimeout(() => setCopiedId(null), 1500);
                    }
                  }}
                >
                  {copiedId === m.id ? (
                    <Check className="h-3.5 w-3.5" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                  {copiedId === m.id ? 'Copied' : 'Copy again'}
                </Button>
              </div>
            </div>
          </details>
        </li>
      ))}
    </ul>
  );
}
