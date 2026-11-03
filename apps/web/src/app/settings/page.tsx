import { formatWatchedProjects, type ToolStatus } from '@tab-enter/core';
import type { ReactNode } from 'react';
import { requestToolDetection } from '@/app/actions';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { loadApp } from '@/lib/data';
import { timeAgo } from '@/lib/format';
import {
  ClaudeSettingsForm,
  ConnectionsForm,
  CreateProfileForm,
  DeleteProfileButton,
} from './forms';

function ToolRow({
  name,
  status,
  missing,
  now,
}: {
  name: string;
  status: ToolStatus | undefined;
  missing: ReactNode;
  now: Date;
}) {
  let badge: ReactNode;
  if (!status) badge = <Badge tone="muted">Checking…</Badge>;
  else if (!status.installed) badge = <Badge tone="warning">Not installed</Badge>;
  else if (status.meetsMinimum === false)
    badge = <Badge tone="danger">Too old (needs {status.minimumVersion}+)</Badge>;
  else badge = <Badge tone="success">Installed {status.version}</Badge>;

  return (
    <div className="grid gap-1 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{name}</span>
        {badge}
        {status?.tool === 'claude' && status.installed && (
          <Badge
            tone={status.loggedIn ? 'success' : status.loggedIn === false ? 'danger' : 'muted'}
          >
            {status.loggedIn
              ? 'Logged in'
              : status.loggedIn === false
                ? 'Logged out'
                : 'Login status unknown'}
          </Badge>
        )}
        {status && (
          <span className="text-xs text-muted-foreground">
            checked {timeAgo(status.checkedAt, now)}
          </span>
        )}
      </div>
      {status?.path && <code className="text-xs text-muted-foreground">{status.path}</code>}
      {status?.detail && <p className="text-xs text-warning">{status.detail}</p>}
      {status && !status.installed && (
        <div className="text-xs text-muted-foreground">{missing}</div>
      )}
    </div>
  );
}

export default async function SettingsPage() {
  const { profiles, active, tools, now } = await loadApp();
  const s = active.settings;

  return (
    <div className="mx-auto grid max-w-4xl gap-5">
      <h1 className="text-lg font-semibold">Settings</h1>

      <Card>
        <CardHeader
          title="Profiles"
          description="One per client or contract. Nothing is shared between profiles."
        />
        <CardBody className="grid gap-4">
          <ul className="divide-y rounded-md border">
            {profiles.map((p) => (
              <li key={p.id} className="flex items-center justify-between px-3 py-2">
                <span className="flex items-center gap-2">
                  {p.name}
                  {p.id === active.id && <Badge tone="info">Active</Badge>}
                  {p.isDemo && <Badge>Demo</Badge>}
                </span>
                {profiles.length > 1 && <DeleteProfileButton id={p.id} name={p.name} />}
              </li>
            ))}
          </ul>
          <CreateProfileForm />
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Tools"
          description="tab-enter runs your installed Claude Code CLI with your own login. No API key is needed."
          actions={
            <form action={requestToolDetection}>
              <Button variant="outline" size="sm" type="submit">
                Re-check
              </Button>
            </form>
          }
        />
        <CardBody className="divide-y">
          <ToolRow
            name="Claude Code"
            status={tools.claude}
            now={now}
            missing={
              <>
                Install the Claude Code CLI so <code>claude</code> is on your PATH, run{' '}
                <code>claude auth login</code>, then Re-check. The copy bundled inside the Claude
                desktop app is private to the app and isn’t on PATH. On Windows the native installer
                (claude.exe) is preferred over the npm package.
              </>
            }
          />
          <ToolRow
            name="RTK (Rust Token Killer)"
            status={tools.rtk}
            now={now}
            missing={
              <>
                Optional, recommended: it compresses command output before it reaches Claude Code.
              </>
            }
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Connections"
          description={
            active.isDemo
              ? 'The demo profile uses invented data and has no connections. Create a profile to connect Jira and GitLab.'
              : 'Tokens go straight to your OS keychain and are never sent back to the browser.'
          }
        />
        {!active.isDemo && (
          <CardBody>
            <ConnectionsForm
              key={active.id}
              profileId={active.id}
              name={active.name}
              jira={{
                deployment: s.jira.deployment,
                baseUrl: s.jira.baseUrl,
                email: s.jira.email,
                boardId: s.jira.boardId ?? '',
                doneStatuses: s.jira.doneStatuses.join(', '),
              }}
              gitlab={{
                baseUrl: s.gitlab.baseUrl,
                projects: formatWatchedProjects(s.gitlab.projects),
              }}
              storedSecrets={active.secretNames}
            />
          </CardBody>
        )}
      </Card>

      <Card>
        <CardHeader title="Claude Code and RTK" description={`For profile “${active.name}”`} />
        <CardBody>
          <ClaudeSettingsForm
            key={active.id}
            profileId={active.id}
            approvedForClient={s.claude.approvedForClient}
            maxParallelRuns={s.claude.maxParallelRuns}
            rtkMode={s.rtk.mode}
            rtkInstalled={tools.rtk?.installed ?? false}
          />
          <p className="mt-4 text-xs text-muted-foreground">
            RTK model routing, proxy and telemetry stay off. Each would send client content to
            another service and needs its own opt-in.
          </p>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Write actions"
          description="Anything that writes to Jira or GitLab is off by default and always asks for confirmation."
        />
        <CardBody>
          <ul className="grid gap-1 text-sm sm:grid-cols-2">
            {Object.entries(s.writeActions).map(([name, on]) => (
              <li
                key={name}
                className="flex items-center justify-between rounded border px-3 py-1.5"
              >
                <span>{name.replace(/([A-Z])/g, ' $1').toLowerCase()}</span>
                <Badge tone={on ? 'warning' : 'muted'}>{on ? 'On' : 'Off'}</Badge>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-muted-foreground">These become configurable in M7.</p>
        </CardBody>
      </Card>
    </div>
  );
}
