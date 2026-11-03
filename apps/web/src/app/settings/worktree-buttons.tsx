'use client';

import { AlertTriangle } from 'lucide-react';
import { useRef, useState, useTransition } from 'react';
import type { ActionResult } from '@/app/actions';
import { Button } from '@/components/ui/button';
import { confirmRemoveWorktree, keepWorktree } from './worktree-actions';

/** Remove anyway (after a confirmation listing what would be lost) or Keep. */
export function WorktreeButtons({
  id,
  path,
  uncommitted,
  unpushed,
}: {
  id: string;
  path: string;
  uncommitted: number;
  unpushed: string[];
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ActionResult>({});
  const act = (fn: (id: string) => Promise<ActionResult>) =>
    startTransition(async () => {
      const r = await fn(id);
      setResult(r);
      if (!r.error) dialog.current?.close();
    });

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="outline" disabled={pending} onClick={() => act(keepWorktree)}>
        Keep
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() => {
          setResult({});
          dialog.current?.showModal();
        }}
      >
        Remove anyway…
      </Button>
      {result.ok && (
        <span role="status" className="text-xs text-success">
          {result.ok}
        </span>
      )}
      {result.error && !dialog.current?.open && (
        <span role="alert" className="text-xs text-danger">
          {result.error}
        </span>
      )}
      <dialog
        ref={dialog}
        className="m-auto w-[min(600px,92vw)] rounded-lg border bg-card p-0 text-foreground shadow-xl backdrop:bg-black/40"
      >
        <div className="grid gap-3 p-5">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <AlertTriangle className="h-4 w-4 text-warning" /> Remove this worktree and its local
            work?
          </h2>
          <code className="text-xs break-all text-muted-foreground">{path}</code>
          <ul className="list-disc pl-5 text-sm">
            {uncommitted > 0 && (
              <li>
                {uncommitted} file{uncommitted === 1 ? '' : 's'} with uncommitted changes will be
                deleted.
              </li>
            )}
            {unpushed.length > 0 && (
              <li>
                {unpushed.length} commit{unpushed.length === 1 ? '' : 's'} not on any remote (the
                local branch keeps them):
                <pre className="mt-1 max-h-40 overflow-auto rounded bg-muted p-2 text-xs">
                  {unpushed.join('\n')}
                </pre>
              </li>
            )}
          </ul>
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
            <Button
              size="sm"
              variant="danger"
              onClick={() => act(confirmRemoveWorktree)}
              disabled={pending}
            >
              {pending ? 'Removing…' : 'Remove'}
            </Button>
          </div>
        </div>
      </dialog>
    </div>
  );
}
