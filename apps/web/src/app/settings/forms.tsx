'use client';

import { useActionState, useTransition, useState } from 'react';
import {
  createProfileAction,
  deleteProfileAction,
  saveClaudeSettingsAction,
  saveConnectionsAction,
  testConnectionsAction,
  type ActionResult,
  type ConnectionTestResult,
} from '@/app/actions';
import { Button } from '@/components/ui/button';
import { Checkbox, Field, Input, Select } from '@/components/ui/field';

function Result({ state }: { state: ActionResult }) {
  if (state.error)
    return (
      <p className="text-xs text-danger" role="alert">
        {state.error}
      </p>
    );
  if (state.ok)
    return (
      <p className="text-xs text-success" role="status">
        {state.ok}
      </p>
    );
  return null;
}

export function CreateProfileForm() {
  const [state, action, pending] = useActionState(createProfileAction, {});
  return (
    <form action={action} className="flex items-end gap-2">
      <Field label="New profile">
        <Input name="name" placeholder="Client name" required maxLength={60} className="w-56" />
      </Field>
      <Button type="submit" disabled={pending}>
        Create
      </Button>
      <Result state={state} />
    </form>
  );
}

export function DeleteProfileButton({ id, name }: { id: string; name: string }) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ActionResult>({});
  return (
    <span className="flex items-center gap-2">
      <Button
        variant="ghost"
        size="sm"
        className="text-danger"
        disabled={pending}
        onClick={() => {
          if (
            !window.confirm(
              `Delete “${name}”? This wipes its cached data, run logs, artifacts and stored tokens.`,
            )
          )
            return;
          startTransition(async () => setResult(await deleteProfileAction(id)));
        }}
      >
        Delete
      </Button>
      <Result state={result} />
    </span>
  );
}

export function ConnectionsForm(props: {
  profileId: string;
  name: string;
  jira: {
    deployment: 'cloud' | 'datacenter';
    baseUrl: string;
    email: string;
    boardId: string;
    doneStatuses: string;
  };
  gitlab: { baseUrl: string; projects: string };
  storedSecrets: string[];
}) {
  const [state, action, pending] = useActionState(saveConnectionsAction, {});
  const [deployment, setDeployment] = useState(props.jira.deployment);
  const [testing, startTest] = useTransition();
  const [test, setTest] = useState<ConnectionTestResult | null>(null);
  const stored = (name: string) => props.storedSecrets.includes(name);

  return (
    <form action={action} className="grid gap-5">
      <input type="hidden" name="profileId" value={props.profileId} />
      <Field label="Profile name">
        <Input name="name" defaultValue={props.name} required maxLength={60} className="max-w-sm" />
      </Field>

      <fieldset className="grid gap-3">
        <legend className="mb-2 text-sm font-semibold">Jira</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Deployment">
            <Select
              name="jiraDeployment"
              value={deployment}
              onChange={(e) => setDeployment(e.target.value as 'cloud' | 'datacenter')}
            >
              <option value="cloud">Jira Cloud (email + API token)</option>
              <option value="datacenter">Jira Data Center (personal access token)</option>
            </Select>
          </Field>
          <Field label="Base URL">
            <Input
              name="jiraBaseUrl"
              type="url"
              defaultValue={props.jira.baseUrl}
              placeholder="https://your-site.atlassian.net"
            />
          </Field>
          {deployment === 'cloud' && (
            <Field label="Account email">
              <Input
                name="jiraEmail"
                type="email"
                defaultValue={props.jira.email}
                autoComplete="off"
              />
            </Field>
          )}
          {deployment === 'datacenter' && (
            <input type="hidden" name="jiraEmail" value={props.jira.email} />
          )}
          <Field
            label={deployment === 'cloud' ? 'API token' : 'Personal access token'}
            hint={
              stored('jira-token')
                ? 'A token is stored in your keychain. Leave blank to keep it.'
                : 'Read-only access is enough for v1.'
            }
          >
            <Input
              name="jiraToken"
              type="password"
              autoComplete="off"
              placeholder={stored('jira-token') ? '••••••••' : ''}
            />
          </Field>
          <Field
            label="Board id (optional)"
            hint="Limits “current sprint” to this board’s active sprints. Otherwise all open sprints count."
          >
            <Input name="jiraBoardId" inputMode="numeric" defaultValue={props.jira.boardId} />
          </Field>
          <Field
            label="Done-like statuses (optional)"
            hint="Comma-separated status names to treat as done, e.g. Ready for Release."
          >
            <Input name="jiraDoneStatuses" defaultValue={props.jira.doneStatuses} />
          </Field>
        </div>
        {test && <Result state={test.jira} />}
      </fieldset>

      <fieldset className="grid gap-3">
        <legend className="mb-2 text-sm font-semibold">GitLab</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Base URL" hint="gitlab.com or your self-managed instance.">
            <Input name="gitlabBaseUrl" type="url" defaultValue={props.gitlab.baseUrl} />
          </Field>
          <Field
            label="Personal access token"
            hint={
              stored('gitlab-token')
                ? 'A token is stored in your keychain. Leave blank to keep it.'
                : 'Scope read_api is enough. Write actions (M7) need the api scope.'
            }
          >
            <Input
              name="gitlabToken"
              type="password"
              autoComplete="off"
              placeholder={stored('gitlab-token') ? '••••••••' : ''}
            />
          </Field>
        </div>
        <Field
          label="Watched projects (optional)"
          hint="One GitLab project path or id per line, optionally “= local clone path”. Leave empty to include every project."
        >
          <textarea
            name="gitlabProjects"
            rows={3}
            defaultValue={props.gitlab.projects}
            placeholder={'group/project = C:\\code\\project'}
            className="w-full rounded-md border bg-background px-2 py-1.5 font-mono text-xs placeholder:text-muted-foreground"
          />
        </Field>
        {test && <Result state={test.gitlab} />}
      </fieldset>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          Save
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={testing}
          title="Checks the saved URL and token. Save first if you changed them."
          onClick={() =>
            startTest(async () => setTest(await testConnectionsAction(props.profileId)))
          }
        >
          {testing ? 'Testing…' : 'Test connection'}
        </Button>
        <Result state={state} />
      </div>
    </form>
  );
}

export function ClaudeSettingsForm(props: {
  profileId: string;
  approvedForClient: boolean;
  maxParallelRuns: number;
  rtkMode: 'off' | 'global' | 'per-run';
  rtkInstalled: boolean;
}) {
  const [state, action, pending] = useActionState(saveClaudeSettingsAction, {});
  return (
    <form action={action} className="grid gap-4">
      <input type="hidden" name="profileId" value={props.profileId} />
      <Checkbox
        name="approvedForClient"
        defaultChecked={props.approvedForClient}
        label="Claude Code is approved for this client"
        hint="While off, every AI button is replaced by Copy prompt."
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Max parallel runs" hint="Further runs wait in a queue.">
          <Input
            name="maxParallelRuns"
            type="number"
            min={1}
            max={8}
            defaultValue={props.maxParallelRuns}
            className="w-24"
          />
        </Field>
        <Field
          label="RTK mode"
          hint={
            props.rtkInstalled
              ? 'Per-run passes RTK’s hook in a run-only settings file; your global Claude settings are never edited.'
              : 'RTK is not installed; Global and Per-run have no effect until it is.'
          }
        >
          <Select name="rtkMode" defaultValue={props.rtkMode}>
            <option value="off">Off</option>
            <option value="global">Global (you ran `rtk init --global`)</option>
            <option value="per-run">Per-run</option>
          </Select>
        </Field>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          Save
        </Button>
        <Result state={state} />
      </div>
    </form>
  );
}
