'use client';

import { Check, Copy, Play, RotateCw } from 'lucide-react';
import { useState, useTransition } from 'react';
import type { ActionResult } from '@/app/actions';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/field';
import { startVerificationAction } from './actions';

export function VerifyControls({
  issueKey,
  hasSavedScript,
  running,
}: {
  issueKey: string;
  hasSavedScript: boolean;
  running: boolean;
}) {
  const [mode, setMode] = useState<'auto' | 'ui' | 'backend'>('auto');
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ActionResult>({});
  const start = (rerun: boolean) =>
    startTransition(async () =>
      setResult(await startVerificationAction({ issueKey, mode: rerun ? 'ui' : mode, rerun })),
    );
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <Select
        aria-label={`Verification mode for ${issueKey}`}
        value={mode}
        onChange={(e) => setMode(e.target.value as typeof mode)}
        className="h-7 w-auto text-xs"
      >
        <option value="auto">Auto (UI if UI files changed)</option>
        <option value="ui">UI walkthrough</option>
        <option value="backend">Test evidence only</option>
      </Select>
      <Button size="sm" disabled={pending || running} onClick={() => start(false)}>
        <Play className="h-3.5 w-3.5" /> Verify
      </Button>
      {hasSavedScript && (
        <Button
          size="sm"
          variant="outline"
          disabled={pending || running}
          title="Run the saved walkthrough again: no AI for the script"
          onClick={() => start(true)}
        >
          <RotateCw className="h-3.5 w-3.5" /> Re-run walkthrough
        </Button>
      )}
      {result.error && (
        <span role="alert" className="text-xs text-danger">
          {result.error}
        </span>
      )}
    </span>
  );
}

export function CopySummary({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={async () => {
        await navigator.clipboard.writeText(text).catch(() => {});
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? 'Copied' : 'Copy summary'}
    </Button>
  );
}
