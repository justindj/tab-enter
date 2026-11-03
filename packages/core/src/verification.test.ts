import { describe, expect, it } from 'vitest';
import { DEFAULT_PRESETS, parseProfileSettings } from './settings';
import type { IssueDetail } from './types';
import {
  AssessmentSchema,
  buildSlideshow,
  classifyFiles,
  deriveOutcome,
  heuristicAssessment,
  parsePlaywrightReport,
  parseUiPageMap,
  parseWith,
  smokeWalkthrough,
  uiPagesFor,
  verificationSummary,
  WalkthroughSchema,
  walkthroughPrompt,
  type Evidence,
} from './verification';

const issue: IssueDetail = {
  key: 'A-1',
  summary: 'Reject invalid emails',
  status: 'Done',
  statusCategory: 'done',
  priority: null,
  rank: null,
  issueType: 'Bug',
  url: 'https://jira.example.test/browse/A-1',
  inOpenSprint: true,
  updatedAt: '2026-01-01T00:00:00.000Z',
  completedAt: '2026-01-01T00:00:00.000Z',
  description: 'Login accepts "jo@" <script>',
  acceptanceCriteria: ['Invalid email shows an error', 'Valid emails still log in'],
  comments: [],
};

const evidence = (over: Partial<Evidence> = {}): Evidence => ({
  mode: 'ui',
  changed: classifyFiles(['src/login/Login.tsx', 'src/login/validate.test.ts']),
  pipelineStatus: 'success',
  pipelineFailures: [],
  steps: [{ index: 0, step: { action: 'goto', path: '/login' }, ok: true }],
  ...over,
});

describe('walkthrough scripts', () => {
  it('validates the step format and rejects unknown actions', () => {
    const ok = parseWith(
      WalkthroughSchema,
      '```json\n{"title":"t","steps":[{"action":"goto","path":"/"},{"action":"screenshot","caption":"Home"}]}\n```',
    );
    expect(ok.ok).toBe(true);
    expect(
      parseWith(WalkthroughSchema, '{"title":"t","steps":[{"action":"eval","code":"x"}]}'),
    ).toMatchObject({
      ok: false,
    });
    expect(parseWith(WalkthroughSchema, 'nothing')).toEqual({
      ok: false,
      error: 'no JSON object found',
    });
  });

  it('asks for placeholders, never real credentials', () => {
    const prompt = walkthroughPrompt({
      issue,
      changed: classifyFiles(['src/Login.tsx']),
      baseUrl: 'http://localhost:3000',
      hasCredentials: true,
      descriptionChars: 4000,
    });
    expect(prompt).toContain('{{TEST_USER}}');
    expect(prompt).toContain('runs at http://localhost:3000');
    expect(prompt).toContain('- Invalid email shows an error');
  });

  it('classifies UI and test files', () => {
    expect(
      classifyFiles([
        'src/components/Cart.tsx',
        'src/cart/total.ts',
        'src/cart/total.test.ts',
        'tests/api.py',
        'api/handler.go',
      ]),
    ).toEqual({
      all: expect.any(Array),
      ui: ['src/components/Cart.tsx'],
      tests: ['src/cart/total.test.ts', 'tests/api.py'],
    });
  });
});

describe('outcome', () => {
  const allVerified = AssessmentSchema.parse({
    criteria: issue.acceptanceCriteria.map((text) => ({ text, result: 'verified' })),
  });

  it('passes only when every criterion is verified and nothing failed', () => {
    expect(deriveOutcome(evidence(), allVerified)).toBe('passed');
    expect(
      deriveOutcome(
        evidence({
          steps: [{ index: 0, step: { action: 'goto', path: '/' }, ok: false, error: 'timeout' }],
        }),
        allVerified,
      ),
    ).toBe('issues_found');
    expect(deriveOutcome(evidence({ pipelineStatus: 'failed' }), allVerified)).toBe('issues_found');
  });

  it('flags backend changes without tests as needing coverage', () => {
    expect(
      deriveOutcome(
        evidence({ mode: 'backend', steps: [], changed: classifyFiles(['api/x.go']) }),
        allVerified,
      ),
    ).toBe('needs_coverage');
  });

  it('labels evidence-only assessments and never claims "verified"', () => {
    const a = heuristicAssessment(issue, evidence(), 'Claude Code not approved');
    expect(a.criteria.map((c) => c.result)).toEqual(['partial', 'partial']);
    expect(a.summary).toContain('Claude Code not approved');
    expect(deriveOutcome(evidence(), a)).toBe('issues_found');
  });
});

describe('slideshow', () => {
  it('is self-contained, escapes content and hides passwords', () => {
    const html = buildSlideshow({
      issue,
      evidence: evidence({
        steps: [
          {
            index: 0,
            step: { action: 'fill', selector: '#pw', value: '{{TEST_PASSWORD}}' },
            ok: true,
          },
          {
            index: 1,
            step: { action: 'screenshot', caption: 'Error shown' },
            ok: true,
            screenshot: 's1.png',
          },
        ],
      }),
      assessment: heuristicAssessment(issue, evidence(), 'demo'),
      outcome: 'issues_found',
      diffExcerpts: [{ path: 'src/a.ts', diff: '+<b>' }],
      images: { 's1.png': 'data:image/png;base64,AAAA' },
      generatedAt: new Date('2026-01-01T00:00:00Z'),
      demo: false,
    });
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>"');
    expect(html).toContain('Fill #pw with ••••');
    expect(html).toContain('src="data:image/png;base64,AAAA"');
    expect(html).not.toMatch(/src="https?:/); // no external resources
    expect(html).toContain('Print / PDF');
  });

  it('summarises for copying', () => {
    expect(
      verificationSummary(issue, 'passed', {
        criteria: [{ text: 'X', result: 'verified', note: 'seen' }],
        summary: '',
      }),
    ).toBe('Verification of A-1 Reject invalid emails: Passed.\n- Verified: X (seen)');
  });
});

describe('repo Playwright tests, smoke checks, before/after and coverage', () => {
  const report = {
    suites: [
      {
        title: 'login.spec.ts',
        specs: [
          {
            title: 'shows an error for invalid email',
            tests: [
              {
                status: 'expected',
                results: [
                  {
                    status: 'passed',
                    attachments: [
                      {
                        name: 'screenshot',
                        contentType: 'image/png',
                        path: '/w/test-results/a.png',
                      },
                      { name: 'trace', contentType: 'application/zip', path: '/w/t.zip' },
                    ],
                  },
                ],
              },
            ],
          },
        ],
        suites: [
          {
            title: 'remember me',
            specs: [
              {
                title: 'keeps the session',
                tests: [
                  {
                    status: 'unexpected',
                    results: [
                      {
                        status: 'failed',
                        error: { message: '\u001b[31mTimeout 5000ms\u001b[39m\nat x' },
                      },
                    ],
                  },
                ],
              },
              { title: 'later', tests: [{ status: 'skipped', results: [] }] },
            ],
          },
        ],
      },
    ],
  };

  it('reads the JSON reporter: statuses, first error line, PNG attachments', () => {
    const r = parsePlaywrightReport(report);
    expect(r).toMatchObject({
      passed: 1,
      failed: 1,
      skipped: 1,
      attachments: ['/w/test-results/a.png'],
    });
    expect(r.tests[1]).toEqual({
      title: 'login.spec.ts › remember me › keeps the session',
      status: 'failed',
      error: 'Timeout 5000ms',
    });
    expect(parsePlaywrightReport(null)).toMatchObject({ passed: 0, tests: [] });
  });

  it('maps backend files to UI pages, skipping malformed lines', () => {
    const map = parseUiPageMap(
      'src/api/orders/** => /orders\nnot a rule\n**/billing/*.go => /billing\n',
    );
    expect(map).toEqual([
      { glob: 'src/api/orders/**', path: '/orders' },
      { glob: '**/billing/*.go', path: '/billing' },
    ]);
    expect(uiPagesFor(['src/api/orders/list.ts', 'svc/billing/x.go'], map)).toEqual([
      '/orders',
      '/billing',
    ]);
    expect(uiPagesFor(['README.md'], map)).toEqual([]);
    expect(smokeWalkthrough(['/orders']).steps).toEqual([
      { action: 'goto', path: '/orders' },
      { action: 'screenshot', caption: 'Smoke check: /orders' },
    ]);
  });

  it('fails the outcome on failing repo tests or smoke pages', () => {
    const verified = AssessmentSchema.parse({
      criteria: [{ text: 'x', result: 'verified' }],
    });
    const spec = {
      command: 'npx playwright test',
      passed: 2,
      failed: 0,
      skipped: 0,
      tests: [],
      screenshots: [],
    };
    expect(deriveOutcome(evidence({ steps: [], spec }), verified)).toBe('passed');
    expect(deriveOutcome(evidence({ steps: [], spec: { ...spec, failed: 1 } }), verified)).toBe(
      'issues_found',
    );
    expect(
      deriveOutcome(
        evidence({
          smoke: [{ index: 0, step: { action: 'goto', path: '/o' }, ok: false, error: '500' }],
        }),
        verified,
      ),
    ).toBe('issues_found');
    // Evidence only: passing repo tests count as UI evidence.
    expect(heuristicAssessment(issue, evidence({ steps: [], spec }), 'x').criteria[0]!.result).toBe(
      'partial',
    );
  });

  it('shows before/after pairs, repo test results and the coverage change', () => {
    const html = buildSlideshow({
      issue,
      evidence: evidence({
        steps: [
          {
            index: 0,
            step: { action: 'screenshot', caption: 'Error shown' },
            ok: true,
            screenshot: 'a.png',
            beforeScreenshot: 'before/a.png',
          },
        ],
        coverage: { head: 81.25, base: 82 },
      }),
      assessment: heuristicAssessment(issue, evidence(), 'demo'),
      outcome: 'issues_found',
      diffExcerpts: [],
      images: {
        'a.png': 'data:image/png;base64,AFTER',
        'before/a.png': 'data:image/png;base64,BEFORE',
      },
      generatedAt: new Date('2026-01-01T00:00:00Z'),
      demo: false,
    });
    expect(html).toContain('Before (target branch)');
    expect(html.indexOf('BEFORE')).toBeLessThan(html.indexOf('AFTER'));
    expect(html).toContain('Coverage: <strong>81.3%</strong>');
    expect(html).toContain('-0.8');

    const specHtml = buildSlideshow({
      issue,
      evidence: evidence({
        steps: [],
        spec: {
          command: 'npx playwright test e2e/',
          passed: 1,
          failed: 1,
          skipped: 0,
          tests: [
            { title: 'ok <one>', status: 'passed' },
            { title: 'bad', status: 'failed', error: 'Timeout' },
          ],
          screenshots: ['spec-01.png'],
        },
      }),
      assessment: heuristicAssessment(issue, evidence(), 'demo'),
      outcome: 'issues_found',
      diffExcerpts: [],
      images: { 'spec-01.png': 'data:image/png;base64,SPEC' },
      generatedAt: new Date('2026-01-01T00:00:00Z'),
      demo: false,
    });
    expect(specHtml).toContain('Playwright tests');
    expect(specHtml).toContain('ok &lt;one&gt;');
    expect(specHtml).toContain('bad — Timeout');
    expect(specHtml).toContain('base64,SPEC');
    expect(specHtml).not.toContain('<h1>Walkthrough</h1>');
  });
});

describe('preset upgrade', () => {
  it('replaces the old write-capable verification preset with the read-only one', () => {
    const old = {
      ...DEFAULT_PRESETS['verification-script'],
      allowedTools: ['Read', 'Write({{artifactsDir}}/**)', 'Bash(npx playwright:*)'],
      permissionMode: 'acceptEdits',
    };
    const s = parseProfileSettings({
      claude: { presets: { ...DEFAULT_PRESETS, 'verification-script': old } },
    });
    expect(s.claude.presets['verification-script'].allowedTools).toEqual(['Read', 'Grep', 'Glob']);
  });
});
