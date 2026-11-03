'use client';

import { useActionState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { startSetupAction } from './actions';

export function ProfileStep() {
  const [state, action, pending] = useActionState(startSetupAction, {});
  return (
    <form action={action} className="grid gap-4">
      <Field
        label="Profile name"
        hint="Usually the client or contract. You can add more profiles later, one per client."
      >
        <Input name="name" placeholder="e.g. Acme" required maxLength={60} autoFocus />
      </Field>
      {state.error && (
        <p role="alert" className="text-xs text-danger">
          {state.error}
        </p>
      )}
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? 'Creating…' : 'Create profile and continue'}
        </Button>
      </div>
    </form>
  );
}
