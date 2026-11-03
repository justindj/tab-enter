import { describe, expect, it } from 'vitest';
import {
  assembleDiff,
  buildReviewPrompt,
  formatBlockers,
  formatReview,
  globToRegExp,
  isExcluded,
  parseReviewResult,
  splitGitDiff,
} from './review';
import { parseProfileSettings } from './settings';

const globs = parseProfileSettings({}).reviewExcludeGlobs;
const caps = parseProfileSettings({}).contextCaps;

describe('diff hygiene', () => {
  it('matches the default exclusion globs', () => {
    expect(isExcluded('pnpm-lock.yaml', globs)).toBe(true);
    expect(isExcluded('apps/web/pnpm-lock.yaml', globs)).toBe(true);
    expect(isExcluded('src/__snapshots__/a.test.ts.snap', globs)).toBe(true);
    expect(isExcluded('vendor/lib/x.js', globs)).toBe(true);
    expect(isExcluded('public/app.min.js', globs)).toBe(true);
    expect(isExcluded('src/api.generated.ts', globs)).toBe(true);
    expect(isExcluded('src/vendors.ts', globs)).toBe(false);
    expect(isExcluded('src\\cart\\total.ts', globs)).toBe(false);
    expect(globToRegExp('src/*.ts').test('src/a/b.ts')).toBe(false);
  });

  it('drops excluded files and caps size, smallest files first', () => {
    const files = [
      { path: 'pnpm-lock.yaml', diff: '@@ lock' },
      { path: 'src/big.ts', diff: `@@\n${'+x\n'.repeat(400)}` },
      { path: 'src/small.ts', diff: '@@\n+y' },
    ];
    const out = assembleDiff(files, globs, 600);
    expect(out.excludedFiles).toEqual(['pnpm-lock.yaml']);
    expect(out.truncated).toBe(true);
    expect(out.diff.startsWith('--- src/small.ts')).toBe(true);
    expect(out.diff.length).toBeLessThan(700);
    expect(assembleDiff(files.slice(2), globs, 600)).toMatchObject({ truncated: false });
  });

  it('splits git diff output per file', () => {
    const text = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1..2 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      'diff --git a/img.png b/img.png',
      'Binary files differ',
    ].join('\n');
    expect(splitGitDiff(text)).toEqual([
      { path: 'src/a.ts', diff: '@@ -1 +1 @@\n-a\n+b\n' },
      { path: 'img.png', diff: '(binary or mode change)' },
    ]);
  });
});

describe('parseReviewResult', () => {
  const valid = {
    summary: 'ok',
    blockers: [{ file: 'a.ts', line: 3, reason: 'bug' }],
    suggestions: [{ file: 'b.ts', text: 'rename' }],
    questions: ['why?'],
    verdict: 'request_changes',
  };

  it('accepts bare, fenced or surrounded JSON, and "text" as the reason', () => {
    for (const reply of [
      JSON.stringify(valid),
      `\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``,
      `Here you go:\n${JSON.stringify(valid)}\nThanks`,
    ]) {
      const r = parseReviewResult(reply);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.review.suggestions[0]!.reason).toBe('rename');
    }
  });

  it('explains what is wrong so a retry can fix it', () => {
    expect(parseReviewResult('no json here')).toEqual({ ok: false, error: 'no JSON object found' });
    expect(parseReviewResult('{"verdict": "lgtm"}')).toMatchObject({
      ok: false,
      error: expect.stringContaining('verdict'),
    });
    expect(parseReviewResult('{oops}')).toMatchObject({
      ok: false,
      error: expect.stringContaining('invalid JSON'),
    });
  });
});

describe('prompt and copy text', () => {
  const mr = {
    title: 'Wishlist API',
    description: 'Adds endpoints',
    sourceBranch: 'feature/X-1',
    targetBranch: 'main',
    webUrl: 'https://gitlab.example.test/a/b/-/merge_requests/1',
    author: 'sam',
  };

  it('includes acceptance criteria, the diff and the JSON contract', () => {
    const prompt = buildReviewPrompt({
      mr,
      diff: '--- src/a.ts\n@@\n+x',
      truncated: true,
      excludedFiles: ['pnpm-lock.yaml'],
      caps,
      issue: {
        key: 'X-1',
        summary: 'Wishlist',
        acceptanceCriteria: ['Users can save items'],
      } as never,
    });
    expect(prompt).toContain('- Users can save items');
    expect(prompt).toContain('```diff\n--- src/a.ts');
    expect(prompt).toContain('Not shown (lockfiles/generated, by config): pnpm-lock.yaml');
    expect(prompt).toContain('cut at 60000 characters');
    expect(prompt).toContain('"verdict": "approve" | "approve_with_comments" | "request_changes"');
    expect(prompt).toContain('Do not modify anything');
  });

  it('re-reviews say what changed and list the previous blockers', () => {
    const prompt = buildReviewPrompt({
      mr,
      diff: '',
      truncated: false,
      excludedFiles: [],
      caps,
      previous: { sha: 'abcdef1234567890', blockers: [{ file: 'a.ts', line: 3, reason: 'bug' }] },
    });
    expect(prompt).toContain('since your previous review (commit abcdef123456)');
    expect(prompt).toContain('- a.ts:3: bug');
  });

  it('formats the review for copying', () => {
    const r = parseReviewResult(
      JSON.stringify({
        summary: 'Small change.',
        blockers: [{ file: 'a.ts', line: 3, reason: 'Null check missing.' }],
        suggestions: [],
        questions: ['Why now?'],
        verdict: 'request_changes',
      }),
    );
    if (!r.ok) throw new Error(r.error);
    expect(formatBlockers(r.review)).toBe('- a.ts:3: Null check missing.');
    expect(formatReview(r.review)).toBe(
      'Small change.\n\n**Blockers**\n- a.ts:3: Null check missing.\n\n**Questions**\n- Why now?\n\nRecommendation: Request changes',
    );
  });
});
