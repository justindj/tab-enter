import { ConnectorError } from './types';

// Minimal JSON-over-HTTP client shared by the live connectors. Retries rate
// limits and transient 5xx with backoff, and turns failures into
// ConnectorErrors the UI can explain. Tokens only ever go into headers here.

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface HttpClientOptions {
  /** e.g. "https://jira.example.com" or "https://gitlab.example.com/api/v4". No trailing slash. */
  baseUrl: string;
  /** Called per request so a renewed token is picked up without restarting. */
  getHeaders: () => Promise<Record<string, string>>;
  /** Service name used in error messages ("Jira", "GitLab"). */
  service: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  maxRetries?: number;
  /** Injected in tests so retries don't actually wait. */
  sleep?: (ms: number) => Promise<void>;
}

export interface HttpResponse<T> {
  data: T;
  headers: Headers;
}

const RETRY_STATUS = new Set([429, 502, 503, 504]);
const MAX_RETRY_WAIT_MS = 60_000;

/** Seconds or an HTTP date, per RFC 9110. */
export function retryAfterMs(header: string | null, attempt: number): number {
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.min(seconds * 1000, MAX_RETRY_WAIT_MS);
    const date = Date.parse(header);
    if (!Number.isNaN(date)) return Math.min(Math.max(date - Date.now(), 0), MAX_RETRY_WAIT_MS);
  }
  return Math.min(1000 * 2 ** attempt, MAX_RETRY_WAIT_MS);
}

function networkMessage(service: string, baseUrl: string, err: unknown): string {
  const code = (err as { cause?: { code?: string } })?.cause?.code;
  const host = (() => {
    try {
      return new URL(baseUrl).host;
    } catch {
      return baseUrl;
    }
  })();
  if (err instanceof Error && err.name === 'TimeoutError') {
    return `${service} at ${host} did not respond in time. Check your network or VPN.`;
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return `Can't resolve ${host}. Check the ${service} URL, or connect to the VPN if it's internal.`;
  }
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ETIMEDOUT') {
    return `Can't reach ${service} at ${host} (${code}). Check your network or VPN.`;
  }
  return `Can't reach ${service} at ${host}: ${err instanceof Error ? err.message : String(err)}`;
}

export class HttpClient {
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: HttpClientOptions) {
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  get baseUrl(): string {
    return this.opts.baseUrl;
  }

  async get<T>(path: string, query?: Record<string, string | number | undefined>) {
    return this.request<T>('GET', path, { query });
  }

  async post<T>(path: string, body: unknown) {
    return this.request<T>('POST', path, { body });
  }

  async request<T>(
    method: 'GET' | 'POST',
    path: string,
    { query, body }: { query?: Record<string, string | number | undefined>; body?: unknown } = {},
  ): Promise<HttpResponse<T>> {
    const url = new URL(this.opts.baseUrl + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const maxRetries = this.opts.maxRetries ?? 3;
    const { service } = this.opts;

    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = {
        Accept: 'application/json',
        ...(await this.opts.getHeaders()),
      };
      if (body !== undefined) headers['Content-Type'] = 'application/json';

      let res: Response;
      try {
        res = await this.fetchImpl(url.toString(), {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
          redirect: 'follow',
        });
      } catch (err) {
        if (attempt < maxRetries) {
          await this.sleep(retryAfterMs(null, attempt));
          continue;
        }
        throw new ConnectorError('network', networkMessage(service, this.opts.baseUrl, err));
      }

      if (RETRY_STATUS.has(res.status) && attempt < maxRetries) {
        await this.sleep(retryAfterMs(res.headers.get('Retry-After'), attempt));
        continue;
      }
      if (!res.ok) throw await this.toError(res);

      const type = res.headers.get('Content-Type') ?? '';
      if (!type.includes('json')) {
        // Typically an SSO or VPN login page served with 200.
        throw new ConnectorError(
          'auth',
          `${service} returned a web page instead of API data. The URL may be wrong, or a login/VPN page is in the way.`,
        );
      }
      return { data: (await res.json()) as T, headers: res.headers };
    }
  }

  private async toError(res: Response): Promise<ConnectorError> {
    const { service } = this.opts;
    let detail = '';
    try {
      const text = await res.text();
      const json = JSON.parse(text) as Record<string, unknown>;
      const parts = [json.errorMessages, json.message, json.error].flat().filter(Boolean);
      detail = parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join('; ');
    } catch {
      // body wasn't JSON; the status alone is enough
    }
    const suffix = detail ? ` (${detail.slice(0, 200)})` : '';
    switch (res.status) {
      case 401:
        return new ConnectorError(
          'auth',
          `${service} rejected the token (401). It may have expired or been revoked: renew it in Settings.`,
        );
      case 403:
        return new ConnectorError(
          'auth',
          `${service} denied access (403). Check the token's scopes and your permissions${suffix}.`,
        );
      case 404:
        return new ConnectorError('not_found', `${service}: not found (404)${suffix}.`);
      case 429:
        return new ConnectorError('rate_limit', `${service} rate limit hit. Try again shortly.`);
      default:
        return new ConnectorError('other', `${service} returned ${res.status}${suffix}.`);
    }
  }
}

/** Run `fn` over `items` with at most `limit` in flight, keeping order. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}
