import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';

const isWindows = process.platform === 'win32';

/** Resolve an executable on PATH, like `which`. Returns null when it's not installed. */
export async function findOnPath(name: string): Promise<string | null> {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  // .exe before .cmd: the native installer ships claude.exe, npm installs ship claude.cmd.
  const exts = isWindows ? ['.exe', '.cmd', '.bat'] : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        await access(candidate, isWindows ? constants.F_OK : constants.X_OK);
        return candidate;
      } catch {
        // keep looking
      }
    }
  }
  return null;
}

// Windows can only run .cmd/.bat through cmd.exe, which re-parses arguments.
// We only ever pass arguments we built ourselves (prompts go over stdin), so
// refuse anything cmd.exe would treat specially rather than try to escape it.
const CMD_UNSAFE = /["%!^&|<>\r\n]/;

function needsShell(file: string): boolean {
  return isWindows && /\.(cmd|bat)$/i.test(file);
}

export function spawnCommand(
  file: string,
  args: string[],
  options: SpawnOptions = {},
): ChildProcess {
  if (!needsShell(file)) return spawn(file, args, { ...options, shell: false, windowsHide: true });
  for (const arg of args) {
    if (CMD_UNSAFE.test(arg))
      throw new Error(`Refusing to pass unsafe argument through cmd.exe: ${arg}`);
  }
  const quoted = [file, ...args].map((a) => `"${a}"`).join(' ');
  return spawn(quoted, [], { ...options, shell: true, windowsHide: true });
}

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type RunCommand = (
  file: string,
  args: string[],
  opts?: { timeoutMs?: number; env?: NodeJS.ProcessEnv },
) => Promise<CommandResult>;

/** Run a short command to completion. stdin is closed so nothing can wait on input. */
export const runCommand: RunCommand = (file, args, opts = {}) =>
  new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let child: ChildProcess;
    try {
      child = spawnCommand(file, args, { stdio: ['ignore', 'pipe', 'pipe'], env: opts.env });
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: String(err), timedOut: false });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, opts.timeoutMs ?? 10_000);
    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr + String(err), timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
