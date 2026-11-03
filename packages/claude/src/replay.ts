import { readFile } from 'node:fs/promises';
import {
  extractPolishMessage,
  type AgentEvent,
  type AgentRunner,
  type AgentRunRequest,
  type ToolStatus,
} from '@tab-enter/core';
import { parseMessage, parseStreamLine } from './stream';

// Demo mode: replays recorded Claude Code output so runs can be explored and
// screenshotted without spending tokens. Lines are paced so the live log
// visibly streams. Never used for non-demo profiles.

export interface ReplayRunnerOptions {
  /** stream-json fixture for task presets. */
  taskFixture: string;
  /** json fixture for analysis presets. */
  analysisFixture: string;
  delayMs?: number;
}

export class ReplayRunner implements AgentRunner {
  readonly id = 'claude-code-replay';

  constructor(private readonly options: ReplayRunnerOptions) {}

  async detect(): Promise<ToolStatus> {
    return {
      tool: 'claude',
      installed: true,
      path: null,
      version: 'replay',
      minimumVersion: null,
      meetsMinimum: true,
      loggedIn: true,
      detail: 'Demo replay of recorded output',
      checkedAt: new Date().toISOString(),
    };
  }

  async *run(request: AgentRunRequest, signal: AbortSignal): AsyncIterable<AgentEvent> {
    const delay = this.options.delayMs ?? 500;
    const wait = () =>
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, delay);
        signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
      });

    if (request.preset.mode === 'analysis') {
      await wait();
      if (signal.aborted) return yield { type: 'error', message: 'Run cancelled.' };
      // A tool-less one-turn preset is "short text" (report polish): there's no
      // recording of rewriting *this* text, so echo it back unchanged and say so.
      const echo =
        request.preset.allowedTools.length === 0 ? extractPolishMessage(request.prompt) : null;
      if (echo !== null) {
        yield {
          type: 'text',
          text: 'Demo replay: polishing is simulated, so the text comes back unchanged.',
        };
        yield {
          type: 'result',
          sessionId: request.resumeSessionId ?? 'demo-short-text',
          isError: false,
          subtype: 'success',
          resultText: echo,
          numTurns: 1,
          durationMs: delay,
          models: ['claude-haiku-5-5'],
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            costUsd: 0,
          },
        };
        return;
      }
      yield* parseMessage(JSON.parse(await readFile(this.options.analysisFixture, 'utf8')));
      return;
    }
    const lines = (await readFile(this.options.taskFixture, 'utf8')).split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      await wait();
      if (signal.aborted) return yield { type: 'error', message: 'Run cancelled.' };
      for (const ev of parseStreamLine(line)) {
        // A resumed demo run keeps the session it continues.
        if ((ev.type === 'init' || ev.type === 'result') && request.resumeSessionId) {
          yield { ...ev, sessionId: request.resumeSessionId };
        } else {
          yield ev;
        }
      }
    }
  }
}
