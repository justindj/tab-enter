import { MR_STATUS_LABELS } from './mr-status';
import type { ProfileSettings } from './settings';
import type { Suggestion } from './suggestions';
import type { ReportWindow } from './time-windows';
import type { IssueDetail } from './types';
import type { MRView, Workspace } from './workspace';

// Copy-paste Slack messages, generated from templates with no AI (spec 4.4).
// Builders produce structured items; renderers turn them into Slack mrkdwn or
// plain text, so one template serves both formats.

export type MessageFormat = 'slack' | 'plain';
export type MessageKind = 'daily-report' | 'review-request';

export const DEFAULT_MESSAGE_TEMPLATES: Record<MessageKind, string> = {
  'daily-report': `# Update for {{date}}

# Done
{{done}}

# In progress
{{inProgress}}

# Next
{{next}}

# Blockers
{{blockers}}`,
  'review-request': `Could I get a review on {{count}}, please?
{{mrs}}
Thanks!`,
};

export const MESSAGE_VARIABLES: Record<MessageKind, string[]> = {
  'daily-report': ['date', 'window', 'done', 'inProgress', 'next', 'blockers'],
  'review-request': ['count', 'mrs'],
};

/** One bullet: text with optional links, kept structured until rendering. */
export interface MessageItem {
  parts: (string | { text: string; url: string })[];
}

const link = (text: string, url: string | null | undefined) => (url ? { text, url } : text);

// ------------------------------------------------------------- rendering

/** Slack mrkdwn needs &, < and > escaped in text (not in link targets). */
function slackEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function renderItem(item: MessageItem, format: MessageFormat): string {
  return item.parts
    .map((p) => {
      if (typeof p === 'string') return format === 'slack' ? slackEscape(p) : p;
      if (format === 'slack') return `<${p.url}|${slackEscape(p.text).replace(/\|/g, '¦')}>`;
      return `${p.text} (${p.url})`;
    })
    .join('');
}

export function renderList(items: MessageItem[], format: MessageFormat, empty = 'None'): string {
  if (items.length === 0) return format === 'slack' ? `• _${empty}_` : `- ${empty}`;
  return items.map((i) => `${format === 'slack' ? '•' : '-'} ${renderItem(i, format)}`).join('\n');
}

/**
 * Fill a message template. "# Heading" lines become *bold* in Slack and
 * "Heading:" in plain text; {{name}} takes a pre-rendered value.
 */
export function renderMessage(
  template: string,
  values: Record<string, string>,
  format: MessageFormat,
): string {
  return template
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      const filled = line.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => values[name] ?? '');
      const heading = /^#\s+(.+)$/.exec(filled);
      if (!heading) return filled;
      const text = heading[1]!.trim();
      return format === 'slack' ? `*${slackEscape(text)}*` : `${text.replace(/:$/, '')}:`;
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ------------------------------------------------------------- formatting

function waited(fromIso: string, now: Date): string {
  const hours = Math.max(0, (now.getTime() - Date.parse(fromIso)) / 3_600_000);
  if (hours < 1) return 'under an hour';
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

export function formatReportDate(d: Date): string {
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

function issueItem(issue: IssueDetail, suffix = ''): MessageItem {
  return { parts: [link(issue.key, issue.url), ` ${issue.summary}${suffix}`] };
}

function mrRef(v: MRView): string | { text: string; url: string } {
  return link(`!${v.mr.ref.iid}`, v.mr.webUrl);
}

// ------------------------------------------------------------- daily report

export interface DailyReport {
  window: ReportWindow;
  done: MessageItem[];
  inProgress: MessageItem[];
  next: MessageItem[];
  blockers: MessageItem[];
  /** Done items may be missing before this point: older ones aren't synced. */
  syncedSince: Date | null;
}

export function buildDailyReport(input: {
  workspace: Workspace;
  settings: ProfileSettings;
  suggestions: Suggestion[];
  window: ReportWindow;
  now: Date;
  /** Earliest completion the sync keeps; Done can't reach further back. */
  syncedSince?: Date;
}): DailyReport {
  const { workspace, settings, window, now } = input;
  const inWindow = (iso: string | null) => {
    if (!iso) return false;
    const t = Date.parse(iso);
    return t >= window.start.getTime() && t <= window.end.getTime();
  };
  const mine = workspace.mergeRequests.filter((v) => v.isMine);

  // Done: tickets completed in the window, each with the MRs merged for it; then other merges.
  const merged = mine.filter((v) => v.mr.state === 'merged' && inWindow(v.mr.mergedAt));
  const doneIssues = [...workspace.issuesByKey.values()]
    .filter((i) => i.statusCategory === 'done' && inWindow(i.completedAt))
    .sort((a, b) => Date.parse(a.completedAt!) - Date.parse(b.completedAt!));
  const mentioned = new Set<string>();
  const done: MessageItem[] = doneIssues.map((issue) => {
    const mrs = merged.filter((v) => v.issueKeys.includes(issue.key));
    mrs.forEach((v) => mentioned.add(v.key));
    if (mrs.length === 0) return issueItem(issue);
    return {
      parts: [
        link(issue.key, issue.url),
        ` ${issue.summary} (merged `,
        ...mrs.flatMap((v, i) => (i ? [', ', mrRef(v)] : [mrRef(v)])),
        ')',
      ],
    };
  });
  for (const v of merged.filter((m) => !mentioned.has(m.key))) {
    done.push({ parts: ['Merged ', mrRef(v), ` ${v.mr.title}`] });
  }

  // In progress: started tickets with their open MRs' status.
  const inProgress: MessageItem[] = workspace.activeIssues
    .filter((v) => v.issue.statusCategory === 'in_progress')
    .map(({ issue, mrs }) => {
      const open = mrs.filter((m) => m.mr.state === 'opened');
      if (open.length === 0) return issueItem(issue, ' (no MR yet)');
      return {
        parts: [
          link(issue.key, issue.url),
          ` ${issue.summary}: `,
          ...open.flatMap((m, i) => [
            ...(i ? ['; '] : []),
            mrRef(m),
            ` ${MR_STATUS_LABELS[m.status.primary].toLowerCase()}`,
          ]),
        ],
      };
    });

  // Next: the top of the suggestion engine (reviews included; they're work too).
  const next: MessageItem[] = input.suggestions.slice(0, 3).map((s) => {
    const issue = s.issueKey ? workspace.issuesByKey.get(s.issueKey) : undefined;
    if (s.kind === 'next-ticket' && issue) return issueItem(issue);
    const view = s.mrKey ? workspace.mergeRequests.find((v) => v.key === s.mrKey) : undefined;
    const verb: Record<Suggestion['kind'], string> = {
      'address-feedback': 'Address review feedback on',
      'fix-pipeline': 'Fix the pipeline on',
      'resolve-conflicts': 'Resolve conflicts on',
      review: 'Review',
      'next-ticket': 'Start',
    };
    return view
      ? { parts: [`${verb[s.kind]} `, mrRef(view), ` ${view.mr.title}`] }
      : { parts: [s.title] };
  });

  // Blockers: failing pipelines, conflicts, stale reviews of my MRs, blocked tickets.
  const blockers: MessageItem[] = [];
  const staleMs = settings.timeWindows.staleReviewHours * 3_600_000;
  for (const v of workspace.inFlight) {
    const reasons: string[] = [];
    if (v.mr.pipelineStatus === 'failed') reasons.push('pipeline failing');
    if (v.mr.hasConflicts) reasons.push('merge conflicts');
    if (
      v.status.primary === 'awaiting_review' &&
      now.getTime() - Date.parse(v.mr.createdAt) > staleMs
    ) {
      reasons.push(`waiting for review for ${waited(v.mr.createdAt, now)}`);
    }
    if (reasons.length)
      blockers.push({ parts: [mrRef(v), ` ${v.mr.title}: ${reasons.join(', ')}`] });
  }
  const blockedNames = settings.jira.blockedStatuses.map((s) => s.toLowerCase());
  for (const { issue } of workspace.activeIssues) {
    if (blockedNames.includes(issue.status.toLowerCase())) {
      blockers.push(issueItem(issue, ` (${issue.status})`));
    }
  }

  return {
    window,
    done,
    inProgress,
    next,
    blockers,
    syncedSince: input.syncedSince && input.syncedSince > window.start ? input.syncedSince : null,
  };
}

export function renderDailyReport(
  report: DailyReport,
  template: string,
  format: MessageFormat,
  now: Date,
): string {
  return renderMessage(
    template,
    {
      date: formatReportDate(now),
      window: report.window.label,
      done: renderList(report.done, format, 'Nothing finished'),
      inProgress: renderList(report.inProgress, format, 'Nothing in progress'),
      next: renderList(report.next, format, 'Nothing queued'),
      blockers: renderList(report.blockers, format, 'None'),
    },
    format,
  );
}

// ------------------------------------------------------------- polish

export type PolishStyle = 'concise' | 'detailed';

export const POLISH_OPEN = '<message>';
export const POLISH_CLOSE = '</message>';

/** Prompt for the optional "Polish with Claude" (short-text preset, no tools, one turn). */
export function polishPrompt(text: string, style: PolishStyle, format: MessageFormat): string {
  const how =
    style === 'concise'
      ? 'Make it more concise: shorter bullets, no filler, same facts.'
      : 'Make it a little more detailed and readable for teammates, without inventing facts.';
  const fmt =
    format === 'slack'
      ? 'Keep Slack mrkdwn: *bold* headings, • bullets, and <url|text> links exactly as given.'
      : 'Keep it plain text with - bullets and URLs in parentheses.';
  return [
    'Rewrite the status message between the tags for a team Slack channel.',
    how,
    fmt,
    'Keep every ticket key, merge request number, link and number exactly. Keep the section headings.',
    'Reply with only the rewritten message, no preamble.',
    '',
    POLISH_OPEN,
    text,
    POLISH_CLOSE,
  ].join('\n');
}

/** The message inside a polish prompt (demo replay echoes it back). */
export function extractPolishMessage(prompt: string): string | null {
  const start = prompt.indexOf(POLISH_OPEN);
  const end = prompt.lastIndexOf(POLISH_CLOSE);
  if (start < 0 || end < start) return null;
  return prompt.slice(start + POLISH_OPEN.length, end).trim();
}

/** Strip a code fence or tags a model might wrap its answer in. */
export function cleanPolishResult(text: string): string {
  let t = text.trim();
  const fence = /^```[\w-]*\n([\s\S]*?)\n```$/.exec(t);
  if (fence) t = fence[1]!.trim();
  return (extractPolishMessage(t) ?? t).trim();
}

// ------------------------------------------------------------- review request

/** My open, non-draft MRs that still need approval, oldest first. */
export function reviewRequestMRs(workspace: Workspace): MRView[] {
  return workspace.inFlight
    .filter((v) => !v.mr.draft && v.mr.approvedBy.length < Math.max(1, v.mr.approvalsRequired))
    .sort((a, b) => Date.parse(a.mr.createdAt) - Date.parse(b.mr.createdAt));
}

export function buildReviewRequest(workspace: Workspace, now: Date): MessageItem[] {
  return reviewRequestMRs(workspace).map((v) => {
    // Skip the key prefix when the MR title already starts with it ("SHOP-104 Round…").
    const ticket = v.issueKeys.find((k) => !v.mr.title.includes(k)) ?? null;
    const issue = ticket ? workspace.issuesByKey.get(ticket) : undefined;
    return {
      parts: [
        ...(ticket ? [link(ticket, issue?.url), ' '] : []),
        link(v.mr.title, v.mr.webUrl),
        ` (+${v.mr.linesAdded} −${v.mr.linesRemoved}, open ${waited(v.mr.createdAt, now)})`,
      ],
    };
  });
}

export function renderReviewRequest(
  items: MessageItem[],
  template: string,
  format: MessageFormat,
): string {
  return renderMessage(
    template,
    {
      count: items.length === 1 ? 'this merge request' : `these ${items.length} merge requests`,
      mrs: renderList(items, format, 'No merge requests need review'),
    },
    format,
  );
}
