import { NextResponse, type NextRequest } from 'next/server';

// Every request must carry the per-session token minted by `pnpm dev`, so other
// local processes and web pages can't call the app (CSRF, DNS rebinding).
// The launcher opens /?token=..., which is swapped for an HttpOnly cookie.

const COOKIE = 'tab_enter_session';
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function deny(status: number, message: string) {
  return new NextResponse(message, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

export function proxy(request: NextRequest) {
  const expected = process.env.TAB_ENTER_SESSION_TOKEN;
  if (!expected) return deny(503, 'tab-enter has no session token. Start it with `pnpm dev`.');

  // A rebinding attack arrives with the attacker's hostname in Host.
  const host = (request.headers.get('host') ?? '').replace(/:\d+$/, '');
  if (!ALLOWED_HOSTS.has(host)) return deny(403, 'tab-enter only answers on 127.0.0.1.');

  const queryToken = request.nextUrl.searchParams.get('token');
  if (queryToken !== null) {
    if (!safeEqual(queryToken, expected)) return deny(401, 'Invalid session token.');
    const url = request.nextUrl.clone();
    url.searchParams.delete('token');
    const response = NextResponse.redirect(url);
    response.cookies.set(COOKIE, expected, { httpOnly: true, sameSite: 'strict', path: '/' });
    return response;
  }

  const cookie = request.cookies.get(COOKIE)?.value;
  if (!cookie || !safeEqual(cookie, expected)) {
    return deny(
      401,
      'Not signed in to this tab-enter session. Open the link printed by `pnpm dev`.',
    );
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
