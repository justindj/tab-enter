'use client';

import { estimateTokens, type Suggestion, type SuggestionKind } from '@tab-enter/core';
import { Check, Copy, ExternalLink, Pencil, Play, SquareTerminal } from 'lucide-react';
import Link from 'next/link';
import { useId, useState, useTransition } from 'react';
import type { ActionResult } from '@/app/actions';
import { openTerminalAction, startRunAction } from '@/app/runs/actions';
import { EmptyState } from '@/components/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Select } from '@/components/ui/field';
import { cn } from '@/lib/utils';

const KIND: Record<
  SuggestionKind,
  { label: string; tone: 'danger' | 'warning' | 'info' | 'muted' }
> = {
  'address-feedback': { label: 'Feedback', tone: 'warning' },
  'fix-pipeline': { label: 'Pipeline', tone: 'danger' },
  'resolve-conflicts': { label: 'Conflicts', tone: 'danger' },
  review: { label: 'Review', tone: 'info' },
  'next-ticket': { label: 'Next ticket', tone: 'muted' },
};

export interface UpNextProps {
  suggestions: Suggestion[];
  /** Why runs are unavailable (not approved, not installed…), or null. */
  runBlocker: string | null;
  isDemo: boolean;
  /** Watched projects with a local clone, for tickets that could live in several. */
  projects: { id: string; label: string }[];
}

export function UpNext({ suggestions, runBlocker, isDemo, projects }: UpNextProps) {
  if (suggestions.length === 0) {
    return (
      <EmptyState title="Nothing waiting on you">
        No feedback, failing pipelines, conflicts or reviews, and no unstarted tickets in the
        sprint.
      </EmptyState>
    );
  }
  return (
    <ol className="divide-y">
      {suggestions.map((s, i) => (
        <SuggestionItem
          key={s.id}
          suggestion={s}
          startOpen={i === 0}
          runBlocker={runBlocker}
          isDemo={isDemo}
          projects={projects}
        />
      ))}
    </ol>
  );
}

function SuggestionItem({
  suggestion: s,
  startOpen,
  runBlocker,
  isDemo,
  projects,
}: {
  suggestion: Suggestion;
  startOpen: boolean;
  runBlocker: string | null;
  isDemo: boolean;
  projects: UpNextProps['projects'];
}) {
  const [open, setOpen] = useState(startOpen);
  const [prompt, setPrompt] = useState(s.prompt);
  const [projectId, setProjectId] = useState(s.projectId ?? '');
  const [copied, setCopied] = useState(false);
  const [result, setResult] = useState<ActionResult>({});
  const [pending, startTransition] = useTransition();
  const promptId = useId();

  const needsProject = s.kind === 'next-ticket' && !s.projectId && projects.length > 1;
  const target = { issueKey: s.issueKey, mrKey: s.mrKey, projectId: projectId || null };
  const tokens = estimateTokens(prompt);
  const edited = prompt !== s.prompt;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setResult({
        error: 'Copy failed: your browser blocked clipboard access. Select the text instead.',
      });
      setOpen(true);
    }
  };

  return (
    <li className="grid gap-2 px-4 py-3">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <Badge tone={KIND[s.kind].tone} className="mt-0.5">
          {KIND[s.kind].label}
        </Badge>
        <div className="min-w-0 flex-1">
          <p className="font-medium">{s.title}</p>
          <p className="text-xs text-muted-foreground">{s.reason}</p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {s.preset &&
            (runBlocker ? (
              <Button size="sm" variant="outline" disabled title={runBlocker}>
                <Play className="h-3.5 w-3.5" /> Run
              </Button>
            ) : (
              <Button
                size="sm"
                disabled={pending || (needsProject && !projectId)}
                title={
                  needsProject && !projectId
                    ? 'Pick the project first'
                    : isDemo
                      ? 'Replays a recorded run (demo)'
                      : 'Run in Claude Code, in this ticket’s worktree'
                }
                onClick={() =>
                  startTransition(async () => {
                    const r = await startRunAction({ ...target, preset: s.preset!, prompt });
                    if (r?.error) setResult(r);
                  })
                }
              >
                <Play className="h-3.5 w-3.5" /> Run in Claude Code
              </Button>
            ))}
          {s.kind === 'review' && (
            <Link href="/review" className={buttonVariants({ size: 'sm', variant: 'outline' })}>
              Code Review
            </Link>
          )}
          <Button size="sm" variant="outline" onClick={copy} title="Copy the prompt">
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? 'Copied' : 'Copy prompt'}
          </Button>
          {s.kind !== 'review' && !isDemo && (
            <Button
              size="sm"
              variant="ghost"
              disabled={pending || (needsProject && !projectId)}
              title="Open Claude Code in your terminal, in this ticket’s worktree (the prompt is copied too)"
              onClick={() =>
                startTransition(async () => {
                  await copy();
                  setResult(await openTerminalAction({ target }));
                })
              }
            >
              <SquareTerminal className="h-3.5 w-3.5" /> Terminal
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={open}
            aria-controls={promptId}
            onClick={() => setOpen(!open)}
          >
            <Pencil className="h-3.5 w-3.5" /> {open ? 'Hide prompt' : 'Edit prompt'}
          </Button>
          {s.links.jira && (
            <a
              href={s.links.jira}
              target="_blank"
              rel="noreferrer"
              className={linkClass}
              title="Open in Jira"
            >
              Jira <ExternalLink className="h-3 w-3" />
            </a>
          )}
          {s.links.gitlab && (
            <a
              href={s.links.gitlab}
              target="_blank"
              rel="noreferrer"
              className={linkClass}
              title="Open in GitLab"
            >
              GitLab <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
      </div>

      {needsProject && (
        <label className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">Project</span>
          <Select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            className="w-auto"
          >
            <option value="">Choose…</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </Select>
        </label>
      )}

      {open && (
        <div id={promptId} className="grid gap-1">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={Math.min(18, Math.max(6, prompt.split('\n').length + 1))}
            aria-label={`Prompt for ${s.title}`}
            className="w-full rounded-md border bg-background px-2 py-1.5 font-mono text-xs leading-relaxed"
          />
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span>
              ~{tokens.toLocaleString()} tokens · {prompt.length.toLocaleString()} characters
            </span>
            {edited && (
              <button
                type="button"
                className="underline-offset-2 hover:underline"
                onClick={() => setPrompt(s.prompt)}
              >
                Reset to template
              </button>
            )}
            <span className="ml-auto">
              Edits apply to this run only; templates live in Settings.
            </span>
          </div>
        </div>
      )}

      {(result.error || result.ok) && (
        <p
          role={result.error ? 'alert' : 'status'}
          className={cn('text-xs', result.error ? 'text-danger' : 'text-success')}
        >
          {result.error ?? result.ok}
        </p>
      )}
    </li>
  );
}

const linkClass =
  'inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground';
