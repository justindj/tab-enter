import { z } from 'zod';
import { stripAnsi, truncate } from './context';
import { globToRegExp } from './review';
import type { IssueDetail, MergeRequest, PipelineFailure } from './types';

// Verification (spec 4.3). A UI walkthrough is a small JSON list of browser
// steps, not code: Claude writes the steps, tab-enter's own Playwright runner
// executes them against the configured test URL only, and fills credentials
// from the keychain via placeholders so they never reach a prompt.

export const TEST_USER = '{{TEST_USER}}';
export const TEST_PASSWORD = '{{TEST_PASSWORD}}';

const caption = z.string().max(200).optional();

export const WalkthroughStepSchema = z.discriminatedUnion('action', [
  /** Path (or URL on the same origin as the base URL). */
  z.object({ action: z.literal('goto'), path: z.string().min(1), caption }),
  z.object({
    action: z.literal('click'),
    selector: z.string().optional(),
    /** Visible text (role button/link first, then any text). */
    text: z.string().optional(),
    caption,
  }),
  z.object({ action: z.literal('fill'), selector: z.string().min(1), value: z.string(), caption }),
  z.object({
    action: z.literal('press'),
    key: z.string().min(1),
    selector: z.string().optional(),
    caption,
  }),
  z.object({ action: z.literal('expectText'), text: z.string().min(1), caption }),
  z.object({ action: z.literal('expectVisible'), selector: z.string().min(1), caption }),
  z.object({ action: z.literal('screenshot'), caption: z.string().min(1).max(200) }),
  z.object({ action: z.literal('wait'), ms: z.number().int().min(0).max(10_000), caption }),
]);
export type WalkthroughStep = z.infer<typeof WalkthroughStepSchema>;

export const WalkthroughSchema = z.object({
  title: z.string().min(1).max(200),
  steps: z.array(WalkthroughStepSchema).min(1).max(40),
});
export type Walkthrough = z.infer<typeof WalkthroughSchema>;

export type CriterionResult = 'verified' | 'partial' | 'not_verified';

export const AssessmentSchema = z.object({
  criteria: z.array(
    z.object({
      text: z.string(),
      result: z.enum(['verified', 'partial', 'not_verified']),
      note: z.string().default(''),
    }),
  ),
  /** Short captions per screenshot, by index (optional polish). */
  summary: z.string().default(''),
});
export type Assessment = z.infer<typeof AssessmentSchema>;

/** Pull a JSON object out of a reply (bare, fenced, or surrounded by prose). */
export function extractJson(text: string): unknown {
  const t = text.trim();
  const fence = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(t);
  const candidate = fence ? fence[1]! : t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1);
  if (!candidate.trim()) throw new Error('no JSON object found');
  return JSON.parse(candidate);
}

export function parseWith<T>(
  schema: z.ZodType<T>,
  text: string,
): { ok: true; value: T } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = extractJson(text);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const parsed = schema.safeParse(json);
  if (parsed.success) return { ok: true, value: parsed.data };
  const issue = parsed.error.issues[0];
  return { ok: false, error: `${issue?.path.join('.') || 'value'}: ${issue?.message}` };
}

// ------------------------------------------------------------- what changed

const UI_FILE =
  /\.(tsx|jsx|vue|svelte|html?|css|scss|sass|less|astro)$|(^|\/)(pages|components|views|app|templates|public)\//i;
const TEST_FILE =
  /(^|\/)(__tests__|tests?|spec|e2e)\/|\.(test|spec)\.[a-z]+$|_test\.(go|py|rb)$|Test\.(java|kt|cs)$/i;

export interface ChangedFiles {
  all: string[];
  ui: string[];
  tests: string[];
}

/** Rough split of a change into UI files and test files, to pick the evidence path. */
export function classifyFiles(paths: string[]): ChangedFiles {
  const tests = paths.filter((p) => TEST_FILE.test(p));
  const ui = paths.filter((p) => !TEST_FILE.test(p) && UI_FILE.test(p));
  return { all: paths, ui, tests };
}

// ------------------------------------------------------------- prompts

export function walkthroughPrompt(input: {
  issue: IssueDetail;
  mr?: Pick<MergeRequest, 'title' | 'webUrl' | 'sourceBranch'>;
  changed: ChangedFiles;
  baseUrl: string;
  hasCredentials: boolean;
  descriptionChars: number;
}): string {
  const { issue } = input;
  return [
    `Write a browser walkthrough that demonstrates Jira ticket ${issue.key} ("${issue.summary}") works, for a verification slideshow. The app under test runs at ${input.baseUrl}. The working directory is the change's code; read routes, components and labels to pick paths and selectors. Do not modify anything.`,
    issue.description.trim()
      ? `Ticket description:\n${truncate(issue.description, input.descriptionChars)}`
      : '',
    `Acceptance criteria:\n${issue.acceptanceCriteria.length ? issue.acceptanceCriteria.map((c) => `- ${c}`).join('\n') : '(none written; infer from the description)'}`,
    input.mr
      ? `Merge request: ${input.mr.title} (${input.mr.webUrl}), branch ${input.mr.sourceBranch}.`
      : '',
    `Changed UI files:\n${
      input.changed.ui
        .slice(0, 40)
        .map((f) => `- ${f}`)
        .join('\n') || '(none detected)'
    }`,
    input.hasCredentials
      ? `If a login is needed, fill the username field with ${TEST_USER} and the password field with ${TEST_PASSWORD} exactly; tab-enter substitutes test credentials. Never invent credentials.`
      : 'No test credentials are configured, so avoid flows that need a login.',
    `Reply with only this JSON (no prose, no code fence). Use paths relative to the base URL. Prefer stable selectors (labels, roles, data-testid). Add a "screenshot" step after each meaningful state, with a caption a product owner understands. Use "expectText"/"expectVisible" to check each acceptance criterion. At most 40 steps.
{
  "title": "short title",
  "steps": [
    { "action": "goto", "path": "/login", "caption": "optional" },
    { "action": "fill", "selector": "input[name=email]", "value": "jo@" },
    { "action": "click", "text": "Sign in" },
    { "action": "expectText", "text": "Enter a valid email address" },
    { "action": "screenshot", "caption": "Invalid email shows an inline error" }
  ]
}
Other actions: { "action": "click", "selector": "..." }, { "action": "press", "key": "Enter" }, { "action": "expectVisible", "selector": "..." }, { "action": "wait", "ms": 500 }.`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

export interface StepOutcome {
  index: number;
  step: WalkthroughStep;
  ok: boolean;
  error?: string;
  /** Screenshot file name in the run folder, if one was taken. */
  screenshot?: string;
  /** The same screenshot step on the target branch ("before"), when captured. */
  beforeScreenshot?: string;
}

/** Results of the client repo's own Playwright tests (spec command). */
export interface SpecRunResult {
  command: string;
  passed: number;
  failed: number;
  skipped: number;
  tests: { title: string; status: 'passed' | 'failed' | 'skipped'; error?: string }[];
  /** Screenshot file names (in the run folder) attached by the tests. */
  screenshots: string[];
  /** Set when the command couldn't run or its report couldn't be read. */
  error?: string;
}

export interface Evidence {
  mode: 'ui' | 'backend';
  changed: ChangedFiles;
  pipelineStatus: MergeRequest['pipelineStatus'] | 'none';
  pipelineFailures: PipelineFailure[];
  steps: StepOutcome[];
  /** Why the walkthrough couldn't run at all (app didn't start…). */
  walkthroughError?: string;
  /** UI tickets verified by the repo's own Playwright tests instead of a walkthrough. */
  spec?: SpecRunResult;
  /** Backend changes: screenshots of the UI pages they map to (Settings → Verification). */
  smoke?: StepOutcome[];
  /** Pipeline test coverage (percent) on the MR and on its target branch, when GitLab reports it. */
  coverage?: { head: number | null; base: number | null };
}

// ------------------------------------------------------------- spec + smoke

interface PwSuite {
  title?: string;
  suites?: PwSuite[];
  specs?: {
    title: string;
    tests?: {
      status?: string;
      results?: {
        status?: string;
        error?: { message?: string };
        attachments?: { name?: string; contentType?: string; path?: string }[];
      }[];
    }[];
  }[];
}

/**
 * Read Playwright's JSON reporter output: per-test status (expected and flaky
 * count as passed) and any PNG attachments (their absolute paths).
 */
export function parsePlaywrightReport(
  json: unknown,
): Omit<SpecRunResult, 'command' | 'screenshots'> & { attachments: string[] } {
  const tests: SpecRunResult['tests'] = [];
  const attachments: string[] = [];
  const walk = (suite: PwSuite, prefix: string[]) => {
    const titles = suite.title ? [...prefix, suite.title] : prefix;
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        const last = t.results?.at(-1);
        const status: 'passed' | 'failed' | 'skipped' =
          t.status === 'skipped'
            ? 'skipped'
            : t.status === 'expected' || t.status === 'flaky'
              ? 'passed'
              : 'failed';
        const error = last?.error?.message?.split('\n')[0];
        tests.push({
          title: [...titles, spec.title].join(' › '),
          status,
          ...(status === 'failed' && error ? { error: stripAnsi(error).slice(0, 300) } : {}),
        });
        for (const r of t.results ?? [])
          for (const a of r.attachments ?? [])
            if (a.path && a.contentType === 'image/png') attachments.push(a.path);
      }
    }
    for (const child of suite.suites ?? []) walk(child, titles);
  };
  const root = (json ?? {}) as { suites?: PwSuite[] };
  for (const s of root.suites ?? []) walk(s, []);
  const count = (s: string) => tests.filter((t) => t.status === s).length;
  return {
    tests,
    passed: count('passed'),
    failed: count('failed'),
    skipped: count('skipped'),
    attachments,
  };
}

/** "glob => /path" lines (Settings → Verification) → mapping rules; bad lines are skipped. */
export function parseUiPageMap(text: string | undefined): { glob: string; path: string }[] {
  return (text ?? '')
    .split(/\r?\n/)
    .map((line) => /^\s*(\S+)\s*=>\s*(\/\S*)\s*$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ glob: m[1]!, path: m[2]! }));
}

/** UI pages to smoke-check for a backend change (unique, in mapping order, at most 8). */
export function uiPagesFor(changed: string[], map: { glob: string; path: string }[]): string[] {
  const pages: string[] = [];
  for (const rule of map) {
    const re = globToRegExp(rule.glob);
    if (changed.some((f) => re.test(f)) && !pages.includes(rule.path)) pages.push(rule.path);
  }
  return pages.slice(0, 8);
}

/** A goto + screenshot walkthrough over the given pages. */
export function smokeWalkthrough(pages: string[]): Walkthrough {
  return {
    title: 'UI smoke check',
    steps: pages.flatMap((p) => [
      { action: 'goto' as const, path: p },
      { action: 'screenshot' as const, caption: `Smoke check: ${p}` },
    ]),
  };
}

export function assessmentPrompt(issue: IssueDetail, evidence: Evidence): string {
  const steps = evidence.steps
    .map(
      (s) =>
        `${s.ok ? 'PASS' : 'FAIL'} ${s.step.action}${'caption' in s.step && s.step.caption ? ` (${s.step.caption})` : ''}${'text' in s.step && s.step.text ? ` "${s.step.text}"` : ''}${s.error ? `: ${s.error}` : ''}`,
    )
    .join('\n');
  const spec = evidence.spec;
  const smoke = evidence.smoke ?? [];
  return [
    `Assess whether Jira ticket ${issue.key} ("${issue.summary}") meets each acceptance criterion, using only the evidence below. Be strict: "verified" needs direct evidence, "partial" means some evidence, "not_verified" means none or failing.`,
    `Acceptance criteria:\n${issue.acceptanceCriteria.map((c) => `- ${c}`).join('\n') || `- ${issue.summary}`}`,
    spec
      ? `The repo's Playwright tests (${spec.command}): ${spec.passed} passed, ${spec.failed} failed, ${spec.skipped} skipped.${spec.error ? ` Error: ${spec.error}` : ''}\n${spec.tests
          .slice(0, 40)
          .map((t) => `${t.status.toUpperCase()} ${t.title}${t.error ? `: ${t.error}` : ''}`)
          .join('\n')}`
      : evidence.mode === 'ui'
        ? `Browser walkthrough results:\n${steps || '(no steps ran)'}${evidence.walkthroughError ? `\nWalkthrough error: ${evidence.walkthroughError}` : ''}`
        : 'No UI walkthrough (backend change).',
    smoke.length
      ? `UI smoke check of affected pages: ${smoke.filter((s) => s.step.action === 'goto' && s.ok).length} loaded${smoke.some((s) => !s.ok) ? `, failure: ${smoke.find((s) => !s.ok)!.error}` : ''}.`
      : '',
    `Pipeline: ${evidence.pipelineStatus}${evidence.pipelineFailures.length ? `, failing jobs: ${evidence.pipelineFailures.map((f) => f.job).join(', ')}` : ''}.`,
    evidence.coverage && evidence.coverage.head !== null
      ? `Test coverage: ${evidence.coverage.head}%${evidence.coverage.base !== null ? ` (target branch ${evidence.coverage.base}%)` : ''}.`
      : '',
    `Changed test files: ${evidence.changed.tests.join(', ') || 'none'}.`,
    `Reply with only this JSON: {"criteria":[{"text":"<criterion as given>","result":"verified"|"partial"|"not_verified","note":"one sentence of evidence"}],"summary":"one or two sentences"}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Without Claude: the best we can say from evidence alone, clearly labelled. */
export function heuristicAssessment(
  issue: IssueDetail,
  evidence: Evidence,
  why: string,
): Assessment {
  const spec = evidence.spec;
  const uiOk =
    evidence.mode === 'ui' &&
    (spec
      ? !spec.error && spec.failed === 0 && spec.passed > 0
      : evidence.steps.length > 0 && evidence.steps.every((s) => s.ok));
  const pipelineOk = evidence.pipelineStatus === 'success';
  const result: CriterionResult =
    evidence.mode === 'ui'
      ? uiOk
        ? 'partial'
        : 'not_verified'
      : pipelineOk && evidence.changed.tests.length > 0
        ? 'partial'
        : 'not_verified';
  const criteria = (
    issue.acceptanceCriteria.length ? issue.acceptanceCriteria : [issue.summary]
  ).map((text) => ({ text, result, note: `Not assessed individually (${why}).` }));
  return { criteria, summary: `Assessed from evidence only (${why}).` };
}

export type VerificationOutcome = 'passed' | 'issues_found' | 'needs_coverage';

/**
 * Passed: every criterion verified and nothing failed. Needs coverage: no UI
 * walkthrough and no changed tests to show for it. Otherwise issues found.
 */
export function deriveOutcome(evidence: Evidence, assessment: Assessment): VerificationOutcome {
  const failed =
    evidence.steps.some((s) => !s.ok) ||
    (evidence.smoke ?? []).some((s) => !s.ok) ||
    !!evidence.walkthroughError ||
    !!evidence.spec?.error ||
    (evidence.spec?.failed ?? 0) > 0 ||
    evidence.pipelineStatus === 'failed';
  if (evidence.mode === 'backend' && evidence.changed.tests.length === 0 && !failed)
    return 'needs_coverage';
  if (
    !failed &&
    assessment.criteria.length > 0 &&
    assessment.criteria.every((c) => c.result === 'verified')
  ) {
    return 'passed';
  }
  return 'issues_found';
}

// ------------------------------------------------------------- slideshow

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface SlideshowInput {
  issue: IssueDetail;
  mr?: Pick<MergeRequest, 'title' | 'webUrl' | 'linesAdded' | 'linesRemoved' | 'ref'>;
  evidence: Evidence;
  assessment: Assessment;
  outcome: VerificationOutcome;
  /** Key diff excerpts (already trimmed). */
  diffExcerpts: { path: string; diff: string }[];
  /** Screenshot data URIs by file name. */
  images: Record<string, string>;
  generatedAt: Date;
  demo: boolean;
}

const RESULT_LABEL: Record<CriterionResult, string> = {
  verified: 'Verified',
  partial: 'Partially verified',
  not_verified: 'Not verified',
};

const OUTCOME_LABEL: Record<VerificationOutcome, string> = {
  passed: 'Passed',
  issues_found: 'Issues found',
  needs_coverage: 'Needs test coverage',
};

/** A self-contained, offline HTML slideshow (arrow keys; prints one slide per page). */
export function buildSlideshow(input: SlideshowInput): string {
  const { issue, mr, evidence, assessment } = input;
  const slides: string[] = [];

  slides.push(`<h1>${esc(issue.key)}: ${esc(issue.summary)}</h1>
<p class="muted">Verification ${esc(input.generatedAt.toLocaleString())} · ${OUTCOME_LABEL[input.outcome]}${input.demo ? ' · Demo data (simulated screenshots)' : ''}</p>
<h2>The problem</h2>
<p>${esc(truncate(issue.description || issue.summary, 1200)).replace(/\n/g, '<br>')}</p>
${issue.acceptanceCriteria.length ? `<h2>Acceptance criteria</h2><ul>${issue.acceptanceCriteria.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}`);

  slides.push(`<h1>The change</h1>
${mr ? `<p><a href="${esc(mr.webUrl)}">!${mr.ref.iid} ${esc(mr.title)}</a> · +${mr.linesAdded} −${mr.linesRemoved}</p>` : '<p class="muted">No merge request linked.</p>'}
<p>${evidence.changed.all.length} files changed${evidence.changed.ui.length ? `, ${evidence.changed.ui.length} UI` : ''}${evidence.changed.tests.length ? `, ${evidence.changed.tests.length} tests` : ''}.</p>
${input.diffExcerpts.map((d) => `<h3>${esc(d.path)}</h3><pre>${esc(d.diff)}</pre>`).join('')}`);

  const caption = (s: StepOutcome) =>
    ('caption' in s.step && s.step.caption) || `Step ${s.index + 1}`;
  const spec = evidence.spec;
  if (spec) {
    slides.push(`<h1>Playwright tests</h1>
<p><code>${esc(spec.command)}</code>: <strong>${spec.passed} passed</strong>${spec.failed ? `, <span class="bad">${spec.failed} failed</span>` : ''}${spec.skipped ? `, ${spec.skipped} skipped` : ''}</p>
${spec.error ? `<p class="bad">${esc(spec.error)}</p>` : ''}
<ul>${spec.tests
      .slice(0, 60)
      .map(
        (t) =>
          `<li class="${t.status === 'failed' ? 'bad' : t.status === 'skipped' ? 'muted' : 'verified'}">${esc(t.title)}${t.error ? ` — ${esc(t.error)}` : ''}</li>`,
      )
      .join('')}</ul>`);
    for (const name of spec.screenshots.filter((n) => input.images[n])) {
      slides.push(`<h2>${esc(name)}</h2><img src="${input.images[name]}" alt="${esc(name)}">`);
    }
  } else if (evidence.mode === 'ui') {
    const shots = evidence.steps.filter((s) => s.screenshot && input.images[s.screenshot]);
    const failed = evidence.steps.find((s) => !s.ok);
    slides.push(`<h1>Walkthrough</h1>
${evidence.walkthroughError ? `<p class="bad">The walkthrough could not run: ${esc(evidence.walkthroughError)}</p>` : ''}
<ol class="steps">${evidence.steps
      .map(
        (s) =>
          `<li class="${s.ok ? '' : 'bad'}">${esc(describeStep(s.step))}${s.error ? ` — ${esc(s.error)}` : ''}</li>`,
      )
      .join('')}</ol>
${failed ? `<p class="bad">Stopped at step ${failed.index + 1}.</p>` : ''}`);
    for (const s of shots) {
      const before = s.beforeScreenshot && input.images[s.beforeScreenshot];
      slides.push(
        before
          ? `<h2>${esc(caption(s))}</h2>
<div class="pair"><figure><figcaption class="muted">Before (target branch)</figcaption><img src="${before}" alt="Before: ${esc(caption(s))}"></figure>
<figure><figcaption class="muted">After (this change)</figcaption><img src="${input.images[s.screenshot!]}" alt="After: ${esc(caption(s))}"></figure></div>`
          : `<h2>${esc(caption(s))}</h2>
<img src="${input.images[s.screenshot!]}" alt="${esc(caption(s))}">`,
      );
    }
  }

  const smoke = evidence.smoke ?? [];
  if (smoke.length) {
    const failed = smoke.find((s) => !s.ok);
    slides.push(`<h1>UI smoke check</h1>
<p class="muted">Pages that this backend change maps to (Settings → Verification).</p>
${failed ? `<p class="bad">${esc(failed.error ?? 'A page failed to load.')}</p>` : ''}`);
    for (const s of smoke.filter((x) => x.screenshot && input.images[x.screenshot])) {
      slides.push(
        `<h2>${esc(caption(s))}</h2><img src="${input.images[s.screenshot!]}" alt="${esc(caption(s))}">`,
      );
    }
  }

  const cov = evidence.coverage;
  const coverageLine =
    cov && cov.head !== null
      ? `<p>Coverage: <strong>${cov.head.toFixed(1)}%</strong>${
          cov.base !== null
            ? ` (target branch ${cov.base.toFixed(1)}%, <span class="${cov.head + 0.05 < cov.base ? 'bad' : 'verified'}">${cov.head - cov.base >= 0 ? '+' : ''}${(cov.head - cov.base).toFixed(1)}</span>)`
            : ''
        }</p>`
      : '';

  slides.push(`<h1>Test evidence</h1>
<p>Pipeline: <strong>${esc(evidence.pipelineStatus)}</strong></p>
${coverageLine}
${evidence.pipelineFailures.map((f) => `<h3>Failing job: ${esc(f.job)} (${esc(f.stage)})</h3><pre>${esc(f.logTail.split('\n').slice(-25).join('\n'))}</pre>`).join('')}
<h2>Changed tests</h2>
${evidence.changed.tests.length ? `<ul>${evidence.changed.tests.map((t) => `<li><code>${esc(t)}</code></li>`).join('')}</ul>` : '<p class="bad">No test files changed.</p>'}`);

  slides.push(`<h1>Result: ${OUTCOME_LABEL[input.outcome]}</h1>
${assessment.summary ? `<p>${esc(assessment.summary)}</p>` : ''}
<table><thead><tr><th>Criterion</th><th>Result</th><th>Evidence</th></tr></thead><tbody>
${assessment.criteria.map((c) => `<tr><td>${esc(c.text)}</td><td class="${c.result}">${RESULT_LABEL[c.result]}</td><td>${esc(c.note)}</td></tr>`).join('')}
</tbody></table>`);

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(issue.key)} verification</title>
<style>
:root{color-scheme:light dark;--fg:#1a1a1a;--bg:#fff;--muted:#666;--bad:#c62828;--ok:#2e7d32;--warn:#b26a00;--line:#ddd}
@media (prefers-color-scheme:dark){:root{--fg:#eee;--bg:#161616;--muted:#aaa;--line:#333}}
*{box-sizing:border-box}body{margin:0;font:16px/1.5 system-ui,sans-serif;color:var(--fg);background:var(--bg)}
section{display:none;min-height:100vh;padding:48px max(24px,8vw)}section.on{display:block}
h1{font-size:28px;margin:0 0 12px}h2{font-size:20px}pre{background:rgba(127,127,127,.12);padding:12px;overflow:auto;font-size:12px;white-space:pre-wrap}
img{max-width:100%;max-height:72vh;border:1px solid var(--line);border-radius:6px}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:16px}.pair figure{margin:0}.pair img{max-height:60vh}
.muted{color:var(--muted)}.bad{color:var(--bad)}.verified{color:var(--ok)}.partial{color:var(--warn)}.not_verified{color:var(--bad)}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid var(--line);padding:8px;text-align:left;vertical-align:top}
nav{position:fixed;bottom:12px;right:16px;display:flex;gap:8px;align-items:center;font-size:13px}
button{font:inherit;padding:4px 10px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);cursor:pointer}
@media print{section{display:block!important;page-break-after:always;min-height:auto}nav{display:none}}
</style></head><body>
${slides.map((s, i) => `<section${i === 0 ? ' class="on"' : ''}>${s}</section>`).join('\n')}
<nav><button id="prev">←</button><span id="pos"></span><button id="next">→</button><button onclick="print()">Print / PDF</button></nav>
<script>
const s=[...document.querySelectorAll('section')];let i=0;const pos=document.getElementById('pos');
function show(n){i=Math.max(0,Math.min(s.length-1,n));s.forEach((x,k)=>x.classList.toggle('on',k===i));pos.textContent=(i+1)+' / '+s.length}
document.getElementById('prev').onclick=()=>show(i-1);document.getElementById('next').onclick=()=>show(i+1);
addEventListener('keydown',e=>{if(e.key==='ArrowRight'||e.key===' ')show(i+1);if(e.key==='ArrowLeft')show(i-1)});show(0);
</script></body></html>`;
}

export function describeStep(step: WalkthroughStep): string {
  switch (step.action) {
    case 'goto':
      return `Open ${step.path}`;
    case 'click':
      return `Click ${step.text ? `"${step.text}"` : step.selector}`;
    case 'fill':
      return `Fill ${step.selector} with ${step.value === TEST_PASSWORD ? '••••' : `"${step.value}"`}`;
    case 'press':
      return `Press ${step.key}`;
    case 'expectText':
      return `Check the page shows "${step.text}"`;
    case 'expectVisible':
      return `Check ${step.selector} is visible`;
    case 'screenshot':
      return `Screenshot: ${step.caption}`;
    case 'wait':
      return `Wait ${step.ms} ms`;
  }
}

/** One-paragraph summary for "Copy summary" (and the optional MR comment in M7). */
export function verificationSummary(
  issue: Pick<IssueDetail, 'key' | 'summary'>,
  outcome: VerificationOutcome,
  assessment: Assessment,
): string {
  const lines = assessment.criteria.map(
    (c) => `- ${RESULT_LABEL[c.result]}: ${c.text}${c.note ? ` (${c.note})` : ''}`,
  );
  return [
    `Verification of ${issue.key} ${issue.summary}: ${OUTCOME_LABEL[outcome]}.`,
    assessment.summary,
    ...lines,
  ]
    .filter(Boolean)
    .join('\n');
}
