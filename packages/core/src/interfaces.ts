import type { TaskPreset } from './settings';
import type { ToolStatus } from './types';

// Seams kept deliberately abstract so a hosted version can swap the
// implementation without touching callers (see spec section 8).

/** Artifact storage: filesystem in v1, object storage later. */
export interface BlobStore {
  put(key: string, data: Uint8Array | string, contentType?: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
  deletePrefix(prefix: string): Promise<void>;
}

export type ServiceName = 'jira' | 'gitlab';

/** Auth for outbound API calls. PAT now; OAuth (Atlassian 3LO, GitLab) later. */
export interface CredentialProvider {
  getAuthHeaders(profileId: string, service: ServiceName): Promise<Record<string, string>>;
}

export interface AgentRunRequest {
  runId: string;
  cwd: string;
  prompt: string;
  preset: TaskPreset;
  /** Resume an earlier session instead of starting fresh. */
  resumeSessionId?: string;
  /** Run-specific Claude Code settings file (used for RTK per-run mode). */
  settingsPath?: string;
}

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number | null;
}

export type AgentEvent =
  | { type: 'init'; sessionId: string; model: string | null; tools: string[] }
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; isError: boolean; content: string }
  | {
      type: 'result';
      sessionId: string;
      isError: boolean;
      subtype: string;
      resultText: string | null;
      numTurns: number | null;
      durationMs: number | null;
      models: string[];
      usage: AgentUsage;
    }
  | { type: 'error'; message: string };

/** One AI engine. ClaudeCodeRunner is the only v1 implementation. */
export interface AgentRunner {
  readonly id: string;
  detect(): Promise<ToolStatus>;
  run(request: AgentRunRequest, signal: AbortSignal): AsyncIterable<AgentEvent>;
}
