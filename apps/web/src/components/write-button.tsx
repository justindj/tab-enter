'use client';

import type { WriteAction } from '@tab-enter/core';
import { ExternalLink, ShieldAlert } from 'lucide-react';
import { useRef, useState, useTransition, type ReactNode } from 'react';
import { requestWriteAction, type WriteResult } from '@/app/writes/actions';
import { Button, type ButtonProps } from '@/components/ui/button';

/**
 * A button for a gated write: disabled (with the reason) until enabled in
 * Settings, and always behind a confirmation that shows exactly what will be
 * sent and where.
 */
export function WriteButton({
  label,
  icon,
  action,
  enabled,
  disabledReason,
  title,
  where,
  preview,
  extra,
  variant = 'outline',
  onDone,
}: {
  label: string;
  icon?: ReactNode;
  /** The action to send; a function is called when confirming (e.g. to read form fields). */
  action: WriteAction | (() => WriteAction | null);
  enabled: boolean;
  disabledReason?: string;
  /** Dialog heading, e.g. "Approve !21?" */
  title: string;
  /** Where it goes, e.g. "GitLab · acme/shop!21". */
  where: string;
  /** Exactly what will be sent (comment text, commits…). */
  preview?: ReactNode;
  /** Extra inputs inside the dialog (e.g. MR title). */
  extra?: ReactNode;
  variant?: ButtonProps['variant'];
  onDone?: (result: WriteResult) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<WriteResult>({});

  const confirm = () =>
    startTransition(async () => {
      const resolved = typeof action === 'function' ? action() : action;
      if (!resolved) return;
      const r = await requestWriteAction(resolved);
      setResult(r);
      if (!r.error) {
        dialog.current?.close();
        onDone?.(r);
      }
    });

  return (
    <>
      <Button
        size="sm"
        variant={variant}
        disabled={!enabled}
        title={enabled ? `${title} (asks to confirm)` : disabledReason}
        onClick={() => {
          setResult({});
          dialog.current?.showModal();
        }}
      >
        {icon}
        {label}
      </Button>
      <dialog
        ref={dialog}
        className="m-auto w-[min(640px,92vw)] rounded-lg border bg-card p-0 text-foreground shadow-xl backdrop:bg-black/40"
      >
        <div className="grid gap-3 p-5">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <ShieldAlert className="h-4 w-4 text-warning" /> {title}
          </h2>
          <p className="text-xs text-muted-foreground">
            This writes to <strong>{where}</strong> as you. It’s logged in Settings → Write log.
          </p>
          {extra}
          {preview && (
            <div className="max-h-80 overflow-auto rounded-md border bg-muted/40 p-3 text-sm whitespace-pre-wrap">
              {preview}
            </div>
          )}
          {result.error && (
            <p role="alert" className="text-sm text-danger">
              {result.error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => dialog.current?.close()}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button size="sm" onClick={confirm} disabled={pending} autoFocus={false}>
              {pending ? 'Sending…' : 'Confirm'}
            </Button>
          </div>
        </div>
      </dialog>
      {result.ok && (
        <span role="status" className="text-xs text-success">
          {result.ok}
          {result.url && (
            <a
              href={result.url}
              target="_blank"
              rel="noreferrer"
              className="ml-1 inline-flex items-center gap-0.5 underline"
            >
              open <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </span>
      )}
    </>
  );
}
