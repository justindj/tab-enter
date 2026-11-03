import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FetchLike } from './http';

// Contract-test helpers: a fake fetch that serves recorded (invented) API
// responses from fixtures/contract and records every request it saw.

export function loadContractFixture<T>(name: string): T {
  const file = fileURLToPath(new URL(`../../../fixtures/contract/${name}`, import.meta.url));
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

export interface SeenRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
}

export interface FakeReply {
  status?: number;
  body: unknown;
  headers?: Record<string, string>;
  /** Serve `body` (a string) as text/plain instead of JSON, e.g. a CI job log. */
  text?: boolean;
}

export function jsonResponse({ status = 200, body, headers = {}, text }: FakeReply): Response {
  if (text) {
    return new Response(String(body), {
      status,
      headers: { 'Content-Type': 'text/plain', ...headers },
    });
  }
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/** Routes requests to `handler`; anything it returns undefined for is a 404. */
export function fakeFetch(handler: (req: SeenRequest) => FakeReply | undefined) {
  const seen: SeenRequest[] = [];
  const fetch: FetchLike = async (url, init) => {
    const req: SeenRequest = {
      method: init.method ?? 'GET',
      url: new URL(url),
      headers: init.headers as Record<string, string>,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    seen.push(req);
    const reply = handler(req);
    return jsonResponse(reply ?? { status: 404, body: { message: '404 Not found' } });
  };
  return { fetch, seen };
}
