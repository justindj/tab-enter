import { access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ToolStatus } from '@tab-enter/core';
import { findOnPath, runCommand, type CommandResult, type RunCommand } from './exec';

/** Oldest Claude Code release tab-enter supports. Keep in sync with docs/setup.md. */
export const CLAUDE_MIN_VERSION = '2.0.0';
/** `claude auth status` is only attempted from this version on (see docs/decisions.md). */
export const CLAUDE_AUTH_STATUS_MIN_VERSION = '2.1.0';

export function parseVersion(text: string): string | null {
  return /(\d+\.\d+\.\d+)/.exec(text)?.[1] ?? null;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  return 0;
}

/** Interpret `claude auth status` output. null = couldn't tell. */
export function parseAuthStatus(result: CommandResult): boolean | null {
  if (result.timedOut) return null;
  const text = `${result.stdout}\n${result.stderr}`;
  try {
    const json: unknown = JSON.parse(result.stdout);
    if (json && typeof json === 'object' && 'loggedIn' in json) {
      return Boolean((json as { loggedIn: unknown }).loggedIn);
    }
  } catch {
    // not JSON; fall through to text heuristics
  }
  if (
    /not logged in|logged out|not authenticated|no credentials|please (log|sign) in/i.test(text)
  ) {
    return false;
  }
  if (result.code === 0 && /logged in|authenticated/i.test(text)) return true;
  return null;
}

interface DetectDeps {
  find?: (name: string) => Promise<string | null>;
  run?: RunCommand;
  hasCredentialsFile?: () => Promise<boolean>;
  now?: () => Date;
}

async function defaultHasCredentialsFile(): Promise<boolean> {
  const dir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
  try {
    await access(path.join(dir, '.credentials.json'));
    return true;
  } catch {
    return false;
  }
}

function notInstalled(
  tool: ToolStatus['tool'],
  minimumVersion: string | null,
  now: Date,
): ToolStatus {
  return {
    tool,
    installed: false,
    path: null,
    version: null,
    minimumVersion,
    meetsMinimum: null,
    loggedIn: null,
    detail: null,
    checkedAt: now.toISOString(),
  };
}

export async function detectClaude(deps: DetectDeps = {}): Promise<ToolStatus> {
  const find = deps.find ?? findOnPath;
  const run = deps.run ?? runCommand;
  const now = deps.now?.() ?? new Date();

  const file = await find('claude');
  if (!file) return notInstalled('claude', CLAUDE_MIN_VERSION, now);

  const versionResult = await run(file, ['--version']);
  const version = parseVersion(versionResult.stdout);
  const status: ToolStatus = {
    tool: 'claude',
    installed: true,
    path: file,
    version,
    minimumVersion: CLAUDE_MIN_VERSION,
    meetsMinimum: version ? compareVersions(version, CLAUDE_MIN_VERSION) >= 0 : null,
    loggedIn: null,
    detail: version ? null : `Could not read version: ${versionResult.stderr.trim().slice(0, 200)}`,
    checkedAt: now.toISOString(),
  };

  // Never invoke an unknown subcommand: older CLIs treat unknown words as a prompt.
  if (version && compareVersions(version, CLAUDE_AUTH_STATUS_MIN_VERSION) >= 0) {
    status.loggedIn = parseAuthStatus(await run(file, ['auth', 'status']));
  }
  if (status.loggedIn === null) {
    // Credentials file exists on Linux/Windows; macOS keeps them in the keychain, so absence proves nothing.
    const hasFile = await (deps.hasCredentialsFile ?? defaultHasCredentialsFile)();
    if (hasFile) status.loggedIn = true;
    else if (process.env.ANTHROPIC_API_KEY)
      status.detail = 'Using ANTHROPIC_API_KEY from the environment.';
  }
  return status;
}

export async function detectRtk(deps: DetectDeps = {}): Promise<ToolStatus> {
  const find = deps.find ?? findOnPath;
  const run = deps.run ?? runCommand;
  const now = deps.now?.() ?? new Date();

  const file = await find('rtk');
  if (!file) return notInstalled('rtk', null, now);

  const result = await run(file, ['--version']);
  const version = parseVersion(result.stdout);
  return {
    tool: 'rtk',
    installed: true,
    path: file,
    version,
    minimumVersion: null,
    meetsMinimum: null,
    loggedIn: null,
    // Another tool also ships an `rtk` binary; flag output that doesn't look like RTK.
    detail: /rtk/i.test(result.stdout)
      ? null
      : 'Found an `rtk` binary that may not be Rust Token Killer.',
    checkedAt: now.toISOString(),
  };
}
