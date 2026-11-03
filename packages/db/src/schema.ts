import type {
  AgentEvent,
  IssueDetail,
  JobType,
  LinkSource,
  MergeRequest,
  PresetId,
  ProfileSettings,
  ToolStatus,
} from '@tab-enter/core';
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

// Portable by construction: no SQLite-only SQL, so this ports to drizzle's
// pg-core for a hosted version. Every table carries user_id (always "local"
// in v1) and, where data belongs to a client, profile_id.
//
// Synced provider objects are stored whole in a JSON `data` column, with the
// fields we filter or sort on copied into real columns.

const id = () => text('id').primaryKey();
const ts = (name: string) => integer(name, { mode: 'timestamp_ms' });
const userId = () => text('user_id').notNull();
const profileId = () => text('profile_id').notNull();

export const users = sqliteTable('users', {
  id: id(),
  displayName: text('display_name').notNull(),
  createdAt: ts('created_at').notNull(),
});

export const profiles = sqliteTable(
  'profiles',
  {
    id: id(),
    userId: userId(),
    name: text('name').notNull(),
    isDemo: integer('is_demo', { mode: 'boolean' }).notNull().default(false),
    settings: text('settings', { mode: 'json' }).$type<ProfileSettings>().notNull(),
    /** Names (never values) of this profile's keychain entries, so deletion can wipe them. */
    secretNames: text('secret_names', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .$defaultFn(() => []),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [index('profiles_user_idx').on(t.userId)],
);

/** Small per-user key/value state, e.g. the active profile. */
export const appState = sqliteTable(
  'app_state',
  {
    userId: userId(),
    key: text('key').notNull(),
    value: text('value', { mode: 'json' }).$type<unknown>(),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.key] })],
);

/** Latest `claude` / `rtk` detection result, written by the worker. */
export const toolStatus = sqliteTable(
  'tool_status',
  {
    userId: userId(),
    tool: text('tool').$type<ToolStatus['tool']>().notNull(),
    status: text('status', { mode: 'json' }).$type<ToolStatus>().notNull(),
    checkedAt: ts('checked_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.tool] })],
);

export const issues = sqliteTable(
  'issues',
  {
    id: id(),
    userId: userId(),
    profileId: profileId(),
    key: text('key').notNull(),
    statusCategory: text('status_category').notNull(),
    inOpenSprint: integer('in_open_sprint', { mode: 'boolean' }).notNull(),
    rank: text('rank'),
    data: text('data', { mode: 'json' }).$type<IssueDetail>().notNull(),
    /** True while the issue is assigned to me and returned by the last sync. */
    assignedToMe: integer('assigned_to_me', { mode: 'boolean' }).notNull().default(true),
    updatedAt: ts('updated_at').notNull(),
    completedAt: ts('completed_at'),
    syncedAt: ts('synced_at').notNull(),
  },
  (t) => [uniqueIndex('issues_profile_key_uq').on(t.profileId, t.key)],
);

export const mergeRequests = sqliteTable(
  'merge_requests',
  {
    id: id(),
    userId: userId(),
    profileId: profileId(),
    /** "projectId!iid", see mrKey() in core. */
    mrKey: text('mr_key').notNull(),
    state: text('state').$type<MergeRequest['state']>().notNull(),
    isMine: integer('is_mine', { mode: 'boolean' }).notNull(),
    isReviewer: integer('is_reviewer', { mode: 'boolean' }).notNull(),
    /** I'm a reviewer, it's open, and I haven't approved it yet. */
    needsMyReview: integer('needs_my_review', { mode: 'boolean' }).notNull().default(false),
    data: text('data', { mode: 'json' }).$type<MergeRequest>().notNull(),
    updatedAt: ts('updated_at').notNull(),
    mergedAt: ts('merged_at'),
    syncedAt: ts('synced_at').notNull(),
  },
  (t) => [uniqueIndex('mrs_profile_key_uq').on(t.profileId, t.mrKey)],
);

/** Links computed by the linking rules at sync time (rebuilt each sync). */
export const mrIssueLinks = sqliteTable(
  'mr_issue_links',
  {
    userId: userId(),
    profileId: profileId(),
    mrKey: text('mr_key').notNull(),
    issueKey: text('issue_key').notNull(),
    source: text('source').$type<LinkSource>().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.profileId, t.mrKey, t.issueKey] }),
    index('links_issue_idx').on(t.profileId, t.issueKey),
  ],
);

/** User overrides; never touched by sync. */
export const manualLinks = sqliteTable(
  'manual_links',
  {
    userId: userId(),
    profileId: profileId(),
    mrKey: text('mr_key').notNull(),
    issueKey: text('issue_key').notNull(),
    action: text('action').$type<'link' | 'unlink'>().notNull(),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.profileId, t.mrKey, t.issueKey] })],
);

export const syncState = sqliteTable(
  'sync_state',
  {
    userId: userId(),
    profileId: profileId(),
    source: text('source').$type<'jira' | 'gitlab'>().notNull(),
    lastSyncedAt: ts('last_synced_at'),
    lastAttemptAt: ts('last_attempt_at'),
    lastError: text('last_error'),
    /** Provider-specific incremental cursor (e.g. max `updated` seen). */
    cursor: text('cursor'),
    /** Token expiry as the service reports it (GitLab), ISO date; null when unknown. */
    tokenExpiresAt: text('token_expires_at'),
  },
  (t) => [primaryKey({ columns: [t.profileId, t.source] })],
);

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export const agentRuns = sqliteTable(
  'agent_runs',
  {
    id: id(),
    userId: userId(),
    profileId: profileId(),
    agent: text('agent').notNull().default('claude-code'),
    issueKey: text('issue_key'),
    mrKey: text('mr_key'),
    preset: text('preset').$type<PresetId>().notNull(),
    prompt: text('prompt').notNull(),
    /** Claude Code session; a Continue reuses it with --resume. */
    sessionId: text('session_id'),
    /** The run this one continued, if any. */
    parentRunId: text('parent_run_id'),
    status: text('status').$type<RunStatus>().notNull(),
    /** Set by the UI; the worker stops the run at its next check. */
    cancelRequested: integer('cancel_requested', { mode: 'boolean' }).notNull().default(false),
    /** GitLab project the worktree belongs to. */
    projectId: text('project_id'),
    branch: text('branch'),
    cwd: text('cwd'),
    modelRequested: text('model_requested').notNull(),
    modelUsed: text('model_used'),
    exitCode: integer('exit_code'),
    error: text('error'),
    diffSummary: text('diff_summary', { mode: 'json' }).$type<{
      filesChanged: string[];
      /** After a task run: local commits not on the remote yet ("abc1234 message"). */
      commits?: string[];
      /** After a task run: files with uncommitted changes in the worktree. */
      uncommitted?: number;
    }>(),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    cacheReadTokens: integer('cache_read_tokens'),
    cacheCreationTokens: integer('cache_creation_tokens'),
    costUsd: real('cost_usd'),
    numTurns: integer('num_turns'),
    createdAt: ts('created_at').notNull(),
    startedAt: ts('started_at'),
    endedAt: ts('ended_at'),
  },
  (t) => [
    index('runs_profile_created_idx').on(t.profileId, t.createdAt),
    index('runs_issue_idx').on(t.profileId, t.issueKey),
  ],
);

/** The streamed log of a run, redacted before insert. */
export const runEvents = sqliteTable(
  'run_events',
  {
    runId: text('run_id').notNull(),
    seq: integer('seq').notNull(),
    profileId: profileId(),
    event: text('event', { mode: 'json' }).$type<AgentEvent>().notNull(),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.seq] })],
);

export type VerificationStatus =
  'not_run' | 'running' | 'passed' | 'issues_found' | 'needs_coverage' | 'failed';

export const verificationArtifacts = sqliteTable(
  'verification_artifacts',
  {
    id: id(),
    userId: userId(),
    profileId: profileId(),
    issueKey: text('issue_key').notNull(),
    mrKey: text('mr_key'),
    status: text('status').$type<VerificationStatus>().notNull(),
    /** BlobStore key of the slideshow HTML. */
    blobKey: text('blob_key'),
    /** Saved walkthrough script so it can be re-run without AI cost. */
    scriptBlobKey: text('script_blob_key'),
    criteria: text('criteria', { mode: 'json' }).$type<
      { text: string; result: 'verified' | 'partial' | 'not_verified' }[]
    >(),
    summary: text('summary'),
    runId: text('run_id'),
    /** ui = Playwright walkthrough; backend = test evidence only. */
    mode: text('mode').$type<'ui' | 'backend'>(),
    /** What went wrong when the job itself failed (not the checks). */
    error: text('error'),
    createdAt: ts('created_at').notNull(),
    finishedAt: ts('finished_at'),
  },
  (t) => [index('verif_issue_idx').on(t.profileId, t.issueKey)],
);

export const codeReviews = sqliteTable(
  'code_reviews',
  {
    id: id(),
    userId: userId(),
    profileId: profileId(),
    mrKey: text('mr_key').notNull(),
    /** Head commit reviewed; a re-review only sends what changed since. */
    reviewedSha: text('reviewed_sha').notNull(),
    runId: text('run_id'),
    result: text('result', { mode: 'json' }).$type<unknown>(),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [index('reviews_mr_idx').on(t.profileId, t.mrKey)],
);

export const messages = sqliteTable(
  'messages',
  {
    id: id(),
    userId: userId(),
    profileId: profileId(),
    kind: text('kind').$type<'daily-report' | 'review-request'>().notNull(),
    format: text('format').$type<'slack' | 'plain'>().notNull(),
    body: text('body').notNull(),
    windowStart: ts('window_start'),
    windowEnd: ts('window_end'),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [index('messages_profile_created_idx').on(t.profileId, t.createdAt)],
);

/** Every write to Jira/GitLab or push: what, where, when. */
export type WriteStatus = 'pending' | 'done' | 'failed';

/** Every write to Jira/GitLab and every push: what, where, when, and how it went. */
export const writeActionLog = sqliteTable(
  'write_action_log',
  {
    id: id(),
    userId: userId(),
    profileId: profileId(),
    /** WriteAction kind, e.g. "mr-approve". */
    action: text('action').notNull(),
    /** Human-readable target, e.g. "acme/shop!12" or "SHOP-101". */
    target: text('target').notNull(),
    summary: text('summary').notNull(),
    /** The exact request the user confirmed (comment text, sha…). */
    payload: text('payload', { mode: 'json' }).$type<unknown>(),
    status: text('status').$type<WriteStatus>().notNull().default('done'),
    /** e.g. { url } of the created note or MR. */
    result: text('result', { mode: 'json' }).$type<{ url?: string; message?: string }>(),
    error: text('error'),
    createdAt: ts('created_at').notNull(),
    finishedAt: ts('finished_at'),
  },
  (t) => [index('writes_profile_created_idx').on(t.profileId, t.createdAt)],
);

/**
 * removed: cleaned up after its MR merged or closed. needs_confirmation: has
 * uncommitted or unpushed work, so it waits for the user. kept: the user chose
 * to keep it; it isn't asked about again.
 */
export type WorktreeStatus = 'removed' | 'needs_confirmation' | 'kept';

/** tab-enter-managed worktrees the cleanup has acted on or is asking about. */
export const worktrees = sqliteTable(
  'worktrees',
  {
    id: id(),
    userId: userId(),
    profileId: profileId(),
    path: text('path').notNull(),
    /** The user's clone this worktree belongs to. */
    clonePath: text('clone_path').notNull(),
    branch: text('branch'),
    mrKey: text('mr_key'),
    /** "merged" or "closed": why it's up for cleanup. */
    reason: text('reason').notNull(),
    status: text('status').$type<WorktreeStatus>().notNull(),
    uncommitted: integer('uncommitted').notNull().default(0),
    /** One-line commits not on any remote. */
    unpushed: text('unpushed', { mode: 'json' })
      .$type<string[]>()
      .notNull()
      .$defaultFn(() => []),
    error: text('error'),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [uniqueIndex('worktrees_profile_path_idx').on(t.profileId, t.path)],
);

export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

/** SQLite-backed job queue; swappable for a hosted queue. */
export const jobs = sqliteTable(
  'jobs',
  {
    id: id(),
    userId: userId(),
    profileId: text('profile_id'),
    type: text('type').$type<JobType>().notNull(),
    payload: text('payload', { mode: 'json' }).$type<unknown>().notNull(),
    status: text('status').$type<JobStatus>().notNull(),
    attempts: integer('attempts').notNull().default(0),
    runAfter: ts('run_after').notNull(),
    lockedAt: ts('locked_at'),
    error: text('error'),
    /** Output of query jobs (e.g. a ticket's available transitions). */
    result: text('result', { mode: 'json' }).$type<unknown>(),
    createdAt: ts('created_at').notNull(),
    finishedAt: ts('finished_at'),
  },
  (t) => [index('jobs_status_run_after_idx').on(t.status, t.runAfter)],
);
