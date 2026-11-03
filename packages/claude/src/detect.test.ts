import { describe, expect, it } from 'vitest';
import {
  compareVersions,
  detectClaude,
  detectRtk,
  parseAuthStatus,
  parseRtkGain,
  parseVersion,
} from './detect';
import type { CommandResult, RunCommand } from './exec';

const ok = (stdout: string, code = 0): CommandResult => ({
  code,
  stdout,
  stderr: '',
  timedOut: false,
});
const now = () => new Date('2026-01-15T12:00:00Z');

function fakeRun(responses: Record<string, CommandResult>): RunCommand & { calls: string[] } {
  const calls: string[] = [];
  const run = async (_file: string, args: string[]) => {
    const key = args.join(' ');
    calls.push(key);
    return responses[key] ?? ok('', 1);
  };
  return Object.assign(run, { calls });
}

describe('version helpers', () => {
  it('parses and compares versions', () => {
    expect(parseVersion('2.1.4 (Claude Code)')).toBe('2.1.4');
    expect(parseVersion('nope')).toBeNull();
    expect(compareVersions('2.1.0', '2.0.9')).toBe(1);
    expect(compareVersions('2.0.0', '2.0.0')).toBe(0);
    expect(compareVersions('1.9.9', '2.0.0')).toBe(-1);
  });
});

describe('parseAuthStatus', () => {
  it('reads JSON and text forms', () => {
    expect(parseAuthStatus(ok('{"loggedIn":true}'))).toBe(true);
    expect(parseAuthStatus(ok('{"loggedIn":false}'))).toBe(false);
    expect(parseAuthStatus(ok('Logged in as someone'))).toBe(true);
    expect(parseAuthStatus(ok('Not logged in. Run claude auth login', 1))).toBe(false);
    expect(parseAuthStatus(ok('something else', 2))).toBeNull();
    expect(parseAuthStatus({ ...ok(''), timedOut: true })).toBeNull();
  });
});

describe('detectClaude', () => {
  it('reports not installed', async () => {
    const status = await detectClaude({ find: async () => null, now });
    expect(status).toMatchObject({ tool: 'claude', installed: false, version: null });
  });

  it('detects version and login on a recent CLI', async () => {
    const run = fakeRun({
      '--version': ok('2.3.1 (Claude Code)'),
      'auth status': ok('{"loggedIn":true}'),
    });
    const status = await detectClaude({ find: async () => '/bin/claude', run, now });
    expect(status).toMatchObject({
      installed: true,
      version: '2.3.1',
      meetsMinimum: true,
      loggedIn: true,
    });
  });

  it('never calls `auth status` on CLIs older than it, falling back to the credentials file', async () => {
    const run = fakeRun({ '--version': ok('2.0.5 (Claude Code)') });
    const status = await detectClaude({
      find: async () => '/bin/claude',
      run,
      now,
      hasCredentialsFile: async () => true,
    });
    expect(run.calls).toEqual(['--version']);
    expect(status.loggedIn).toBe(true);
  });

  it('flags versions below the minimum', async () => {
    const run = fakeRun({ '--version': ok('1.0.80 (Claude Code)') });
    const status = await detectClaude({
      find: async () => '/bin/claude',
      run,
      now,
      hasCredentialsFile: async () => false,
    });
    expect(status.meetsMinimum).toBe(false);
    expect(status.loggedIn).toBeNull();
  });
});

describe('detectRtk', () => {
  it('detects rtk', async () => {
    const run = fakeRun({ '--version': ok('rtk 0.9.2') });
    expect(await detectRtk({ find: async () => '/bin/rtk', run, now })).toMatchObject({
      installed: true,
      version: '0.9.2',
      detail: null,
    });
  });

  it('warns about a different tool named rtk, and never asks it for savings', async () => {
    const run = fakeRun({ '--version': ok('1.2.3') });
    const status = await detectRtk({ find: async () => '/bin/rtk', run, now });
    expect(status.detail).toMatch(/may not be/);
    expect(status.savings).toBeNull();
    expect(run.calls).toEqual(['--version']);
  });

  it('reads savings from `rtk gain --all --format json`', async () => {
    const run = fakeRun({
      '--version': ok('rtk 0.9.2'),
      'gain --all --format json': ok(
        JSON.stringify({
          summary: {
            total_commands: 300,
            total_input: 1500000,
            total_output: 300000,
            total_saved: 1200000,
            avg_savings_pct: 80.0,
          },
          daily: [],
        }),
      ),
    });
    const status = await detectRtk({ find: async () => '/bin/rtk', run, now });
    expect(status.savings).toEqual({
      commands: 300,
      inputTokens: 1500000,
      savedTokens: 1200000,
      avgPct: 80,
    });
    // An older rtk without JSON output just shows no savings.
    expect(parseRtkGain(ok('Total saved: 1.2M', 0))).toBeNull();
    expect(parseRtkGain(ok('', 2))).toBeNull();
  });
});
