import { createInterface } from 'node:readline';
import type { AgentEvent, AgentRunner, AgentRunRequest, ToolStatus } from '@tab-enter/core';
import { redactSecrets } from '@tab-enter/core';
import { buildClaudeArgs } from './args';
import { detectClaude } from './detect';
import { findOnPath, spawnCommand } from './exec';
import { parseMessage, parseStreamLine } from './stream';

export interface ClaudeCodeRunnerOptions {
  /** Override the executable (tests point this at a fake that replays fixtures). */
  command?: { file: string; argsPrefix?: string[] };
  env?: NodeJS.ProcessEnv;
  vars?: Record<string, string>;
}

/** Runs the user's installed `claude` CLI headless. Only the worker may use this. */
export class ClaudeCodeRunner implements AgentRunner {
  readonly id = 'claude-code';

  constructor(private readonly options: ClaudeCodeRunnerOptions = {}) {}

  detect(): Promise<ToolStatus> {
    return detectClaude();
  }

  async *run(request: AgentRunRequest, signal: AbortSignal): AsyncIterable<AgentEvent> {
    const file = this.options.command?.file ?? (await findOnPath('claude'));
    if (!file) {
      yield { type: 'error', message: 'Claude Code (`claude`) was not found on PATH.' };
      return;
    }
    const args = [
      ...(this.options.command?.argsPrefix ?? []),
      ...buildClaudeArgs({
        preset: request.preset,
        resumeSessionId: request.resumeSessionId,
        settingsPath: request.settingsPath,
        vars: this.options.vars,
      }),
    ];

    const child = spawnCommand(file, args, {
      cwd: request.cwd,
      env: this.options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const onAbort = () => child.kill();
    signal.addEventListener('abort', onAbort, { once: true });

    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-8000);
    });
    const exited = new Promise<number | null>((resolve) => {
      child.on('close', resolve);
      child.on('error', (err) => {
        stderr += String(err);
        resolve(null);
      });
    });
    child.stdin?.on('error', () => {
      // The process may exit before reading stdin; the exit code reports that.
    });
    child.stdin?.end(request.prompt);

    let sawResult = false;
    try {
      if (request.preset.mode === 'task') {
        const lines = createInterface({ input: child.stdout!, crlfDelay: Infinity });
        for await (const line of lines) {
          for (const ev of parseStreamLine(line)) {
            if (ev.type === 'result') sawResult = true;
            yield ev;
          }
        }
      } else {
        let out = '';
        for await (const chunk of child.stdout!) out += String(chunk);
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(out);
        } catch {
          yield {
            type: 'error',
            message: `Claude Code returned non-JSON output: ${out.slice(0, 500)}`,
          };
        }
        for (const ev of parseMessage(parsed)) {
          if (ev.type === 'result') sawResult = true;
          yield ev;
        }
      }
      const code = await exited;
      if (signal.aborted) {
        yield { type: 'error', message: 'Run cancelled.' };
      } else if (code !== 0 && !sawResult) {
        yield {
          type: 'error',
          message: `Claude Code exited with code ${code}: ${redactSecrets(stderr.trim()).slice(-2000)}`,
        };
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
      if (child.exitCode === null) child.kill();
    }
  }
}
