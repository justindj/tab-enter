import { describe, expect, it } from 'vitest';
import { deriveConnections, type ConnectionInputs } from './connections';
import { ProfileSettingsSchema } from './settings';
import type { ToolStatus } from './types';

const claude: ToolStatus = {
  tool: 'claude',
  installed: true,
  path: '/usr/local/bin/claude',
  version: '2.1.3',
  minimumVersion: '2.0.0',
  meetsMinimum: true,
  loggedIn: true,
  detail: null,
  checkedAt: '2026-11-02T09:00:00.000Z',
};

function inputs(overrides: Partial<ConnectionInputs> = {}): ConnectionInputs {
  return {
    isDemo: false,
    settings: ProfileSettingsSchema.parse({
      jira: { baseUrl: 'https://jira.example.com', email: 'dev@example.com' },
      gitlab: { baseUrl: 'https://gitlab.example.com' },
    }),
    secretNames: ['jira-token', 'gitlab-token'],
    syncStates: [],
    claude,
    ...overrides,
  };
}

const byId = (input: ConnectionInputs) =>
  Object.fromEntries(deriveConnections(input).map((c) => [c.id, c]));

describe('deriveConnections', () => {
  it('shows demo profiles as demo, not connected', () => {
    const c = byId(inputs({ isDemo: true }));
    expect(c.jira!.state).toBe('demo');
    expect(c.gitlab!.state).toBe('demo');
  });

  it('is off when the token is missing', () => {
    const c = byId(inputs({ secretNames: [] }));
    expect(c.jira!.state).toBe('off');
    expect(c.gitlab!.state).toBe('off');
  });

  it('needs an email for Jira Cloud but not Data Center', () => {
    const base = inputs();
    const noEmail = { ...base.settings, jira: { ...base.settings.jira, email: '' } };
    expect(byId({ ...base, settings: noEmail }).jira!.state).toBe('off');
    const dc = { ...noEmail, jira: { ...noEmail.jira, deployment: 'datacenter' as const } };
    expect(byId({ ...base, settings: dc }).jira!.state).toBe('warning');
  });

  it('reports sync errors and successes per source', () => {
    const c = byId(
      inputs({
        syncStates: [
          { source: 'jira', lastSyncedAt: new Date(), lastError: null },
          { source: 'gitlab', lastSyncedAt: new Date(), lastError: '401 Unauthorized' },
        ],
      }),
    );
    expect(c.jira!.state).toBe('ok');
    expect(c.gitlab).toMatchObject({ state: 'error', detail: '401 Unauthorized' });
  });

  it('derives Claude state from tool detection', () => {
    expect(byId(inputs({ claude: undefined })).claude!.state).toBe('off');
    expect(byId(inputs({ claude: { ...claude, installed: false } })).claude!.state).toBe('error');
    expect(byId(inputs({ claude: { ...claude, loggedIn: false } })).claude!.state).toBe('error');
    expect(byId(inputs({ claude: { ...claude, loggedIn: null } })).claude!.state).toBe('warning');
    expect(byId(inputs({ claude: { ...claude, meetsMinimum: false } })).claude!.state).toBe(
      'warning',
    );
    expect(byId(inputs()).claude).toMatchObject({ state: 'ok', detail: 'v2.1.3, logged in' });
  });

  it('warns before a known token expiry and errors once it has passed', () => {
    const now = new Date('2026-11-03T12:00:00Z');
    const synced = { lastSyncedAt: now, lastError: null };
    const base = inputs({
      now,
      syncStates: [
        { source: 'jira', ...synced },
        { source: 'gitlab', ...synced, tokenExpiresAt: '2026-11-10' },
      ],
    });
    const jiraExpiring = {
      ...base.settings,
      jira: { ...base.settings.jira, tokenExpiresAt: '2026-11-01' },
    };
    const c = byId({ ...base, settings: jiraExpiring });
    expect(c.gitlab).toMatchObject({
      state: 'warning',
      detail: expect.stringContaining('in 7 days'),
    });
    expect(c.jira).toMatchObject({ state: 'error', detail: expect.stringContaining('expired') });
    // Far-off expiry stays green.
    const later = byId(
      inputs({ now, syncStates: [{ source: 'gitlab', ...synced, tokenExpiresAt: '2027-06-01' }] }),
    );
    expect(later.gitlab!.state).toBe('ok');
  });

  it('always shows Slack as not connected', () => {
    expect(byId(inputs()).slack!.state).toBe('off');
  });
});
