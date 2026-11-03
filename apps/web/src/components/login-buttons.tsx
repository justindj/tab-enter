'use client';

import { LogIn } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import type { ActionResult } from '@/app/actions';
import { claudeLoginAction, importGlabTokenAction, recheckClaudeAction } from '@/app/login-actions';
import { Button } from '@/components/ui/button';

function Message({ state }: { state: ActionResult }) {
  if (state.error)
    return (
      <span role="alert" className="text-xs text-danger">
        {state.error}
      </span>
    );
  if (state.ok)
    return (
      <span role="status" className="text-xs text-success">
        {state.ok}
      </span>
    );
  return null;
}

const POLL_MS = 4000;
const POLL_FOR_MS = 3 * 60_000;

/**
 * Opens a terminal with `claude auth login`, then re-checks every few seconds
 * until Claude Code reports a login (for up to three minutes).
 */
export function ClaudeLoginButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [state, setState] = useState<ActionResult>({});
  const [waiting, setWaiting] = useState(false);
  const until = useRef(0);

  useEffect(() => {
    if (!waiting) return;
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      const { loggedIn } = await recheckClaudeAction();
      if (stopped) return;
      if (loggedIn) {
        setWaiting(false);
        setState({ ok: 'Claude Code is logged in.' });
        router.refresh();
      } else if (Date.now() > until.current) {
        setWaiting(false);
        setState({ error: 'Still not logged in. Finish in the terminal, then click Re-check.' });
      } else setTimeout(tick, POLL_MS);
    };
    const timer = setTimeout(tick, POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [waiting, router]);

  return (
    <span className="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        size="sm"
        disabled={pending || waiting}
        onClick={() =>
          startTransition(async () => {
            const r = await claudeLoginAction();
            setState(r);
            if (!r.error) {
              until.current = Date.now() + POLL_FOR_MS;
              setWaiting(true);
            }
          })
        }
      >
        <LogIn className="h-3.5 w-3.5" />
        {waiting ? 'Waiting for sign-in…' : 'Log in to Claude Code'}
      </Button>
      <Message state={state} />
    </span>
  );
}

/** Copies the token glab is logged in with into the keychain, after checking it. */
export function GlabImportButton({ profileId }: { profileId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [state, setState] = useState<ActionResult>({});
  return (
    <span className="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={pending}
        title="Uses the saved GitLab URL. Save first if you changed it."
        onClick={() =>
          startTransition(async () => {
            const r = await importGlabTokenAction(profileId);
            setState(r);
            if (!r.error) router.refresh();
          })
        }
      >
        {pending ? 'Importing…' : 'Import token from glab'}
      </Button>
      <Message state={state} />
    </span>
  );
}
