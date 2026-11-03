import { describe, expect, it } from 'vitest';
import { DEFAULT_PRESETS, parseProfileSettings } from './settings';
import type { IssueDetail } from './types';
import {
  AssessmentSchema,
  buildSlideshow,
  classifyFiles,
  deriveOutcome,
  heuristicAssessment,
  parseWith,
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
