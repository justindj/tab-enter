import type { AgentEvent, AgentUsage } from '@tab-enter/core';

// Parser for `claude -p --output-format stream-json --verbose` (one JSON object
// per line) and for the single object `--output-format json` prints. The input
// is untrusted, so every field is read defensively.

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (isObj(part) && part.type === 'text' ? (str(part.text) ?? '') : ''))
      .join('');
  }
  return '';
}

function usageFrom(msg: Obj): AgentUsage {
  const u = isObj(msg.usage) ? msg.usage : {};
  return {
    inputTokens: num(u.input_tokens) ?? 0,
    outputTokens: num(u.output_tokens) ?? 0,
    cacheReadTokens: num(u.cache_read_input_tokens) ?? 0,
    cacheCreationTokens: num(u.cache_creation_input_tokens) ?? 0,
    costUsd: num(msg.total_cost_usd),
  };
}

export function parseMessage(msg: unknown): AgentEvent[] {
  if (!isObj(msg)) return [];
  switch (msg.type) {
    case 'system': {
      if (msg.subtype !== 'init') return [];
      const tools = Array.isArray(msg.tools) ? msg.tools.filter((t) => typeof t === 'string') : [];
      return [{ type: 'init', sessionId: str(msg.session_id) ?? '', model: str(msg.model), tools }];
    }
    case 'assistant':
    case 'user': {
      const content = isObj(msg.message) ? msg.message.content : undefined;
      if (!Array.isArray(content)) return [];
      const events: AgentEvent[] = [];
      for (const block of content) {
        if (!isObj(block)) continue;
        if (block.type === 'text' && msg.type === 'assistant') {
          const text = str(block.text);
          if (text) events.push({ type: 'text', text });
        } else if (block.type === 'tool_use') {
          events.push({
            type: 'tool_use',
            id: str(block.id) ?? '',
            name: str(block.name) ?? 'unknown',
            input: block.input ?? null,
          });
        } else if (block.type === 'tool_result') {
          events.push({
            type: 'tool_result',
            toolUseId: str(block.tool_use_id) ?? '',
            isError: block.is_error === true,
            content: toolResultText(block.content),
          });
        }
      }
      return events;
    }
    case 'result':
      return [
        {
          type: 'result',
          sessionId: str(msg.session_id) ?? '',
          isError: msg.is_error === true,
          subtype: str(msg.subtype) ?? 'unknown',
          resultText: str(msg.result),
          numTurns: num(msg.num_turns),
          durationMs: num(msg.duration_ms),
          models: isObj(msg.modelUsage) ? Object.keys(msg.modelUsage) : [],
          usage: usageFrom(msg),
        },
      ];
    default:
      return [];
  }
}

/** Parse one stream-json line. Blank lines yield nothing; garbage yields an error event. */
export function parseStreamLine(line: string): AgentEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let msg: unknown;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return [{ type: 'error', message: `Unparseable output line: ${trimmed.slice(0, 200)}` }];
  }
  return parseMessage(msg);
}

const FILE_EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

export interface RunSummary {
  sessionId: string | null;
  model: string | null;
  text: string[];
  toolCalls: number;
  filesChanged: string[];
  errors: string[];
  result: Extract<AgentEvent, { type: 'result' }> | null;
}

/** Fold a run's events into what the run record and UI need. */
export function summarizeEvents(events: Iterable<AgentEvent>): RunSummary {
  const summary: RunSummary = {
    sessionId: null,
    model: null,
    text: [],
    toolCalls: 0,
    filesChanged: [],
    errors: [],
    result: null,
  };
  const files = new Set<string>();
  for (const ev of events) {
    switch (ev.type) {
      case 'init':
        summary.sessionId = ev.sessionId || summary.sessionId;
        summary.model = ev.model;
        break;
      case 'text':
        summary.text.push(ev.text);
        break;
      case 'tool_use': {
        summary.toolCalls++;
        const input = isObj(ev.input) ? ev.input : {};
        const file = str(input.file_path) ?? str(input.notebook_path);
        if (FILE_EDIT_TOOLS.has(ev.name) && file) files.add(file);
        break;
      }
      case 'result':
        summary.result = ev;
        summary.sessionId = ev.sessionId || summary.sessionId;
        if (ev.models.length > 0) summary.model = ev.models[0] ?? summary.model;
        break;
      case 'error':
        summary.errors.push(ev.message);
        break;
    }
  }
  summary.filesChanged = [...files];
  return summary;
}
