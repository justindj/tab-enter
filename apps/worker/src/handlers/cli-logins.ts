import os from 'node:os';
import { findOnPath, runCommand, type RunCommand } from '@tab-enter/claude';
import { GitLabCodeHost, type FetchLike } from '@tab-enter/connectors';
import { redactSecrets } from '@tab-enter/core';
import { addSecretName, getProfile, type Db } from '@tab-enter/db';
import { SECRET_NAMES, type SecretStore } from '@tab-enter/secrets';
import { WorkspaceError } from '../workspace';
import { terminalLaunch, type OpenTerminalDeps } from './open-terminal';

// Shortcuts for signing in with tools the user already has. `claude auth
// login` needs a person at the browser, so tab-enter only opens a terminal
// for it. glab already holds a GitLab token, so tab-enter can copy it into
// the keychain once it has checked it works. Jira has neither: its API tokens
// can only be made by hand.

export async function claudeLogin(deps: OpenTerminalDeps = {}): Promise<void> {
  const claude = await findOnPath('claude');
  if (!claude) {
    throw new WorkspaceError('Claude Code (`claude`) is not on PATH. Install it first.');
  }
  const launch = await terminalLaunch(os.homedir(), ['claude', 'auth', 'login']);
  if (deps.launch) deps.launch(launch, os.homedir());
  else {
    const { spawn } = await import('node:child_process');
    spawn(launch.file, launch.args, { cwd: os.homedir(), detached: true, stdio: 'ignore' })
      .on('error', () => {})
      .unref();
  }
}

/** The token glab uses for `host`, from its config, else from `auth status --show-token`. */
export async function readGlabToken(
  run: RunCommand,
  glab: string,
  host: string,
): Promise<string | null> {
  const fromConfig = await run(glab, ['config', 'get', 'token', '--host', host], {
    timeoutMs: 15_000,
  });
  const direct = fromConfig.stdout.trim();
  if (fromConfig.code === 0 && /^[\w.-]{8,}$/.test(direct)) return direct;
  // Tokens kept in the OS keyring don't show in the config; ask auth status instead.
  const status = await run(glab, ['auth', 'status', '--hostname', host, '--show-token'], {
    timeoutMs: 15_000,
  });
  const match = /Token:\s*([\w.-]{8,})/.exec(`${status.stdout}\n${status.stderr}`);
  return match && !/^\*+$/.test(match[1]!) ? match[1]! : null;
}

export interface GlabImportDeps {
  run?: RunCommand;
  findGlab?: () => Promise<string | null>;
  fetch?: FetchLike;
  /** The only secret the worker may write: this profile's GitLab token. */
  secrets?: Pick<SecretStore, 'set'>;
}

export async function importGlabToken(
  db: Db,
  job: { profileId: string },
  deps: GlabImportDeps,
): Promise<{ username: string; host: string }> {
  const profile = await getProfile(db, job.profileId);
  if (!profile) throw new Error('The profile was deleted.');
  if (profile.isDemo) throw new Error('The demo profile has no connections.');
  if (!deps.secrets) throw new Error('No keychain is available to store the token.');
  const baseUrl = profile.settings.gitlab.baseUrl || 'https://gitlab.com';
  const host = new URL(baseUrl).host;
  const glab = await (deps.findGlab ?? (() => findOnPath('glab')))();
  if (!glab) {
    throw new Error('The glab CLI is not installed (or not on PATH). Paste a token instead.');
  }
  const token = await readGlabToken(deps.run ?? runCommand, glab, host);
  if (!token) {
    throw new Error(
      `glab isn't logged in to ${host}. Run \`glab auth login --hostname ${host}\`, or paste a token.`,
    );
  }
  // Check it before storing, so a stale glab login doesn't replace a working token.
  const user = await new GitLabCodeHost({
    baseUrl,
    getHeaders: async () => ({ 'PRIVATE-TOKEN': token }),
    fetch: deps.fetch,
  })
    .getCurrentUser()
    .catch((err: unknown) => {
      const message = redactSecrets(err instanceof Error ? err.message : String(err)).replaceAll(
        token,
        '••••',
      );
      throw new Error(`glab's token didn't work: ${message}`);
    });
  await deps.secrets.set(profile.id, SECRET_NAMES.gitlabToken, token);
  await addSecretName(db, profile.id, SECRET_NAMES.gitlabToken);
  return { username: user.username ?? user.displayName, host };
}
