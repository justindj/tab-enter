// Best-effort removal of secret-looking strings before anything is written to
// run logs or artifacts. This is a safety net; secrets should never reach
// those places in the first place.

const PATTERNS: RegExp[] = [
  /glpat-[A-Za-z0-9_-]{20,}/g, // GitLab personal access token
  /gl(?:dt|ptt|rt|soat|cbt|imt)-[A-Za-z0-9_-]{20,}/g, // other GitLab token types
  /ATATT[A-Za-z0-9_=-]{20,}/g, // Atlassian API token
  /sk-ant-[A-Za-z0-9_-]{20,}/g, // Anthropic API key
  /gh[pousr]_[A-Za-z0-9]{30,}/g, // GitHub tokens
  /AKIA[0-9A-Z]{16}/g, // AWS access key id
  /xox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack tokens
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

// "Authorization: Bearer xyz", "PRIVATE-TOKEN: xyz", "password=xyz", "api_key": "xyz"
const KEYED =
  /((?:authorization|private-token|password|passwd|secret|api[_-]?key|access[_-]?token|token)["']?\s*[:=]\s*["']?(?:bearer\s+|basic\s+)?)([^\s"',;]{6,})/gi;

export const REDACTED = '[REDACTED]';

export function redactSecrets(text: string): string {
  let out = text;
  for (const re of PATTERNS) out = out.replace(re, REDACTED);
  out = out.replace(KEYED, (_m, prefix: string) => `${prefix}${REDACTED}`);
  return out;
}

/**
 * Redact every string inside a JSON-like value (e.g. a run event) and cap each
 * at `maxChars`, so one huge tool result can't bloat the run log.
 */
export function redactDeep<T>(value: T, maxChars = 20_000): T {
  if (typeof value === 'string') {
    const red = redactSecrets(value);
    return (red.length > maxChars ? `${red.slice(0, maxChars)}\n[… truncated]` : red) as T;
  }
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, maxChars)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, redactDeep(v, maxChars)]),
    ) as T;
  }
  return value;
}
