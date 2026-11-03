import { describe, expect, it } from 'vitest';
import { extractIssueKeys, isIssueKey, linkMergeRequest, manualOverrideFor } from './linking';
import { DEFAULT_KEY_REGEX } from './settings';

const ref = { projectId: '7', iid: 3 };

describe('manualOverrideFor', () => {
  const mr = { sourceBranch: 'feature/ABC-1-x', title: 'Fix', description: 'See DEF-2' };
  it('stores only differences from the rules', () => {
    expect(manualOverrideFor(mr, 'ABC-1', false, DEFAULT_KEY_REGEX)).toBe('unlink');
    expect(manualOverrideFor(mr, 'ABC-1', true, DEFAULT_KEY_REGEX)).toBeNull();
    expect(manualOverrideFor(mr, 'DEF-2', false, DEFAULT_KEY_REGEX)).toBe('unlink');
    expect(manualOverrideFor(mr, 'XYZ-9', true, DEFAULT_KEY_REGEX)).toBe('link');
    expect(manualOverrideFor(mr, 'XYZ-9', false, DEFAULT_KEY_REGEX)).toBeNull();
  });

  it('validates whole keys', () => {
    expect(isIssueKey('ABC-12', DEFAULT_KEY_REGEX)).toBe(true);
    expect(isIssueKey('ABC-12 ', DEFAULT_KEY_REGEX)).toBe(false);
    expect(isIssueKey('abc-12', DEFAULT_KEY_REGEX)).toBe(false);
  });
});

describe('extractIssueKeys', () => {
  it('finds keys in branch names', () => {
    expect(extractIssueKeys('feature/ABC-123-login-fix', DEFAULT_KEY_REGEX)).toEqual(['ABC-123']);
  });

  it('dedupes and keeps order of first appearance', () => {
    expect(extractIssueKeys('ABC-1 and XY2-40, again ABC-1', DEFAULT_KEY_REGEX)).toEqual([
      'ABC-1',
      'XY2-40',
    ]);
  });

  it('does not match inside longer tokens', () => {
    expect(extractIssueKeys('xABC-12 ABC-12x3', DEFAULT_KEY_REGEX)).toEqual([]);
  });

  it('does not match lowercase keys with the default regex', () => {
    expect(extractIssueKeys('feature/abc-123', DEFAULT_KEY_REGEX)).toEqual([]);
  });

  it('supports a custom regex', () => {
    expect(extractIssueKeys('fix for SHOP-9 and OPS-1', 'SHOP-\\d+')).toEqual(['SHOP-9']);
  });
});

describe('linkMergeRequest', () => {
  const opts = { keyRegex: DEFAULT_KEY_REGEX };

  it('prefers the branch as the link source', () => {
    const links = linkMergeRequest(
      { ref, sourceBranch: 'feature/ABC-1-x', title: 'ABC-1: thing', description: '' },
      opts,
    );
    expect(links).toEqual([{ issueKey: 'ABC-1', source: 'branch' }]);
  });

  it('falls through title then description, collecting all keys', () => {
    const links = linkMergeRequest(
      { ref, sourceBranch: 'cleanup', title: 'ABC-2 tidy', description: 'Also closes ABC-3' },
      opts,
    );
    expect(links).toEqual([
      { issueKey: 'ABC-2', source: 'title' },
      { issueKey: 'ABC-3', source: 'description' },
    ]);
  });

  it('returns no links for an unlinked MR', () => {
    expect(
      linkMergeRequest(
        { ref, sourceBranch: 'chore/deps', title: 'Bump deps', description: '' },
        opts,
      ),
    ).toEqual([]);
  });

  it('applies manual unlink and link overrides for this MR only', () => {
    const links = linkMergeRequest(
      { ref, sourceBranch: 'feature/ABC-1', title: '', description: 'see ABC-9' },
      {
        ...opts,
        manual: [
          { mrKey: '7!3', issueKey: 'ABC-9', action: 'unlink' },
          { mrKey: '7!3', issueKey: 'DEF-4', action: 'link' },
          { mrKey: '8!3', issueKey: 'ZZZ-1', action: 'link' },
        ],
      },
    );
    expect(links).toEqual([
      { issueKey: 'ABC-1', source: 'branch' },
      { issueKey: 'DEF-4', source: 'manual' },
    ]);
  });
});
