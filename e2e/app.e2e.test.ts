import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Drives the real app in demo mode: everything a first-time user can do with
// no credentials, Claude replayed from fixtures and writes simulated.

const root = fileURLToPath(new URL('..', import.meta.url));

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

async function launch(): Promise<Browser> {
  for (const channel of ['msedge', 'chrome', undefined] as const) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch {
      // try the next one
    }
  }
  throw new Error('No browser for Playwright: install Edge or Chrome.');
}

let app: ChildProcess;
let browser: Browser;
let page: Page;
let base = '';
let signInUrl = '';
let output = '';

beforeAll(async () => {
  const port = await freePort();
  app = spawn(process.execPath, [path.join(root, 'scripts/dev.mjs')], {
    cwd: root,
    env: {
      ...process.env,
      TAB_ENTER_HOME: mkdtempSync(path.join(os.tmpdir(), 'tab-enter-e2e-')),
      TAB_ENTER_PORT: String(port),
      TAB_ENTER_NO_OPEN: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  signInUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`app didn't start:\n${output}`)), 240_000);
    const onData = (d: Buffer) => {
      output = (output + d.toString()).slice(-8000);
      const m = /tab-enter is running: (\S+)/.exec(output);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]!);
      }
    };
    app.stdout!.on('data', onData);
    app.stderr!.on('data', onData);
    app.on('exit', (code) => reject(new Error(`app exited (${code}):\n${output}`)));
  });
  base = new URL(signInUrl).origin;
  browser = await launch();
  page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  page.setDefaultTimeout(60_000); // the dev server compiles each page on first visit
});

afterAll(async () => {
  await browser?.close();
  if (app?.pid && app.exitCode === null) {
    // Kill the whole tree (pnpm → next dev, tsx → worker) and wait for it: a
    // fire-and-forget kill dies with the test process and leaves next dev running.
    if (process.platform === 'win32')
      spawnSync('taskkill', ['/pid', String(app.pid), '/T', '/F'], { stdio: 'ignore' });
    else {
      app.kill('SIGTERM');
      await new Promise((r) => app.once('exit', r));
    }
  }
});

describe('tab-enter in demo mode', () => {
  it('refuses requests without the session token', async () => {
    const res = await fetch(`${base}/`, { redirect: 'manual' });
    expect(res.status).toBe(401);
    expect(await res.text()).toContain('Not signed in');
  });

  it('signs in with the one-time link and opens Now, dark by default', async () => {
    await page.goto(signInUrl);
    // A fresh install starts at first-run setup, with the demo one click away.
    await page.waitForURL(`${base}/setup`);
    await page.getByRole('heading', { name: 'Set up tab-enter' }).waitFor();
    expect(new URL(page.url()).searchParams.get('token')).toBeNull(); // token swapped for a cookie
    expect(await page.locator('html').getAttribute('data-theme')).toBe('dark');
    await page.getByRole('button', { name: 'Explore the demo first' }).click();
    await page.waitForURL(`${base}/`);
    await page.getByText('Demo mode: invented data').waitFor();
    await page.getByRole('heading', { name: 'Up next' }).waitFor();
  });

  it('switches theme and remembers it', async () => {
    await page.getByRole('radio', { name: 'Light' }).first().click();
    await expect.poll(() => page.locator('html').getAttribute('data-theme')).toBe('light');
    await page.waitForTimeout(500); // let the save land
    await page.reload();
    expect(await page.locator('html').getAttribute('data-theme')).toBe('light');
    await page.getByRole('radio', { name: 'Dark' }).first().click();
    await expect.poll(() => page.locator('html').getAttribute('data-theme')).toBe('dark');
  });

  it('navigates with the keyboard (g then a)', async () => {
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('g');
    await page.keyboard.press('a');
    await page.waitForURL(`${base}/active`);
    await page.getByRole('heading', { name: 'Active Work' }).waitFor();
    await page
      .getByText(/SHOP-\d+/)
      .first()
      .waitFor();
  });

  it('runs a suggestion in (replayed) Claude Code and shows the run', async () => {
    await page.goto(`${base}/`);
    await page
      .getByRole('button', { name: /Run in Claude Code/ })
      .first()
      .click();
    await page.waitForURL(/\/runs\/[\w-]+$/);
    await page.getByText('Done', { exact: true }).first().waitFor({ timeout: 90_000 });
  });

  it('drafts the daily report without AI', async () => {
    await page.goto(`${base}/communication`);
    const report = page.locator('textarea').first();
    await report.waitFor();
    expect(await report.inputValue()).toMatch(/SHOP-\d+/);
  });

  it('reviews an MR with (replayed) Claude and shows structured findings', async () => {
    await page.goto(`${base}/review`);
    await page.getByRole('button', { name: 'Review with Claude' }).first().click();
    await page
      .getByText(/Blockers/)
      .first()
      .waitFor({ timeout: 90_000 });
  });

  it('verifies a completed ticket and opens the slideshow', async () => {
    await page.goto(`${base}/verification`);
    await page.getByRole('button', { name: 'Verify' }).first().click();
    const link = page.getByRole('link', { name: /View slideshow/ }).first();
    await link.waitFor({ timeout: 90_000 });
    await link.click();
    const frame = page.frameLocator('iframe');
    await frame
      .getByText(/Verification/)
      .first()
      .waitFor();
  });

  it('shows Settings with the appearance control and tool status', async () => {
    await page.goto(`${base}/settings`);
    await page.getByRole('heading', { name: 'Appearance' }).waitFor();
    await page.getByText('Claude Code', { exact: true }).first().waitFor();
  });

  it('sets up a real profile with the wizard and removes the demo', async () => {
    await page.goto(`${base}/`);
    await page.getByRole('link', { name: 'Set up your profile' }).click();
    await page.getByLabel('Profile name').fill('Acme');
    await page.getByRole('button', { name: 'Create profile and continue' }).click();
    await page.waitForURL(`${base}/setup?step=connect`);
    await page.getByRole('heading', { name: 'Connect Jira and GitLab' }).waitFor();
    await page.getByRole('link', { name: 'Next: Claude Code' }).click();
    await page.waitForURL(`${base}/setup?step=claude`);
    await page.getByRole('button', { name: 'Save and continue' }).click();
    await page.waitForURL(`${base}/setup?step=done`);
    await page.getByText('Not configured (see Settings)').first().waitFor();
    await page.getByRole('button', { name: 'Open tab-enter' }).click();
    await page.waitForURL(`${base}/`);
    const profiles = await page
      .getByRole('combobox', { name: 'Active profile' })
      .locator('option')
      .allTextContents();
    expect(profiles).toEqual(['Acme']);
    expect(await page.getByText('Demo mode: invented data').count()).toBe(0);
  });
});
