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
  syncStates: { source: 'jira' | 'gitlab'; lastSyncedAt: Date | null; lastError: string | null }[];
  claude: ToolStatus | undefined;
}

function syncedConnection(
  id: 'jira' | 'gitlab',
  label: string,
  configured: boolean,
  input: ConnectionInputs,
): Connection {
  if (input.isDemo) return { id, label, state: 'demo', detail: 'Demo profile: fixture data' };
  if (!configured) return { id, label, state: 'off', detail: 'Not configured (see Settings)' };
  const sync = input.syncStates.find((s) => s.source === id);
  if (sync?.lastError) return { id, label, state: 'error', detail: sync.lastError };
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
    syncedConnection('jira', 'Jira', jiraConfigured, input),
    syncedConnection('gitlab', 'GitLab', gitlabConfigured, input),
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
