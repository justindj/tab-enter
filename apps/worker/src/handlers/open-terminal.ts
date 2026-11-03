import { spawn } from 'node:child_process';
import { findOnPath } from '@tab-enter/claude';
import { getProfile, getRun, type Db } from '@tab-enter/db';
import {
  resolveWorkspace,
  WorkspaceError,
  type WorkTarget,
  type WorkspaceDeps,
} from '../workspace';

// "Open in terminal": start Claude Code interactively in the user's own
// terminal, in the run's worktree, resuming its session so the user can take
// over. The terminal is the user's; tab-enter just launches it.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Characters a shell or AppleScript string could interpret. Our worktree paths never have them.
const UNSAFE_PATH = /["'`$%!^&|<>;\r\n]/;

export interface TerminalLaunch {
  file: string;
  args: string[];
}

/** The command to run in a terminal, also shown to the user to copy. */
export function claudeCommand(sessionId: string | null): string[] {
  return sessionId ? ['claude', '--resume', sessionId] : ['claude'];
}

/** How to open a terminal in `cwd` running `command`, per platform. */
export async function terminalLaunch(
  cwd: string,
  command: string[],
  platform = process.platform,
  find: (name: string) => Promise<string | null> = findOnPath,
): Promise<TerminalLaunch> {
  if (UNSAFE_PATH.test(cwd))
    throw new WorkspaceError(`Unusual characters in the folder path: ${cwd}`);
  const line = command.join(' ');
  if (platform === 'win32') {
    const wt = await find('wt');
    if (wt) return { file: wt, args: ['-d', cwd, ...command] };
    // `start` opens a new console window; the empty string is its title.
    return { file: 'cmd.exe', args: ['/c', 'start', '""', '/D', cwd, 'cmd', '/k', line] };
  }
  if (platform === 'darwin') {
    const script = `tell application "Terminal" to do script "cd '${cwd}' && ${line}"`;
    return {
      file: 'osascript',
      args: ['-e', script, '-e', 'tell application "Terminal" to activate'],
    };
  }
  for (const [name, args] of [
    ['x-terminal-emulator', ['--working-directory', cwd, '-e', line]],
    ['gnome-terminal', ['--working-directory', cwd, '--', ...command]],
    ['konsole', ['--workdir', cwd, '-e', ...command]],
    ['xterm', ['-e', `cd '${cwd}' && ${line}; exec $SHELL`]],
  ] as const) {
    const file = await find(name);
    if (file) return { file, args: [...args] };
  }
  throw new WorkspaceError(`No terminal found. Run this in ${cwd}: ${line}`);
}

export interface OpenTerminalDeps extends WorkspaceDeps {
  launch?: (l: TerminalLaunch, cwd: string) => void;
}

export async function openTerminal(
  db: Db,
  job: { profileId: string; runId?: string; target?: WorkTarget },
  deps: OpenTerminalDeps = {},
): Promise<void> {
  const profile = await getProfile(db, job.profileId);
  if (!profile) throw new WorkspaceError('The profile was deleted.');
  if (profile.isDemo) {
    throw new WorkspaceError('The demo profile has no real repository to open a terminal in.');
  }
  if (!(await findOnPath('claude'))) {
    throw new WorkspaceError(
      'Claude Code (`claude`) is not on PATH. Install it first (see Settings).',
    );
  }

  let cwd: string;
  let sessionId: string | null = null;
  if (job.runId) {
    const run = await getRun(db, job.runId);
    if (!run?.cwd) throw new WorkspaceError('That run has no working folder yet.');
    cwd = run.cwd;
    sessionId = run.sessionId && UUID.test(run.sessionId) ? run.sessionId : null;
  } else if (job.target) {
    cwd = (await resolveWorkspace(db, profile, job.target, deps)).cwd;
  } else {
    throw new WorkspaceError('Nothing to open.');
  }

  const launch = await terminalLaunch(cwd, claudeCommand(sessionId));
  (deps.launch ?? defaultLaunch)(launch, cwd);
}

function defaultLaunch({ file, args }: TerminalLaunch, cwd: string) {
  const child = spawn(file, args, { cwd, detached: true, stdio: 'ignore', windowsHide: false });
  child.on('error', () => {
    // Launch failures surface as "nothing opened"; the UI also shows the command to copy.
  });
  child.unref();
}
