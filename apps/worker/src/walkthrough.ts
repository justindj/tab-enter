import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  describeStep,
  TEST_PASSWORD,
  TEST_USER,
  type StepOutcome,
  type Walkthrough,
  type WalkthroughStep,
} from '@tab-enter/core';
import { chromium, type Browser, type Page } from 'playwright-core';

// Runs a JSON walkthrough with Playwright in the user's installed Edge or
// Chrome (no browser download). Only the configured base URL's origin is ever
// opened; credentials are filled from placeholders here, never from prompts.

export interface WalkthroughOptions {
  baseUrl: string;
  credentials?: { username: string; password: string } | null;
  outDir: string;
  video: boolean;
  /** Per step; a slow app gets this long to respond. */
  stepTimeoutMs?: number;
  /** Tests inject a browser launcher. */
  launch?: () => Promise<Browser>;
}

export class WalkthroughError extends Error {}

/** Resolve a step path against the base URL, refusing any other origin. */
export function resolveStepUrl(baseUrl: string, target: string): string {
  const base = new URL(baseUrl);
  const url = new URL(target, base);
  if (url.origin !== base.origin) {
    throw new WalkthroughError(
      `Refusing to open ${url.origin}: walkthroughs stay on ${base.origin}.`,
    );
  }
  return url.toString();
}

async function launchInstalledBrowser(): Promise<Browser> {
  const errors: string[] = [];
  for (const channel of ['msedge', 'chrome', undefined] as const) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch (err) {
      errors.push(`${channel ?? 'bundled chromium'}: ${String(err).split('\n')[0]}`);
    }
  }
  throw new WalkthroughError(
    `No browser for Playwright. Install Microsoft Edge or Google Chrome, or run "npx playwright install chromium". (${errors.join('; ')})`,
  );
}

function fillValue(value: string, creds: WalkthroughOptions['credentials']): string {
  if (!value.includes(TEST_USER) && !value.includes(TEST_PASSWORD)) return value;
  if (!creds)
    throw new WalkthroughError(
      'This step needs test credentials; set them in Settings → Verification.',
    );
  return value.replaceAll(TEST_USER, creds.username).replaceAll(TEST_PASSWORD, creds.password);
}

async function runStep(
  page: Page,
  step: WalkthroughStep,
  opts: WalkthroughOptions,
  timeout: number,
) {
  switch (step.action) {
    case 'goto':
      await page.goto(resolveStepUrl(opts.baseUrl, step.path), { timeout, waitUntil: 'load' });
      return;
    case 'click':
      if (step.selector) await page.locator(step.selector).first().click({ timeout });
      else if (step.text) {
        const byRole = page
          .getByRole('button', { name: step.text })
          .or(page.getByRole('link', { name: step.text }));
        const target =
          (await byRole.count()) > 0 ? byRole.first() : page.getByText(step.text).first();
        await target.click({ timeout });
      } else throw new WalkthroughError('A click needs a selector or text.');
      return;
    case 'fill':
      await page
        .locator(step.selector)
        .first()
        .fill(fillValue(step.value, opts.credentials), { timeout });
      return;
    case 'press':
      if (step.selector) await page.locator(step.selector).first().press(step.key, { timeout });
      else await page.keyboard.press(step.key);
      return;
    case 'expectText':
      await page.getByText(step.text).first().waitFor({ state: 'visible', timeout });
      return;
    case 'expectVisible':
      await page.locator(step.selector).first().waitFor({ state: 'visible', timeout });
      return;
    case 'wait':
      await page.waitForTimeout(step.ms);
      return;
    case 'screenshot':
      return; // taken by the caller
  }
}

/** Execute the steps in order, stopping at the first failure (with a screenshot of it). */
export async function runWalkthrough(
  script: Walkthrough,
  opts: WalkthroughOptions,
): Promise<StepOutcome[]> {
  await mkdir(opts.outDir, { recursive: true });
  const timeout = opts.stepTimeoutMs ?? 15_000;
  const browser = await (opts.launch ?? launchInstalledBrowser)();
  const outcomes: StepOutcome[] = [];
  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      ...(opts.video ? { recordVideo: { dir: path.join(opts.outDir, 'video') } } : {}),
    });
    const page = await context.newPage();
    // Block anything leaving the test origin (analytics, third parties): stay local.
    const origin = new URL(opts.baseUrl).origin;
    await page.route('**/*', (route) =>
      new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
    );
    for (const [index, step] of script.steps.entries()) {
      try {
        await runStep(page, step, opts, timeout);
        let screenshot: string | undefined;
        if (step.action === 'screenshot') {
          screenshot = `step-${String(index + 1).padStart(2, '0')}.png`;
          await page.screenshot({ path: path.join(opts.outDir, screenshot), fullPage: false });
        }
        outcomes.push({ index, step, ok: true, ...(screenshot ? { screenshot } : {}) });
      } catch (err) {
        const screenshot = `step-${String(index + 1).padStart(2, '0')}-failed.png`;
        await page.screenshot({ path: path.join(opts.outDir, screenshot) }).catch(() => {});
        const message = (err instanceof Error ? err.message : String(err)).split('\n')[0]!;
        outcomes.push({
          index,
          step,
          ok: false,
          error: `${describeStep(step)} failed: ${message}`,
          screenshot,
        });
        break;
      }
    }
    await context.close();
  } finally {
    await browser.close();
  }
  return outcomes;
}

/**
 * Start the app under test with the project's start command (in the worktree)
 * and wait until the base URL answers. Returns a stop function.
 */
export async function startApp(
  command: string,
  cwd: string,
  baseUrl: string,
  { timeoutMs = 120_000, env = process.env }: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<{ stop: () => void; output: () => string }> {
  // The user's own configured command, so it runs through their shell.
  const child: ChildProcess = spawn(command, {
    cwd,
    shell: true,
    env,
    windowsHide: true,
    detached: process.platform !== 'win32',
  });
  let output = '';
  child.stdout?.on('data', (d: Buffer) => (output = (output + d.toString()).slice(-4000)));
  child.stderr?.on('data', (d: Buffer) => (output = (output + d.toString()).slice(-4000)));
  let exited: number | null = null;
  child.on('exit', (code) => (exited = code ?? -1));

  const stop = () => {
    if (child.exitCode !== null || !child.pid) return;
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
    } else {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    }
  };

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exited !== null) {
      throw new WalkthroughError(
        `The start command exited (code ${exited}) before ${baseUrl} answered. Output: ${output.slice(-800)}`,
      );
    }
    try {
      const res = await fetch(baseUrl, { signal: AbortSignal.timeout(3000), redirect: 'manual' });
      if (res.status < 500) return { stop, output: () => output };
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  stop();
  throw new WalkthroughError(
    `${baseUrl} didn't answer within ${Math.round(timeoutMs / 1000)}s of "${command}". Output: ${output.slice(-800)}`,
  );
}
