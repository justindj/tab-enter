// Prompt templates, one per suggestion type, editable per profile in Settings.
// {{variables}} are filled by the context builders (context.ts); unknown or
// empty variables render as nothing, and lines left empty by them are dropped.

export const SUGGESTION_KINDS = [
  'address-feedback',
  'fix-pipeline',
  'resolve-conflicts',
  'review',
  'next-ticket',
] as const;
export type SuggestionKind = (typeof SUGGESTION_KINDS)[number];

export const TEMPLATE_VARIABLES = [
  'ticket.key',
  'ticket.summary',
  'ticket.url',
  'ticket.details',
  'ticket.description',
  'ticket.acceptanceCriteria',
  'ticket.comments',
  'mr.url',
  'mr.title',
  'mr.sourceBranch',
  'mr.targetBranch',
  'mr.unresolvedThreads',
  'mr.pipelineFailures',
] as const;
export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number];

export const DEFAULT_TEMPLATES: Record<SuggestionKind, string> = {
  'next-ticket': `Implement Jira ticket {{ticket.key}}: {{ticket.summary}}

{{ticket.details}}

Acceptance criteria:
{{ticket.acceptanceCriteria}}

Recent comments:
{{ticket.comments}}

Work on the current branch. Keep the change focused on this ticket, add or update tests, and run the project's tests and linter. Commit locally with a message starting with {{ticket.key}}. Do not push.`,

  'address-feedback': `Address the review feedback on merge request "{{mr.title}}" ({{mr.url}}), branch {{mr.sourceBranch}}.

Unresolved threads:
{{mr.unresolvedThreads}}

Ticket {{ticket.key}}: {{ticket.summary}}
Acceptance criteria:
{{ticket.acceptanceCriteria}}

Make the requested changes, keep everything else as is, run the tests, and commit locally. Do not push. Finish with a short note per thread saying what you changed (I'll reply on GitLab).`,

  'fix-pipeline': `The CI pipeline is failing on merge request "{{mr.title}}" ({{mr.url}}), branch {{mr.sourceBranch}}.

{{mr.pipelineFailures}}

Find the cause, fix it, and reproduce the failing step locally if you can. Run the tests and commit locally. Do not push.`,

  'resolve-conflicts': `Merge request "{{mr.title}}" ({{mr.url}}) has conflicts with {{mr.targetBranch}}.

Merge origin/{{mr.targetBranch}} into {{mr.sourceBranch}} (do not rebase) and resolve the conflicts, keeping both sides' intent. Run the tests and commit the merge locally. Do not push.

Ticket {{ticket.key}}: {{ticket.summary}}`,

  review: `Review merge request "{{mr.title}}" ({{mr.url}}), branch {{mr.sourceBranch}} into {{mr.targetBranch}}.

Ticket {{ticket.key}}: {{ticket.summary}}
Acceptance criteria:
{{ticket.acceptanceCriteria}}

List blockers (file, line, reason), non-blocking suggestions, and questions for the author, then recommend Approve, Approve with comments, or Request changes. Do not modify any files.`,
};

/** Fill {{variables}}. Lines whose only content was an empty variable are removed. */
export function renderTemplate(
  template: string,
  vars: Partial<Record<TemplateVariable, string>>,
): string {
  const lookup = vars as Record<string, string | undefined>;
  const lines = template.split('\n').flatMap((line) => {
    const hadVar = /\{\{[\w.]+\}\}/.test(line);
    const out = line.replace(/\{\{([\w.]+)\}\}/g, (_m, name: string) => lookup[name] ?? '');
    return hadVar && out.trim() === '' ? [] : [out];
  });
  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
