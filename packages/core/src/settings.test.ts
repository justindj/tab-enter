import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PRESETS,
  defaultProfileSettings,
  formatWatchedProjects,
  parseProfileSettings,
  parseWatchedProjects,
} from './settings';

describe('profile settings', () => {
  it('defaults are safe: no AI approval, no writes, RTK off', () => {
    const s = defaultProfileSettings();
    expect(s.claude.approvedForClient).toBe(false);
    expect(s.claude.maxParallelRuns).toBe(2);
    expect(Object.values(s.writeActions).every((v) => v === false)).toBe(true);
    expect(s.rtk).toEqual({ mode: 'off', routing: false, proxy: false, telemetry: false });
    expect(s.timeWindows.recentRetentionDays).toBe(3);
    expect(s.timeWindows.staleReviewHours).toBe(24);
    expect(s.syncIntervalMinutes).toBe(5);
    expect(s.verification.captureVideo).toBe(false);
  });

  it('fills defaults into partially stored settings', () => {
    const s = parseProfileSettings({ jira: { baseUrl: 'https://jira.example.test' } });
    expect(s.jira.baseUrl).toBe('https://jira.example.test');
    expect(s.jira.deployment).toBe('cloud');
    expect(s.jira.sprintOnlyDefault).toBe(true);
    expect(s.claude.presets['code-review'].allowedTools).toEqual(['Read', 'Grep', 'Glob']);
  });

  it('maps the M0 "default" permission mode to dontAsk', () => {
    const stored = {
      claude: {
        presets: {
          ...DEFAULT_PRESETS,
          'code-review': { ...DEFAULT_PRESETS['code-review'], permissionMode: 'default' },
        },
      },
    };
    expect(parseProfileSettings(stored).claude.presets['code-review'].permissionMode).toBe(
      'dontAsk',
    );
    expect(() =>
      parseProfileSettings({
        claude: {
          presets: {
            ...DEFAULT_PRESETS,
            'work-ticket': {
              ...DEFAULT_PRESETS['work-ticket'],
              permissionMode: 'bypassPermissions',
            },
          },
        },
      }),
    ).toThrow();
  });

  it('parses watched projects, one per line with an optional local path', () => {
    const projects = parseWatchedProjects(
      'acme/shop = C:\\code\\shop\n\n# comment\n 1234 \n/acme/web/\n',
    );
    expect(projects.map(({ id, path, localPath }) => ({ id, path, localPath }))).toEqual([
      { id: 'acme/shop', path: 'acme/shop', localPath: 'C:\\code\\shop' },
      { id: '1234', path: '', localPath: undefined },
      { id: 'acme/web', path: 'acme/web', localPath: undefined },
    ]);
    expect(formatWatchedProjects(projects)).toBe('acme/shop = C:\\code\\shop\n1234\nacme/web');
  });

  it('no preset allows pushing', () => {
    for (const preset of Object.values(DEFAULT_PRESETS)) {
      expect(preset.allowedTools.some((t) => /push/i.test(t))).toBe(false);
    }
  });
});
