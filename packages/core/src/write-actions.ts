import { z } from 'zod';
import type { ProfileSettings } from './settings';

// Gated write actions (spec M7). Every action is off until enabled per profile
// in Settings, needs a confirmation click showing exactly what will be sent,
// and is logged locally with its payload and outcome. Nothing writes
// automatically.

const text = z.string().trim().min(1).max(20_000);

export const WriteActionSchema = z.discriminatedUnion('kind', [
  /** Push a run's branch to origin (never forced). */
  z.object({ kind: z.literal('git-push'), runId: z.string() }),
  /** Open a merge request for a run's (pushed) branch. */
  z.object({
    kind: z.literal('open-mr'),
    runId: z.string(),
    title: z.string().trim().min(1).max(255),
    description: z.string().max(20_000),
    targetBranch: z.string().trim().min(1).max(255),
  }),
  /** A general comment on a merge request. */
  z.object({ kind: z.literal('mr-comment'), mrKey: z.string(), body: text }),
  /** Line comments on a merge request's diff (falls back to a general comment per line it can't place). */
  z.object({
    kind: z.literal('mr-diff-comments'),
    mrKey: z.string(),
    comments: z
      .array(z.object({ file: z.string(), line: z.number().int().positive(), body: text }))
      .min(1)
      .max(50),
  }),
  /** Approve a merge request, only if its head is still the commit the user saw. */
  z.object({ kind: z.literal('mr-approve'), mrKey: z.string(), sha: z.string().min(7) }),
  z.object({ kind: z.literal('jira-comment'), issueKey: z.string(), body: text }),
  z.object({
    kind: z.literal('jira-transition'),
    issueKey: z.string(),
    transitionId: z.string(),
    transitionName: z.string(),
  }),
]);
export type WriteAction = z.infer<typeof WriteActionSchema>;
export type WriteKind = WriteAction['kind'];

export type WriteSetting = keyof ProfileSettings['writeActions'];

/** The per-profile toggle that must be on for each action. */
export const WRITE_SETTING: Record<WriteKind, WriteSetting> = {
  'git-push': 'gitPush',
  'open-mr': 'openMergeRequest',
  'mr-comment': 'gitlabComment',
  'mr-diff-comments': 'gitlabComment',
  'mr-approve': 'gitlabApprove',
  'jira-comment': 'jiraComment',
  'jira-transition': 'jiraTransition',
};

export const WRITE_SETTING_LABELS: Record<WriteSetting, { label: string; hint: string }> = {
  gitPush: {
    label: 'Push branches',
    hint: 'Push a run’s branch to origin with your own git credentials. Never force-pushes; never pushes main/master.',
  },
  openMergeRequest: {
    label: 'Open merge requests',
    hint: 'Create an MR for a pushed branch. Needs a GitLab token with the api scope.',
  },
  gitlabComment: {
    label: 'Post comments on merge requests',
    hint: 'Review comments (general or on lines) and verification summaries. Needs the api scope.',
  },
  gitlabApprove: {
    label: 'Approve merge requests',
    hint: 'Only after you confirm, and only if the MR head is still the commit you reviewed. Needs the api scope.',
  },
  jiraComment: { label: 'Comment on Jira tickets', hint: 'Verification summaries and notes.' },
  jiraTransition: {
    label: 'Move Jira tickets',
    hint: 'Change a ticket’s status via one of its workflow transitions.',
  },
};

export function isWriteAllowed(settings: ProfileSettings, kind: WriteKind): boolean {
  return settings.writeActions[WRITE_SETTING[kind]];
}

/** What the log (and the confirmation) say about an action. */
export function describeWrite(
  action: WriteAction,
  ctx: { branch?: string | null } = {},
): {
  summary: string;
  target: string;
} {
  switch (action.kind) {
    case 'git-push':
      return {
        summary: `Push branch ${ctx.branch ?? '(run branch)'} to origin`,
        target: ctx.branch ?? action.runId,
      };
    case 'open-mr':
      return {
        summary: `Open merge request "${action.title}" into ${action.targetBranch}`,
        target: ctx.branch ?? action.runId,
      };
    case 'mr-comment':
      return {
        summary: `Comment on merge request (${action.body.length} characters)`,
        target: action.mrKey,
      };
    case 'mr-diff-comments':
      return {
        summary: `${action.comments.length} line comment${action.comments.length === 1 ? '' : 's'} on merge request`,
        target: action.mrKey,
      };
    case 'mr-approve':
      return {
        summary: `Approve merge request at ${action.sha.slice(0, 12)}`,
        target: action.mrKey,
      };
    case 'jira-comment':
      return {
        summary: `Comment on ${action.issueKey} (${action.body.length} characters)`,
        target: action.issueKey,
      };
    case 'jira-transition':
      return {
        summary: `Move ${action.issueKey} via "${action.transitionName}"`,
        target: action.issueKey,
      };
  }
}

/** Branches tab-enter refuses to push to, whatever the settings say. */
export const PROTECTED_BRANCH =
  /^(main|master|develop|development|trunk|release(\/.*)?|production|prod)$/i;
