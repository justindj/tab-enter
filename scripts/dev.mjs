// Starts tab-enter locally: runs migrations, then the web app (bound to
// 127.0.0.1) and the worker, sharing a fresh per-session auth token. Opens
// the browser on a one-time URL that swaps the token for an HttpOnly cookie.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const port = process.env.TAB_ENTER_PORT ?? '3737';
const token = randomBytes(32).toString('hex');
// tab-enter has no telemetry, so Next.js's is switched off too.
const env = {
  ...process.env,
  TAB_ENTER_SESSION_TOKEN: token,
  TAB_ENTER_PORT: port,
  NEXT_TELEMETRY_DISABLED: '1',
};
const isWindows = process.platform === 'win32';
const children = [];

function run(args, { name, wait = false } = {}) {
  // pnpm is a .cmd shim on Windows, which needs a shell. Arguments are fixed strings.
  const stdio = wait ? 'inherit' : ['ignore', 'pipe', 'pipe'];
  const child = isWindows
    ? spawn(`pnpm ${args.join(' ')}`, { env, stdio, shell: true })
    : spawn('pnpm', args, { env, stdio });
  if (!wait) {
    children.push(child);
    const prefix = (line) => `[${name}] ${line}`;
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        // Never echo the session token if a tool happens to log the URL.
        const text = chunk.replaceAll(token, '<token>');
        for (const line of text.split(/\r?\n/))
          if (line.trim()) process.stdout.write(prefix(line) + '\n');
      });
    }
    child.on('exit', (code) => {
      console.log(`[${name}] exited with code ${code}`);
      shutdown(code ?? 1);
    });
  }
  return new Promise((resolve, reject) => {
    if (!wait) return resolve(child);
    child.on('exit', (code) =>
      code === 0 ? resolve(child) : reject(new Error(`${args.join(' ')} failed`)),
    );
  });
}

let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode !== null) continue;
    if (isWindows) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 500);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

function openBrowser(url) {
  const [cmd, args] = isWindows
    ? ['cmd', ['/c', 'start', '""', url]]
    : process.platform === 'darwin'
      ? ['open', [url]]
      : ['xdg-open', [url]];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
}

async function waitForServer(base) {
  for (let i = 0; i < 120; i++) {
    try {
      await fetch(base, { redirect: 'manual' }); // any response (even 401) means it's up
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return false;
}

await run(['--filter', '@tab-enter/db', 'migrate'], { wait: true });
await run(['--filter', '@tab-enter/worker', 'dev'], { name: 'worker' });
await run(['--filter', '@tab-enter/web', 'exec', 'next', 'dev', '-H', '127.0.0.1', '-p', port], {
  name: 'web',
});

const base = `http://127.0.0.1:${port}`;
if (await waitForServer(base)) {
  const url = `${base}/?token=${token}`;
  console.log(
    `\n  tab-enter is running: ${url}\n  (this link is your session; it changes every time you start)\n`,
  );
  if (!process.env.TAB_ENTER_NO_OPEN) openBrowser(url);
}
