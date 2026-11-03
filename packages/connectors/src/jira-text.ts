// Jira text helpers. Cloud (REST v3) returns rich text as Atlassian Document
// Format (ADF) JSON; Data Center (REST v2) returns wiki-markup strings. Both are
// reduced to plain text with "- " bullets so context builders see one format.

interface AdfNode {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
}

function inline(nodes: AdfNode[] | undefined): string {
  return (nodes ?? []).map(adfInline).join('');
}

function adfInline(node: AdfNode): string {
  switch (node.type) {
    case 'text':
      return node.text ?? '';
    case 'hardBreak':
      return '\n';
    case 'mention':
      return String(node.attrs?.text ?? '@user');
    case 'emoji':
      return String(node.attrs?.text ?? node.attrs?.shortName ?? '');
    case 'inlineCard':
    case 'blockCard':
      return String(node.attrs?.url ?? '');
    case 'status':
      return `[${String(node.attrs?.text ?? '')}]`;
    case 'date': {
      const ts = Number(node.attrs?.timestamp);
      return Number.isFinite(ts) ? new Date(ts).toISOString().slice(0, 10) : '';
    }
    default:
      return inline(node.content);
  }
}

function adfBlocks(nodes: AdfNode[] | undefined, depth: number): string[] {
  const out: string[] = [];
  for (const node of nodes ?? []) {
    switch (node.type) {
      case 'paragraph':
      case 'heading':
        out.push(inline(node.content));
        break;
      case 'bulletList':
      case 'orderedList':
      case 'taskList':
        for (const [i, item] of (node.content ?? []).entries()) {
          const marker = node.type === 'orderedList' ? `${i + 1}.` : '-';
          const [first = '', ...rest] =
            item.type === 'taskItem' ? [inline(item.content)] : adfBlocks(item.content, depth + 1);
          out.push(`${'  '.repeat(depth)}${marker} ${first}`, ...rest);
        }
        break;
      case 'codeBlock':
        out.push('```', inline(node.content), '```');
        break;
      case 'blockquote':
      case 'panel':
      case 'expand':
      case 'nestedExpand':
        out.push(...adfBlocks(node.content, depth));
        break;
      case 'rule':
        out.push('---');
        break;
      case 'table':
        for (const row of node.content ?? []) {
          out.push(
            (row.content ?? []).map((cell) => adfBlocks(cell.content, 0).join(' ')).join(' | '),
          );
        }
        break;
      case 'mediaSingle':
      case 'mediaGroup':
        break;
      default:
        if (node.content) out.push(...adfBlocks(node.content, depth));
        else if (node.text) out.push(node.text);
    }
  }
  return out;
}

/** Plain text from an ADF document, a wiki-markup string, or null. */
export function jiraText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return wikiToText(value);
  if (typeof value === 'object') {
    return adfBlocks((value as AdfNode).content, 0)
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  return '';
}

/** Light wiki-markup cleanup: headings, bullets and {code} fences. */
export function wikiToText(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/^h[1-6]\.\s*/gm, '')
    .replace(/^([*#]+)\s+/gm, (_m, marks: string) => `${'  '.repeat(marks.length - 1)}- `)
    .replace(/\{code(?::[^}]*)?\}/g, '```')
    .replace(/\{noformat\}/g, '```')
    .trim();
}

const AC_HEADING = /^\s*(?:#+\s*|\*\*)?acceptance criteria\b[:*\s]*$/i;
const BULLET = /^\s*(?:[-*•]|\d+[.)]|\[[ xX]?\])\s+(.*)$/;

/**
 * Acceptance criteria are usually a list under an "Acceptance criteria" heading
 * in the description. Returns the list items, or [] when there's no such section.
 */
export function extractAcceptanceCriteria(description: string): string[] {
  const lines = description.split('\n');
  const start = lines.findIndex((l) => AC_HEADING.test(l));
  if (start < 0) return [];
  const items: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const bullet = BULLET.exec(line);
    if (bullet) {
      items.push(bullet[1]!.trim());
    } else if (line.trim() === '') {
      if (items.length > 0) continue;
    } else if (items.length > 0) {
      break; // next section
    }
  }
  return items.filter(Boolean);
}
