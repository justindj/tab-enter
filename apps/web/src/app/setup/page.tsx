import { formatWatchedProjects, type ConnectionState } from '@tab-enter/core';
import { Check } from 'lucide-react';
import Link from 'next/link';
import { requestToolDetection } from '@/app/actions';
import { ConnectionsForm } from '@/app/settings/forms';
import { ClaudeLoginButton } from '@/components/login-buttons';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/field';
import { loadApp } from '@/lib/data';
import { cn } from '@/lib/utils';
import { finishSetupAction, setupClaudeAction, skipSetupAction } from './actions';
import { ProfileStep } from './profile-step';

// First-run setup: name a profile, connect Jira and GitLab, set up Claude
// Code, then open the app on real data. Each step is a URL (?step=), so Back
// and reloads work, and everything saved here is editable later in Settings.

const STEPS = [
  { id: 'profile', label: 'Profile' },
  { id: 'connect', label: 'Jira and GitLab' },
  { id: 'claude', label: 'Claude Code' },
  { id: 'done', label: 'Finish' },
] as const;
type StepId = (typeof STEPS)[number]['id'];

const TONE: Record<ConnectionState, 'success' | 'warning' | 'danger' | 'info' | 'muted'> = {
  ok: 'success',
  warning: 'warning',
  error: 'danger',
  demo: 'info',
  off: 'muted',
};

export default async function SetupPage({
  searchParams,
}: {
  searchParams: Promise<{ step?: string }>;
}) {
  const { active, tools, connections, profiles } = await loadApp();
  const hasReal = !active.isDemo;
  const asked = (await searchParams).step;
  // Without a real active profile, only the first step makes sense.
  const step: StepId = !hasReal
    ? 'profile'
    : STEPS.some((s) => s.id === asked && s.id !== 'profile')
      ? (asked as StepId)
      : 'connect';
  const index = STEPS.findIndex((s) => s.id === step);
  const s = active.settings;
  const claude = tools.claude;

  return (
    <div className="mx-auto grid max-w-3xl gap-5">
      <div className="grid gap-1">
        <h1 className="text-lg font-semibold">Set up tab-enter</h1>
        <p className="text-sm text-muted-foreground">
          Connect your own Jira, GitLab and Claude Code. Tokens go to your OS keychain, never to the
          browser or the repo. Everything here can be changed later in Settings.
        </p>
      </div>

      <ol className="flex flex-wrap gap-2 text-xs" aria-label="Setup steps">
        {STEPS.map((st, i) => (
          <li
            key={st.id}
            aria-current={i === index ? 'step' : undefined}
            className={cn(
              'flex items-center gap-1.5 rounded-full border px-2.5 py-1',
              i === index && 'border-primary text-foreground',
              i !== index && 'text-muted-foreground',
            )}
          >
            {i < index ? <Check className="h-3 w-3 text-success" /> : <span>{i + 1}.</span>}
            {st.label}
          </li>
        ))}
      </ol>

      {step === 'profile' && (
        <Card>
          <CardHeader
            title="Name your profile"
            description="A profile holds one client's connections, data and settings. Nothing is shared between profiles."
          />
          <CardBody className="grid gap-4">
            <ProfileStep />
            <form action={skipSetupAction} className="border-t pt-3">
              <p className="text-xs text-muted-foreground">
                Not ready to connect yet?{' '}
                <button type="submit" className="underline">
                  Explore the demo first
                </button>{' '}
                (invented data, no tokens needed). Setup stays available from the header.
              </p>
            </form>
          </CardBody>
        </Card>
      )}

      {step === 'connect' && (
        <Card>
          <CardHeader
            title="Connect Jira and GitLab"
            description="Fill in what you use, click Save, then Test connection. Either can be left for later."
          />
          <CardBody className="grid gap-4">
            <ul className="grid gap-1 text-xs text-muted-foreground">
              <li>
                <strong className="text-foreground">Jira Cloud token:</strong>{' '}
                <a
                  className="underline"
                  href="https://id.atlassian.com/manage-profile/security/api-tokens"
                  target="_blank"
                  rel="noreferrer"
                >
                  id.atlassian.com → API tokens
                </a>
                . Data Center: your profile → Personal Access Tokens.
              </li>
              <li>
                <strong className="text-foreground">GitLab token:</strong> your avatar → Edit
                profile → Access tokens. Scope <code>read_api</code> to read; <code>api</code> if
                you’ll enable write actions.
              </li>
              <li>
                <strong className="text-foreground">Watched projects:</strong> add{' '}
                <code>= C:\path\to\clone</code> after a project so Claude Code can work on its code.
              </li>
            </ul>
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
            <div className="flex justify-end border-t pt-3">
              <Link href="/setup?step=claude" className={buttonVariants()}>
                Next: Claude Code
              </Link>
            </div>
          </CardBody>
        </Card>
      )}

      {step === 'claude' && (
        <Card>
          <CardHeader
            title="Claude Code"
            description="tab-enter runs your installed Claude Code CLI with your own login. No API key is needed."
            actions={
              <form action={requestToolDetection}>
                <Button variant="outline" size="sm" type="submit">
                  Re-check
                </Button>
              </form>
            }
          />
          <CardBody className="grid gap-4">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              {!claude ? (
                <Badge>Checking…</Badge>
              ) : !claude.installed ? (
                <Badge tone="warning">Not installed</Badge>
              ) : (
                <>
                  <Badge tone="success">Installed {claude.version}</Badge>
                  <Badge
                    tone={
                      claude.loggedIn ? 'success' : claude.loggedIn === false ? 'danger' : 'muted'
                    }
                  >
                    {claude.loggedIn
                      ? 'Logged in'
                      : claude.loggedIn === false
                        ? 'Logged out'
                        : 'Login status unknown'}
                  </Badge>
                </>
              )}
            </div>
            {!claude?.installed && (
              <ol className="list-decimal pl-5 text-sm">
                <li>
                  Install the Claude Code CLI so <code>claude --version</code> works in a new
                  terminal. The copy inside the Claude desktop app doesn’t count.
                </li>
                <li>Click Re-check above, then log in.</li>
              </ol>
            )}
            {claude?.installed && !claude.loggedIn && (
              <div className="grid gap-1">
                <ClaudeLoginButton />
                <p className="text-xs text-muted-foreground">
                  Opens a terminal running <code>claude auth login</code>; finish in your browser.
                  This page notices when you’re signed in.
                </p>
              </div>
            )}
            <form action={setupClaudeAction} className="grid gap-3 border-t pt-3">
              <Checkbox
                name="approved"
                defaultChecked={s.claude.approvedForClient}
                label={`Claude Code is approved for ${active.name}`}
                hint="Only tick this if the client allows AI on their code. While off, AI buttons become Copy prompt."
              />
              <div className="flex justify-between">
                <Link href="/setup?step=connect" className={buttonVariants({ variant: 'ghost' })}>
                  Back
                </Link>
                <Button type="submit">Save and continue</Button>
              </div>
            </form>
          </CardBody>
        </Card>
      )}

      {step === 'done' && (
        <Card>
          <CardHeader
            title="Ready"
            description="Here’s where things stand. Anything not green can be fixed now or later in Settings."
          />
          <CardBody className="grid gap-4">
            <ul className="divide-y rounded-md border">
              {connections
                .filter((c) => c.id !== 'slack')
                .map((c) => (
                  <li key={c.id} className="flex items-center justify-between gap-3 px-3 py-2">
                    <span className="text-sm font-medium">{c.label}</span>
                    <Badge tone={TONE[c.state]}>{c.detail}</Badge>
                  </li>
                ))}
              <li className="flex items-center justify-between gap-3 px-3 py-2">
                <span className="text-sm font-medium">Claude Code for {active.name}</span>
                <Badge tone={s.claude.approvedForClient ? 'success' : 'muted'}>
                  {s.claude.approvedForClient ? 'Approved' : 'Not approved: Copy prompt only'}
                </Badge>
              </li>
            </ul>
            <p className="text-xs text-muted-foreground">
              Optional extras in Settings: verification test URLs, write actions (all off by
              default), templates and time windows.
            </p>
            <form action={finishSetupAction} className="grid gap-3 border-t pt-3">
              {profiles.some((p) => p.isDemo) && (
                <Checkbox
                  name="removeDemo"
                  defaultChecked
                  label="Remove the demo profile"
                  hint="It only holds invented data. You can always explore it again on a fresh install."
                />
              )}
              <div className="flex justify-between">
                <Link href="/setup?step=claude" className={buttonVariants({ variant: 'ghost' })}>
                  Back
                </Link>
                <Button type="submit">Open tab-enter</Button>
              </div>
            </form>
          </CardBody>
        </Card>
      )}
    </div>
  );
}
