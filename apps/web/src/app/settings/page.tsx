import { formatWatchedProjects, type ToolStatus } from '@tab-enter/core';
import {
  getDb,
  listWorktrees,
  listWriteActions,
  usageSummary,
  type UsageRow,
  type UsageSummary,
} from '@tab-enter/db';
import { EmptyState } from '@/components/empty-state';
import type { ReactNode } from 'react';
import { requestToolDetection } from '@/app/actions';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ClaudeLoginButton } from '@/components/login-buttons';
import { ThemePicker } from '@/components/shell/theme-picker';
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
  WriteActionsForm,
} from './forms';
import { WorktreeButtons } from './worktree-buttons';

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
        {status?.tool === 'claude' && status.installed && !status.loggedIn && <ClaudeLoginButton />}
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

function RtkSavings({ rtk }: { rtk: ToolStatus | undefined }) {
  const s = rtk?.savings;
  if (!rtk?.installed) return null;
  return (
    <p className="text-xs text-muted-foreground">
      {s && s.commands > 0 ? (
        <>
          RTK has saved about <strong>{formatTokens(s.savedTokens)}</strong> ({Math.round(s.avgPct)}
          % of command output) across {plural(s.commands, 'command')}, by its own estimate (
          <code>rtk gain</code>, all projects).
        </>
      ) : (
        <>RTK is installed but has no savings recorded yet.</>
      )}
    </p>
  );
}

function UsagePanel({
  usage,
  presets,
  rtk,
}: {
  usage: UsageSummary;
  presets: Record<string, { label: string }>;
  rtk: ToolStatus | undefined;
}) {
  if (usage.total.runs === 0) {
    return (
      <CardBody className="grid gap-3">
        <EmptyState title="No runs in the last 7 days" />
        <RtkSavings rtk={rtk} />
      </CardBody>
    );
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
      <RtkSavings rtk={rtk} />
    </CardBody>
  );
}

export default async function SettingsPage() {
  const { profiles, active, tools, now, theme } = await loadApp();
  const s = active.settings;
  const db = await getDb();
  const [usage, writes, worktreeRows] = await Promise.all([
    usageSummary(db, active.id, new Date(now.getTime() - 7 * 86_400_000), now),
    listWriteActions(db, active.id, 50),
    listWorktrees(db, active.id),
  ]);
  // Decisions first, then the most recent cleanups.
  const trees = [
    ...worktreeRows.filter((w) => w.status === 'needs_confirmation'),
    ...worktreeRows.filter((w) => w.status !== 'needs_confirmation').slice(0, 8),
  ];

  return (
    <div className="mx-auto grid max-w-4xl gap-5">
      <h1 className="text-lg font-semibold">Settings</h1>

      <Card>
        <CardHeader
          title="Appearance"
          description="Applies to every profile. System follows your operating system's setting."
          actions={<ThemePicker theme={theme} showLabels />}
        />
      </Card>

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
                tokenExpiresAt: s.jira.tokenExpiresAt ?? '',
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
        <UsagePanel usage={usage} presets={s.claude.presets} rtk={tools.rtk} />
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
                captureBefore={s.verification.captureBefore}
                projects={s.gitlab.projects.map((p) => ({
                  label: p.path || p.id,
                  baseUrl: p.verification.baseUrl ?? '',
                  startCommand: p.verification.startCommand ?? '',
                  specCommand: p.verification.specCommand ?? '',
                  uiPages: p.verification.uiPages ?? '',
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
          <WriteActionsForm
            key={active.id}
            profileId={active.id}
            values={s.writeActions}
            isDemo={active.isDemo}
          />
        </CardBody>
      </Card>

      {!active.isDemo && (
        <Card id="worktrees">
          <CardHeader
            title="Worktrees"
            description="When a branch’s MR merges or closes, tab-enter removes its worktree. Ones with uncommitted or unpushed work wait for you here."
          />
          {trees.length === 0 ? (
            <EmptyState title="Nothing cleaned up or waiting" />
          ) : (
            <ul className="divide-y">
              {trees.map((w) => (
                <li key={w.id} className="grid gap-1.5 px-4 py-2.5 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge
                      tone={
                        w.status === 'removed'
                          ? 'success'
                          : w.status === 'kept'
                            ? 'muted'
                            : 'warning'
                      }
                    >
                      {w.status === 'removed'
                        ? 'Removed'
                        : w.status === 'kept'
                          ? 'Kept'
                          : 'Needs your decision'}
                    </Badge>
                    <span className="font-medium">{w.branch}</span>
                    <span className="text-xs text-muted-foreground">
                      MR {w.mrKey} {w.reason} · {timeAgo(w.updatedAt, now)}
                    </span>
                  </div>
                  <code className="text-xs break-all text-muted-foreground">{w.path}</code>
                  {w.status === 'needs_confirmation' && (
                    <>
                      <p className="text-xs">
                        {[
                          w.uncommitted > 0 && plural(w.uncommitted, 'uncommitted file'),
                          w.unpushed.length > 0 && plural(w.unpushed.length, 'unpushed commit'),
                        ]
                          .filter(Boolean)
                          .join(', ') || 'git refused to remove it'}
                        {w.error && <span className="text-danger"> · {w.error}</span>}
                      </p>
                      <WorktreeButtons
                        id={w.id}
                        path={w.path}
                        uncommitted={w.uncommitted}
                        unpushed={w.unpushed}
                      />
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      <Card id="write-log">
        <CardHeader
          title="Write log"
          description="Every write tab-enter made (or tried) for this profile: what, where, when, and the exact payload."
        />
        {writes.length === 0 ? (
          <EmptyState title="Nothing written yet" />
        ) : (
          <ul className="divide-y">
            {writes.map((w) => (
              <li key={w.id} className="px-4 py-2 text-sm">
                <details>
                  <summary className="flex cursor-pointer flex-wrap items-center gap-2">
                    <Badge
                      tone={
                        w.status === 'done' ? 'success' : w.status === 'failed' ? 'danger' : 'info'
                      }
                    >
                      {w.status === 'done' ? 'Done' : w.status === 'failed' ? 'Failed' : 'Pending'}
                    </Badge>
                    <span className="min-w-0 flex-1">
                      {w.summary} <span className="text-muted-foreground">· {w.target}</span>
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {w.createdAt.toLocaleString()}
                    </span>
                  </summary>
                  <div className="mt-2 grid gap-1 text-xs">
                    {w.result?.message && <p>{w.result.message}</p>}
                    {w.result?.url && (
                      <a href={w.result.url} target="_blank" rel="noreferrer" className="underline">
                        {w.result.url}
                      </a>
                    )}
                    {w.error && <p className="text-danger">{w.error}</p>}
                    <pre className="max-h-60 overflow-auto rounded bg-muted p-2 whitespace-pre-wrap">
                      {JSON.stringify(w.payload, null, 2)}
                    </pre>
                  </div>
                </details>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
