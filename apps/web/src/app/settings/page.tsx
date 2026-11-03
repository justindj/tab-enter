import { formatWatchedProjects, type ToolStatus } from '@tab-enter/core';
import { getDb, usageSummary, type UsageRow, type UsageSummary } from '@tab-enter/db';
import { EmptyState } from '@/components/empty-state';
import type { ReactNode } from 'react';
import { requestToolDetection } from '@/app/actions';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { loadApp } from '@/lib/data';
import { formatTokens, formatUsd, plural, timeAgo } from '@/lib/format';
import {
  ClaudeSettingsForm,
  ConnectionsForm,
  CreateProfileForm,
  DeleteProfileButton,
  MessageSettingsForm,
  TemplatesForm,
  VerificationSettingsForm,
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

function UsagePanel({
  usage,
  presets,
}: {
  usage: UsageSummary;
  presets: Record<string, { label: string }>;
}) {
  if (usage.total.runs === 0) {
    return <EmptyState title="No runs in the last 7 days" />;
  }
  const table = (title: string, rows: UsageRow[], label: (k: string) => string) => (
    <div>
      <h3 className="mb-1 text-xs font-semibold">{title}</h3>
      <table className="w-full text-xs tabular-nums">
        <tbody>
          {rows.slice(0, 8).map((r) => (
            <tr key={r.key} className="border-b last:border-0">
              <td className="py-1 pr-2">{label(r.key)}</td>
              <td className="py-1 pr-2 text-right text-muted-foreground">
                {plural(r.runs, 'run')}
              </td>
              <td className="py-1 pr-2 text-right text-muted-foreground">
                {formatTokens(r.inputTokens + r.outputTokens)}
              </td>
              <td className="py-1 text-right">{formatUsd(r.costUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
  return (
    <CardBody className="grid gap-4">
      <p className="text-sm">
        {plural(usage.total.runs, 'run')} ·{' '}
        {formatTokens(usage.total.inputTokens + usage.total.outputTokens)} (plus{' '}
        {formatTokens(usage.total.cacheReadTokens)} read from cache) ·{' '}
        <strong>{formatUsd(usage.total.costUsd)}</strong>
      </p>
      <div className="grid gap-4 md:grid-cols-3">
        {table('Per day', usage.byDay, (k) => k)}
        {table('Per preset', usage.byPreset, (k) => presets[k]?.label ?? k)}
        {table('Per ticket', usage.byTicket, (k) => k)}
      </div>
      <p className="text-xs text-muted-foreground">
        RTK savings (`rtk gain`) will show here once RTK reporting is wired up.
      </p>
    </CardBody>
  );
}

export default async function SettingsPage() {
  const { profiles, active, tools, now } = await loadApp();
  const s = active.settings;
  const usage = await usageSummary(
    await getDb(),
    active.id,
    new Date(now.getTime() - 7 * 86_400_000),
    now,
  );

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
            perRunUsd={s.claude.softLimits.perRunUsd}
            perDayUsd={s.claude.softLimits.perDayUsd}
          />
          <p className="mt-4 text-xs text-muted-foreground">
            RTK model routing, proxy and telemetry stay off. Each would send client content to
            another service and needs its own opt-in.
          </p>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Usage"
          description="Tokens and cost as Claude Code reported them, last 7 days, this profile."
        />
        <UsagePanel usage={usage} presets={s.claude.presets} />
      </Card>

      <Card>
        <CardHeader
          title="Verification"
          description={
            active.isDemo
              ? 'The demo simulates walkthroughs; create a profile to verify a real app.'
              : 'Where each project’s app runs for browser walkthroughs (Playwright drives your installed Edge or Chrome).'
          }
        />
        {!active.isDemo && (
          <CardBody>
            {s.gitlab.projects.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Add watched projects under Connections first.
              </p>
            ) : (
              <VerificationSettingsForm
                key={active.id}
                profileId={active.id}
                captureVideo={s.verification.captureVideo}
                projects={s.gitlab.projects.map((p) => ({
                  label: p.path || p.id,
                  baseUrl: p.verification.baseUrl ?? '',
                  startCommand: p.verification.startCommand ?? '',
                  hasCredentials: !!p.verification.testCredentialsSecret,
                  hasClone: !!p.localPath,
                }))}
              />
            )}
          </CardBody>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Messages and time windows"
          description="The Communication page's daily report and review request."
        />
        <CardBody>
          <MessageSettingsForm
            key={active.id}
            profileId={active.id}
            window={s.timeWindows.dailyReport}
            staleReviewHours={s.timeWindows.staleReviewHours}
            recentRetentionDays={s.timeWindows.recentRetentionDays}
            templates={s.messageTemplates}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Prompt templates"
          description="One per Up next suggestion. You can still edit each prompt before running it."
        />
        <CardBody>
          <TemplatesForm key={active.id} profileId={active.id} templates={s.promptTemplates} />
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
