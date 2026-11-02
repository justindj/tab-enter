import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PRESETS, type AgentEvent } from '@tab-enter/core';
import { describe, expect, it } from 'vitest';
import { ClaudeCodeRunner } from './runner';
import { summarizeEvents } from './stream';

const fakeClaude = fileURLToPath(new URL('./test-support/fake-claude.mjs', import.meta.url));
const fixture = (name: string) =>
  fileURLToPath(new URL(`../../../fixtures/claude/${name}`, import.meta.url));

async function collect(iter: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

function runner(env: Record<string, string>) {
  return new ClaudeCodeRunner({
    command: { file: process.execPath, argsPrefix: [fakeClaude] },
    env: { ...process.env, ...env },
  });
}

describe('ClaudeCodeRunner (against a fake CLI)', () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'tab-enter-run-'));

  it('streams a task run and passes the prompt on stdin', async () => {
    const argsOut = path.join(cwd, 'args.json');
    const events = await collect(
      runner({
        FAKE_CLAUDE_FIXTURE: fixture('work-ticket.stream.jsonl'),
        FAKE_CLAUDE_ARGS_OUT: argsOut,
      }).run(
        {
          runId: 'r1',
          cwd,
          prompt: 'Fix ABC-1',
          preset: DEFAULT_PRESETS['work-ticket'],
          resumeSessionId: 's0',
        },
        new AbortController().signal,
      ),
    );
    const summary = summarizeEvents(events);
    expect(summary.errors).toEqual([]);
    expect(summary.result?.usage.costUsd).toBe(0.0842);

    const received = JSON.parse(readFileSync(argsOut, 'utf8')) as { args: string[]; stdin: string };
    expect(received.stdin).toBe('Fix ABC-1');
    expect(received.args).toContain('--resume');
    expect(received.args).not.toContain('Fix ABC-1');
  });

  it('parses a JSON analysis run', async () => {
    const events = await collect(
      runner({ FAKE_CLAUDE_FIXTURE: fixture('code-review.result.json') }).run(
        { runId: 'r2', cwd, prompt: 'Review', preset: DEFAULT_PRESETS['code-review'] },
        new AbortController().signal,
      ),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'result', numTurns: 4 });
  });

  it('reports a failed exit with redacted stderr', async () => {
    const events = await collect(
      runner({ FAKE_CLAUDE_EXIT: '1', FAKE_CLAUDE_STDERR: 'boom token=abcdef123456' }).run(
        { runId: 'r3', cwd, prompt: 'x', preset: DEFAULT_PRESETS['work-ticket'] },
        new AbortController().signal,
      ),
    );
    const error = events.find((e) => e.type === 'error');
    expect(error).toMatchObject({ type: 'error' });
    if (error?.type !== 'error') throw new Error('expected error');
    expect(error.message).toContain('exited with code 1');
    expect(error.message).not.toContain('abcdef123456');
  });
});
