import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseMessage, parseStreamLine, summarizeEvents } from './stream';

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../../../fixtures/claude/${name}`, import.meta.url)), 'utf8');

describe('stream-json parser', () => {
  const events = fixture('work-ticket.stream.jsonl').split('\n').flatMap(parseStreamLine);

  it('parses every line of a recorded task run', () => {
    expect(events.filter((e) => e.type === 'error')).toEqual([]);
    expect(events[0]).toEqual({
      type: 'init',
      sessionId: '5f0c1d2e-0000-4000-8000-000000000001',
      model: 'claude-sonnet-5-5',
      tools: ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash'],
    });
    expect(events.filter((e) => e.type === 'tool_use')).toHaveLength(4);
    expect(events.filter((e) => e.type === 'tool_result')).toHaveLength(4);
  });

  it('flattens array tool results to text', () => {
    const results = events.filter((e) => e.type === 'tool_result');
    expect(results.at(-1)).toMatchObject({ content: '12 tests passed', isError: false });
  });

  it('summarizes session, files changed, usage and cost', () => {
    const s = summarizeEvents(events);
    expect(s.sessionId).toBe('5f0c1d2e-0000-4000-8000-000000000001');
    expect(s.model).toBe('claude-sonnet-5-5');
    expect(s.toolCalls).toBe(4);
    expect(s.filesChanged).toEqual([
      '/work/acme-shop/src/login/validate.ts',
      '/work/acme-shop/src/login/validate.test.ts',
    ]);
    expect(s.result).toMatchObject({
      isError: false,
      subtype: 'success',
      numTurns: 6,
      usage: {
        inputTokens: 5400,
        outputTokens: 620,
        cacheReadTokens: 18000,
        cacheCreationTokens: 2100,
        costUsd: 0.0842,
      },
    });
  });

  it('parses a single --output-format json result', () => {
    const [ev] = parseMessage(JSON.parse(fixture('code-review.result.json')));
    expect(ev).toMatchObject({ type: 'result', numTurns: 4, models: ['claude-sonnet-5-5'] });
    if (ev?.type !== 'result') throw new Error('expected result');
    expect(JSON.parse(ev.resultText ?? '')).toMatchObject({ verdict: 'approve_with_comments' });
  });

  it('reports unparseable lines and ignores blank and unknown ones', () => {
    expect(parseStreamLine('')).toEqual([]);
    expect(parseStreamLine('{"type":"stream_event","event":{}}')).toEqual([]);
    expect(parseStreamLine('not json')[0]).toMatchObject({ type: 'error' });
  });

  it('tolerates missing fields in an error result', () => {
    const [ev] = parseStreamLine('{"type":"result","subtype":"error_max_turns","is_error":true}');
    expect(ev).toMatchObject({
      type: 'result',
      isError: true,
      subtype: 'error_max_turns',
      usage: { inputTokens: 0, costUsd: null },
    });
  });
});
