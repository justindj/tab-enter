'use client';

import { GitPullRequestArrow, Upload } from 'lucide-react';
import { useRef } from 'react';
import { WriteButton } from '@/components/write-button';
import { Field, Input } from '@/components/ui/field';

/** After a task run: what's unpushed, and the gated Push / Open MR actions. */
export function BranchActions({
  runId,
  branch,
  commits,
  uncommitted,
  hasMr,
  allowPush,
  allowOpenMr,
  defaults,
}: {
  runId: string;
  branch: string;
  commits: string[];
  uncommitted: number;
  hasMr: boolean;
  allowPush: boolean;
  allowOpenMr: boolean;
  defaults: { title: string; description: string; targetBranch: string };
}) {
  const title = useRef<HTMLInputElement>(null);
  const target = useRef<HTMLInputElement>(null);
  const description = useRef<HTMLTextAreaElement>(null);
  const off = (name: string) => `“${name}” is off. Turn it on in Settings → Write actions.`;

  return (
    <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2 text-xs">
      <span>
        Branch <code>{branch}</code>:{' '}
        {commits.length > 0
          ? `${commits.length} commit${commits.length === 1 ? '' : 's'} not pushed`
          : 'nothing unpushed'}
        {uncommitted > 0 && (
          <span className="text-warning">
            {' '}
            · {uncommitted} file{uncommitted === 1 ? '' : 's'} with uncommitted changes (not pushed)
          </span>
        )}
      </span>
      <span className="ml-auto flex flex-wrap items-center gap-2">
        <WriteButton
          label="Push branch"
          icon={<Upload className="h-3.5 w-3.5" />}
          enabled={allowPush && commits.length > 0}
          disabledReason={allowPush ? 'No unpushed commits.' : off('Push branches')}
          title={`Push ${branch}?`}
          where={`origin (${branch})`}
          action={{ kind: 'git-push', runId }}
          preview={
            <>
              <p className="mb-2 text-xs text-muted-foreground">
                Commits to push (never forced; a rejected push is reported, not overridden):
              </p>
              <ul className="font-mono text-xs">
                {commits.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </>
          }
        />
        {!hasMr && (
          <WriteButton
            label="Open merge request"
            icon={<GitPullRequestArrow className="h-3.5 w-3.5" />}
            enabled={allowOpenMr}
            disabledReason={off('Open merge requests')}
            title="Open a merge request?"
            where={`GitLab (${branch})`}
            extra={
              <div className="grid gap-2">
                <Field label="Title">
                  <Input ref={title} defaultValue={defaults.title} />
                </Field>
                <Field label="Target branch">
                  <Input ref={target} defaultValue={defaults.targetBranch} className="w-48" />
                </Field>
                <Field label="Description">
                  <textarea
                    ref={description}
                    defaultValue={defaults.description}
                    rows={6}
                    className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
                  />
                </Field>
                <p className="text-xs text-muted-foreground">
                  Push the branch first; GitLab needs it on origin.
                </p>
              </div>
            }
            action={() => ({
              kind: 'open-mr',
              runId,
              title: title.current?.value.trim() || defaults.title,
              targetBranch: target.current?.value.trim() || defaults.targetBranch,
              description: description.current?.value ?? '',
            })}
          />
        )}
      </span>
    </div>
  );
}
