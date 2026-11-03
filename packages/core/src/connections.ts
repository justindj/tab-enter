import type { ProfileSettings } from './settings';
import type { ToolStatus } from './types';

export type ConnectionId = 'jira' | 'gitlab' | 'claude' | 'slack';

/**
 * ok: working. warning: usable but needs attention. error: broken.
 * demo: showing invented data. off: not set up (or not part of tab-enter yet).
 */
export type ConnectionState = 'ok' | 'warning' | 'error' | 'demo' | 'off';

export interface Connection {
  id: ConnectionId;
  label: string;
  state: ConnectionState;
  detail: string;
}

export interface ConnectionInputs {
  isDemo: boolean;
  settings: ProfileSettings;
  /** Names of secrets stored for the profile (never their values). */
  secretNames: string[];
  syncStates: {
    source: 'jira' | 'gitlab';
    lastSyncedAt: Date | null;
    lastError: string | null;
    /** As the service reported it during sync (GitLab); null when unknown. */
    tokenExpiresAt?: string | null;
  }[];
  claude: ToolStatus | undefined;
  now?: Date;
}

/** Warn this many days before a token's known expiry. */
export const TOKEN_EXPIRY_WARNING_DAYS = 14;

/** Days until a token expires (negative once expired), or null when unknown. */
export function daysUntil(iso: string | undefined, now: Date): number | null {
  if (!iso) return null;
  const t = Date.parse(iso.length === 10 ? `${iso}T23:59:59` : iso);
  return Number.isFinite(t) ? Math.floor((t - now.getTime()) / 86_400_000) : null;
}

function syncedConnection(
  id: 'jira' | 'gitlab',
  label: string,
  configured: boolean,
  tokenExpiresAt: string | undefined,
  input: ConnectionInputs,
): Connection {
  if (input.isDemo) return { id, label, state: 'demo', detail: 'Demo profile: fixture data' };
  if (!configured) return { id, label, state: 'off', detail: 'Not configured (see Settings)' };
  const days = daysUntil(tokenExpiresAt, input.now ?? new Date());
  if (days !== null && days < 0)
    return { id, label, state: 'error', detail: 'Token expired: renew it in Settings' };
  const sync = input.syncStates.find((s) => s.source === id);
  if (sync?.lastError) return { id, label, state: 'error', detail: sync.lastError };
  if (days !== null && days <= TOKEN_EXPIRY_WARNING_DAYS)
    return {
      id,
      label,
      state: 'warning',
      detail: `Token expires ${days === 0 ? 'today' : `in ${days} day${days === 1 ? '' : 's'}`}: renew it in Settings`,
    };
  if (sync?.lastSyncedAt) return { id, label, state: 'ok', detail: 'Connected' };
  return { id, label, state: 'warning', detail: 'Not synced yet' };
}

function claudeConnection(status: ToolStatus | undefined): Connection {
  const base = { id: 'claude' as const, label: 'Claude' };
  if (!status) return { ...base, state: 'off', detail: 'Not checked yet' };
  if (!status.installed) return { ...base, state: 'error', detail: 'Claude Code CLI not found' };
  const version = status.version ? `v${status.version}` : 'unknown version';
  if (status.meetsMinimum === false) {
    return {
      ...base,
      state: 'warning',
      detail: `${version} is older than the minimum ${status.minimumVersion ?? ''}`.trim(),
    };
  }
  if (status.loggedIn === false)
    return { ...base, state: 'error', detail: `${version}, not logged in` };
  if (status.loggedIn === null) {
    return { ...base, state: 'warning', detail: `${version}, login status unknown` };
  }
  return { ...base, state: 'ok', detail: `${version}, logged in` };
}

/** Status of each external service, for the header indicators. */
export function deriveConnections(input: ConnectionInputs): Connection[] {
  const { jira, gitlab } = input.settings;
  const jiraConfigured =
    jira.baseUrl !== '' &&
    input.secretNames.includes('jira-token') &&
    (jira.deployment !== 'cloud' || jira.email !== '');
  const gitlabConfigured = gitlab.baseUrl !== '' && input.secretNames.includes('gitlab-token');
  return [
    syncedConnection('jira', 'Jira', jiraConfigured, jira.tokenExpiresAt, input),
    syncedConnection(
      'gitlab',
      'GitLab',
      gitlabConfigured,
      input.syncStates.find((s) => s.source === 'gitlab')?.tokenExpiresAt ?? undefined,
      input,
    ),
    claudeConnection(input.claude),
    {
      id: 'slack',
      label: 'Slack',
      state: 'off',
      // tab-enter drafts Slack messages for you to copy; it never posts to Slack itself.
      detail: 'Not connected: messages are copied, not posted',
    },
  ];
}
