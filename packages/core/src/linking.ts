import type { LinkSource, ManualLink, MergeRequest, MRIssueLink } from './types';
import { mrKey } from './types';

/**
 * Find issue keys in free text. The configured pattern is wrapped so it can't
 * match inside a longer token (e.g. "XABC-1", or "ABC-12" inside "ABC-123" or "ABC-12x").
 */
export function extractIssueKeys(text: string, keyRegex: string): string[] {
  if (!text) return [];
  const re = new RegExp(`(?<![A-Za-z0-9])(?:${keyRegex})(?![A-Za-z0-9])`, 'g');
  const found = new Set<string>();
  for (const match of text.matchAll(re)) found.add(match[0]);
  return [...found];
}

/**
 * Link an MR to issue keys. Rules, in precedence order: source branch, title,
 * description. Keys found by any rule are linked (an MR can cover several
 * tickets); each link records the highest-precedence rule that found it.
 * Manual unlinks remove a key and manual links add one, overriding the rules.
 */
export function linkMergeRequest(
  mr: Pick<MergeRequest, 'ref' | 'sourceBranch' | 'title' | 'description'>,
  opts: { keyRegex: string; manual?: ManualLink[] },
): MRIssueLink[] {
  const links = new Map<string, LinkSource>();
  const rules: [LinkSource, string][] = [
    ['branch', mr.sourceBranch],
    ['title', mr.title],
    ['description', mr.description],
  ];
  for (const [source, text] of rules) {
    for (const key of extractIssueKeys(text, opts.keyRegex)) {
      if (!links.has(key)) links.set(key, source);
    }
  }

  const key = mrKey(mr.ref);
  for (const m of opts.manual ?? []) {
    if (m.mrKey !== key) continue;
    if (m.action === 'unlink') links.delete(m.issueKey);
    else links.set(m.issueKey, 'manual');
  }

  return [...links].map(([issueKey, source]) => ({ issueKey, source }));
}
