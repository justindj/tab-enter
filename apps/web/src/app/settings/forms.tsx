'use client';

import {
  DEFAULT_MESSAGE_TEMPLATES,
  DEFAULT_TEMPLATES,
  MESSAGE_VARIABLES,
  SUGGESTION_KINDS,
  TEMPLATE_VARIABLES,
  type SuggestionKind,
} from '@tab-enter/core';
import { useActionState, useTransition, useState } from 'react';
import {
  createProfileAction,
  deleteProfileAction,
  saveClaudeSettingsAction,
  saveConnectionsAction,
  saveMessageSettingsAction,
  saveTemplatesAction,
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

const TEMPLATE_LABELS: Record<SuggestionKind, string> = {
  'next-ticket': 'Next ticket',
  'address-feedback': 'Address MR feedback',
  'fix-pipeline': 'Fix a failing pipeline',
  'resolve-conflicts': 'Resolve merge conflicts',
  review: 'Review a merge request',
};

export function TemplatesForm(props: {
  profileId: string;
  templates: Record<SuggestionKind, string>;
}) {
  const [state, action, pending] = useActionState(saveTemplatesAction, {});
  const [values, setValues] = useState(props.templates);
  return (
    <form action={action} className="grid gap-4">
      <input type="hidden" name="profileId" value={props.profileId} />
      <p className="text-xs text-muted-foreground">
        Variables:{' '}
        {TEMPLATE_VARIABLES.map((v) => (
          <code key={v} className="mr-1.5">
            {`{{${v}}}`}
          </code>
        ))}
        . A line whose variables are all empty is left out. Description, comments and logs are
        trimmed to the context caps.
      </p>
      {SUGGESTION_KINDS.map((kind) => (
        <Field
          key={kind}
          label={TEMPLATE_LABELS[kind]}
          hint={
            values[kind] !== DEFAULT_TEMPLATES[kind] ? (
              <button
                type="button"
                className="underline-offset-2 hover:underline"
                onClick={() => setValues({ ...values, [kind]: DEFAULT_TEMPLATES[kind] })}
              >
                Reset to default
              </button>
            ) : (
              'Default template'
            )
          }
        >
          <textarea
            name={kind}
            value={values[kind]}
            onChange={(e) => setValues({ ...values, [kind]: e.target.value })}
            rows={8}
            className="w-full rounded-md border bg-background px-2 py-1.5 font-mono text-xs"
          />
        </Field>
      ))}
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          Save templates
        </Button>
        <Result state={state} />
      </div>
    </form>
  );
}

/** datetime-local wants "YYYY-MM-DDTHH:mm" in local time. */
function toLocalInput(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function MessageSettingsForm(props: {
  profileId: string;
  window: {
    mode: 'last24h' | 'sinceLastReport' | 'sinceDate' | 'customHours';
    customHours?: number;
    sinceDate?: string;
    mondayCoversWeekend: boolean;
  };
  staleReviewHours: number;
  recentRetentionDays: number;
  templates: { 'daily-report': string; 'review-request': string };
}) {
  const [state, action, pending] = useActionState(saveMessageSettingsAction, {});
  const [mode, setMode] = useState(props.window.mode);
  const [daily, setDaily] = useState(props.templates['daily-report']);
  const [review, setReview] = useState(props.templates['review-request']);
  const resetHint = (
    value: string,
    kind: 'daily-report' | 'review-request',
    set: (v: string) => void,
  ) =>
    value !== DEFAULT_MESSAGE_TEMPLATES[kind] ? (
      <button
        type="button"
        className="underline-offset-2 hover:underline"
        onClick={() => set(DEFAULT_MESSAGE_TEMPLATES[kind])}
      >
        Reset to default
      </button>
    ) : (
      `Variables: ${MESSAGE_VARIABLES[kind].map((v) => `{{${v}}}`).join(' ')}. "# " lines are headings.`
    );

  return (
    <form action={action} className="grid gap-4">
      <input type="hidden" name="profileId" value={props.profileId} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Daily report covers">
          <Select name="mode" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
            <option value="last24h">The last 24 hours</option>
            <option value="sinceLastReport">Since my last copied report</option>
            <option value="customHours">A custom number of hours</option>
            <option value="sinceDate">Since a date and time</option>
          </Select>
        </Field>
        {mode === 'customHours' ? (
          <Field label="Hours">
            <Input
              name="customHours"
              type="number"
              min={1}
              defaultValue={props.window.customHours ?? 24}
              className="w-24"
            />
          </Field>
        ) : (
          <input type="hidden" name="customHours" value={props.window.customHours ?? ''} />
        )}
        {mode === 'sinceDate' ? (
          <Field label="Since">
            <Input
              name="sinceDate"
              type="datetime-local"
              defaultValue={toLocalInput(props.window.sinceDate)}
            />
          </Field>
        ) : (
          <input type="hidden" name="sinceDate" value={toLocalInput(props.window.sinceDate)} />
        )}
        <Checkbox
          name="mondayCoversWeekend"
          defaultChecked={props.window.mondayCoversWeekend}
          label="On Mondays, cover since Friday"
          hint="Applies to the 24-hour window and its fallbacks."
        />
        <Field
          label="Stale review after (hours)"
          hint="My MRs waiting longer are listed as blockers."
        >
          <Input
            name="staleReviewHours"
            type="number"
            min={1}
            step="1"
            defaultValue={props.staleReviewHours}
            className="w-24"
          />
        </Field>
        <Field label="Recently completed (days)" hint="How long done work stays on the Now page.">
          <Input
            name="recentRetentionDays"
            type="number"
            min={1}
            max={60}
            defaultValue={props.recentRetentionDays}
            className="w-24"
          />
        </Field>
      </div>
      <Field label="Daily report template" hint={resetHint(daily, 'daily-report', setDaily)}>
        <textarea
          name="dailyReport"
          value={daily}
          onChange={(e) => setDaily(e.target.value)}
          rows={9}
          className="w-full rounded-md border bg-background px-2 py-1.5 font-mono text-xs"
        />
      </Field>
      <Field label="Review request template" hint={resetHint(review, 'review-request', setReview)}>
        <textarea
          name="reviewRequest"
          value={review}
          onChange={(e) => setReview(e.target.value)}
          rows={4}
          className="w-full rounded-md border bg-background px-2 py-1.5 font-mono text-xs"
        />
      </Field>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          Save
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
  perRunUsd?: number;
  perDayUsd?: number;
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
        <Field
          label="Soft limit per run (USD)"
          hint="Runs over this are flagged. Nothing is stopped."
        >
          <Input
            name="perRunUsd"
            type="number"
            min={0}
            step="0.01"
            defaultValue={props.perRunUsd ?? ''}
            className="w-28"
          />
        </Field>
        <Field
          label="Soft limit per day (USD)"
          hint="The Now page warns once today's runs pass it."
        >
          <Input
            name="perDayUsd"
            type="number"
            min={0}
            step="0.01"
            defaultValue={props.perDayUsd ?? ''}
            className="w-28"
          />
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
