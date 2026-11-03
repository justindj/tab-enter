'use client';

import { ArrowRightLeft } from 'lucide-react';
import { useState, useTransition } from 'react';
import { loadTransitionsAction } from '@/app/writes/actions';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/field';
import { WriteButton } from '@/components/write-button';

/** Load a ticket's workflow transitions, pick one, confirm. */
export function MoveTicket({
  issueKey,
  status,
  allowed,
}: {
  issueKey: string;
  status: string;
  allowed: boolean;
}) {
  const [transitions, setTransitions] = useState<{ id: string; name: string; to: string }[] | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState('');
  const [pending, startTransition] = useTransition();
  const chosen = transitions?.find((t) => t.id === pick);

  if (!allowed) {
    return (
      <Button
        size="sm"
        variant="ghost"
        disabled
        title="“Move Jira tickets” is off. Turn it on in Settings → Write actions."
      >
        <ArrowRightLeft className="h-3.5 w-3.5" /> Move ticket
      </Button>
    );
  }
  if (!transitions) {
    return (
      <span className="flex items-center gap-2">
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const r = await loadTransitionsAction(issueKey);
              if (r.error) setError(r.error);
              else setTransitions(r.transitions ?? []);
            })
          }
        >
          <ArrowRightLeft className="h-3.5 w-3.5" /> {pending ? 'Loading…' : 'Move ticket…'}
        </Button>
        {error && <span className="text-xs text-danger">{error}</span>}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-2">
      <Select
        aria-label={`Transition for ${issueKey}`}
        value={pick}
        onChange={(e) => setPick(e.target.value)}
        className="h-7 w-auto text-xs"
      >
        <option value="">{transitions.length ? 'Move to…' : 'No transitions available'}</option>
        {transitions.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
            {t.to && t.to !== t.name ? ` → ${t.to}` : ''}
          </option>
        ))}
      </Select>
      <WriteButton
        label="Move"
        enabled={!!chosen}
        disabledReason="Pick a transition."
        title={`Move ${issueKey}?`}
        where={`Jira · ${issueKey}`}
        preview={
          chosen ? `${status} → ${chosen.to || chosen.name} (transition “${chosen.name}”)` : ''
        }
        action={() =>
          chosen
            ? {
                kind: 'jira-transition',
                issueKey,
                transitionId: chosen.id,
                transitionName: chosen.name,
              }
            : null
        }
      />
    </span>
  );
}
