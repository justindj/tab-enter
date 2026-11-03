import {
  acceptanceCriteriaBlock,
  commentsBlock,
  pipelineBlock,
  threadsBlock,
  ticketBlock,
  truncate,
} from './context';
import type { PresetId, ProfileSettings } from './settings';
import { renderTemplate, type SuggestionKind, type TemplateVariable } from './templates';
import type { IssueDetail, MergeRequest } from './types';
import type { MRView, Workspace } from './workspace';

// The suggestion engine: plain code, no AI. Ranked per spec section 4.1:
// feedback on my MRs → failing pipelines → conflicts → reviews requested of
// me → my next ticket. Each MR appears once, under its most urgent reason.

export interface Suggestion {
  /** Stable across syncs, e.g. "address-feedback:42!12". */
  id: string;
  kind: SuggestionKind;
  title: string;
  /** Why it's suggested, e.g. "2 unresolved threads · pipeline failed". */
  reason: string;
  issueKey: string | null;
  mrKey: string | null;
  /** Task preset for Run in Claude Code; null when the action isn't a Claude run (yet). */
  preset: PresetId | null;
  prompt: string;
  links: { jira: string | null; gitlab: string | null };
  /** GitLab project the work happens in, when known. */
  projectId: string | null;
}

const KIND_PRESET: Record<SuggestionKind, PresetId | null> = {
  'address-feedback': 'address-feedback',
  'fix-pipeline': 'address-feedback',
  'resolve-conflicts': 'address-feedback',
  // Structured review runs arrive with the Code Review page (M5); copy the prompt until then.
  review: null,
  'next-ticket': 'work-ticket',
};

const MAX_NEXT_TICKETS = 3;

export function promptVariables(
  settings: ProfileSettings,
  issue: IssueDetail | undefined,
  mr: MergeRequest | undefined,
): Partial<Record<TemplateVariable, string>> {
  const caps = settings.contextCaps;
  const vars: Partial<Record<TemplateVariable, string>> = {};
  if (issue) {
    vars['ticket.key'] = issue.key;
    vars['ticket.summary'] = issue.summary;
    vars['ticket.url'] = issue.url;
    vars['ticket.details'] = ticketBlock(issue, caps);
    vars['ticket.description'] = truncate(issue.description, caps.descriptionChars);
    vars['ticket.acceptanceCriteria'] = acceptanceCriteriaBlock(issue);
    vars['ticket.comments'] = commentsBlock(issue, caps);
  }
  if (mr) {
    vars['mr.url'] = mr.webUrl;
    vars['mr.title'] = mr.title;
    vars['mr.sourceBranch'] = mr.sourceBranch;
    vars['mr.targetBranch'] = mr.targetBranch;
    vars['mr.unresolvedThreads'] = threadsBlock(mr);
    vars['mr.pipelineFailures'] = pipelineBlock(mr.pipelineFailures, caps);
  }
  return vars;
}

/** The one project with a local clone, if there's exactly one. */
function defaultProjectId(settings: ProfileSettings): string | null {
  const withClone = settings.gitlab.projects.filter((p) => p.localPath);
  return withClone.length === 1 ? withClone[0]!.id : null;
}

export function buildSuggestions(workspace: Workspace, settings: ProfileSettings): Suggestion[] {
  const out: Suggestion[] = [];
  const issueFor = (v: MRView) =>
    v.issueKeys.map((k) => workspace.issuesByKey.get(k)).find((i) => i !== undefined);

  const make = (
    kind: SuggestionKind,
    title: string,
    reason: string,
    v?: MRView,
    issue?: IssueDetail,
  ) => {
    const linked = issue ?? (v ? issueFor(v) : undefined);
    out.push({
      id: `${kind}:${v?.key ?? linked?.key}`,
      kind,
      title,
      reason,
      issueKey: linked?.key ?? null,
      mrKey: v?.key ?? null,
      preset: KIND_PRESET[kind],
      prompt: renderTemplate(
        settings.promptTemplates[kind],
        promptVariables(settings, linked, v?.mr),
      ),
      links: { jira: linked?.url ?? null, gitlab: v?.mr.webUrl ?? null },
      projectId: v ? v.mr.ref.projectId : defaultProjectId(settings),
    });
  };

  // 1–3: my open MRs, each under its most urgent reason; the rest go in `reason`.
  const mine = workspace.inFlight;
  const byKind: Record<'address-feedback' | 'fix-pipeline' | 'resolve-conflicts', MRView[]> = {
    'address-feedback': [],
    'fix-pipeline': [],
    'resolve-conflicts': [],
  };
  const reasons = new Map<string, string>();
  for (const v of mine) {
    const { mr } = v;
    const why: string[] = [];
    const feedback = mr.changesRequested || mr.unresolvedThreads > 0;
    if (mr.unresolvedThreads > 0) {
      why.push(`${mr.unresolvedThreads} unresolved thread${mr.unresolvedThreads === 1 ? '' : 's'}`);
    } else if (mr.changesRequested) why.push('changes requested');
    if (mr.pipelineStatus === 'failed') why.push('pipeline failed');
    if (mr.hasConflicts) why.push('merge conflicts');
    if (why.length === 0) continue;
    reasons.set(v.key, why.join(' · '));
    if (feedback) byKind['address-feedback'].push(v);
    else if (mr.pipelineStatus === 'failed') byKind['fix-pipeline'].push(v);
    else byKind['resolve-conflicts'].push(v);
  }
  for (const v of byKind['address-feedback']) {
    make(
      'address-feedback',
      `Address feedback on !${v.mr.ref.iid} ${v.mr.title}`,
      reasons.get(v.key)!,
      v,
    );
  }
  for (const v of byKind['fix-pipeline']) {
    make(
      'fix-pipeline',
      `Fix the pipeline on !${v.mr.ref.iid} ${v.mr.title}`,
      reasons.get(v.key)!,
      v,
    );
  }
  for (const v of byKind['resolve-conflicts']) {
    make(
      'resolve-conflicts',
      `Resolve conflicts on !${v.mr.ref.iid} ${v.mr.title}`,
      reasons.get(v.key)!,
      v,
    );
  }

  // 4: reviews waiting on me, oldest first.
  for (const v of workspace.reviews.filter((r) => r.needsMyReview)) {
    make('review', `Review !${v.mr.ref.iid} ${v.mr.title}`, `by ${v.mr.author}`, v);
  }

  // 5: my next tickets: unstarted, current sprint, no open MR, in rank order.
  const next = workspace.activeIssues
    .filter(
      (v) =>
        v.issue.statusCategory === 'todo' &&
        v.issue.inOpenSprint &&
        !v.mrs.some((m) => m.mr.state === 'opened'),
    )
    .slice(0, MAX_NEXT_TICKETS);
  for (const { issue } of next) {
    const reason = [issue.priority && `${issue.priority} priority`, 'next in sprint rank']
      .filter(Boolean)
      .join(' · ');
    make('next-ticket', `Start ${issue.key} ${issue.summary}`, reason, undefined, issue);
  }
  return out;
}
