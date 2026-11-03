import { z } from 'zod';
import { DEFAULT_MESSAGE_TEMPLATES } from './messages';
import { DEFAULT_TEMPLATES } from './templates';

// Per-profile settings. Secrets are never stored here: only the *names* of
// keychain entries live on the profile row (see packages/secrets).

export const DEFAULT_KEY_REGEX = '[A-Z][A-Z0-9]+-\\d+';

export const PresetIdSchema = z.enum([
  'work-ticket',
  'address-feedback',
  'code-review',
  'verification-script',
  'short-text',
]);
export type PresetId = z.infer<typeof PresetIdSchema>;

export const TaskPresetSchema = z.object({
  label: z.string(),
  /** Model alias (sonnet, haiku, opus). The model actually used is recorded from the run result. */
  model: z.string(),
  allowedTools: z.array(z.string()),
  disallowedTools: z.array(z.string()),
  /**
   * Claude Code 2.1.309 lists acceptEdits, auto, bypassPermissions, manual, dontAsk, plan.
   * bypassPermissions and auto are never offered. "default" (stored by M0) means dontAsk.
   */
  permissionMode: z.preprocess(
    (v) => (v === 'default' ? 'dontAsk' : v),
    z.enum(['acceptEdits', 'dontAsk', 'plan']),
  ),
  maxTurns: z.number().int().positive(),
  /** task = streamed, edits files; analysis = single JSON result, read-only or minimal tools. */
  mode: z.enum(['task', 'analysis']),
});
export type TaskPreset = z.infer<typeof TaskPresetSchema>;

// Test, lint and build commands only. Claude may commit locally; it may never push.
const SCOPED_BASH = [
  'Bash(npm test:*)',
  'Bash(npm run test:*)',
  'Bash(npm run lint:*)',
  'Bash(npm run build:*)',
  'Bash(npm run typecheck:*)',
  'Bash(pnpm test:*)',
  'Bash(pnpm lint:*)',
  'Bash(pnpm build:*)',
  'Bash(pnpm typecheck:*)',
  'Bash(yarn test:*)',
  'Bash(git status:*)',
  'Bash(git diff:*)',
  'Bash(git log:*)',
  'Bash(git add:*)',
  'Bash(git commit:*)',
];
const EDIT_TOOLS = ['Read', 'Edit', 'Write', 'Grep', 'Glob'];

export const DEFAULT_PRESETS: Record<PresetId, TaskPreset> = {
  'work-ticket': {
    label: 'Work a ticket',
    model: 'sonnet',
    allowedTools: [...EDIT_TOOLS, ...SCOPED_BASH],
    disallowedTools: [],
    permissionMode: 'acceptEdits',
    maxTurns: 50,
    mode: 'task',
  },
  'address-feedback': {
    label: 'Address MR feedback / fix pipeline',
    model: 'sonnet',
    allowedTools: [...EDIT_TOOLS, ...SCOPED_BASH],
    disallowedTools: [],
    permissionMode: 'acceptEdits',
    maxTurns: 30,
    mode: 'task',
  },
  'code-review': {
    label: 'Code review',
    model: 'sonnet',
    allowedTools: ['Read', 'Grep', 'Glob'],
    disallowedTools: ['Edit', 'Write', 'NotebookEdit', 'Bash'],
    permissionMode: 'dontAsk',
    maxTurns: 15,
    mode: 'analysis',
  },
  'verification-script': {
    label: 'Verification script',
    model: 'sonnet',
    // Claude only reads the code and replies with JSON walkthrough steps;
    // tab-enter's own Playwright runner executes them (see docs/decisions.md).
    allowedTools: ['Read', 'Grep', 'Glob'],
    disallowedTools: ['Edit', 'Write', 'NotebookEdit', 'Bash'],
    permissionMode: 'dontAsk',
    maxTurns: 20,
    mode: 'analysis',
  },
  'short-text': {
    label: 'Short text (captions, polish, summaries)',
    model: 'haiku',
    allowedTools: [],
    disallowedTools: ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash', 'WebFetch', 'WebSearch'],
    permissionMode: 'dontAsk',
    maxTurns: 1,
    mode: 'analysis',
  },
};

const VerificationProjectSchema = z.object({
  /** Run in the worktree to start the app (e.g. "pnpm dev"); omit when baseUrl is already up. */
  startCommand: z.string().optional(),
  /** The test or local URL walkthroughs may visit. Nothing outside its origin is opened. */
  baseUrl: z.string().optional(),
  /** Name of a keychain entry holding test-user credentials. Never the credentials themselves. */
  testCredentialsSecret: z.string().optional(),
  /**
   * The repo's own Playwright tests for UI tickets, e.g. "npx playwright test e2e/login.spec.ts".
   * When set it replaces the Claude-written walkthrough (no AI cost).
   */
  specCommand: z.string().optional(),
  /** Backend files → UI pages to smoke-check, one "glob => /path" per line. */
  uiPages: z.string().optional(),
});

export const WatchedProjectSchema = z.object({
  /** GitLab numeric project id or url-encoded path. */
  id: z.string(),
  path: z.string(),
  localPath: z.string().optional(),
  verification: VerificationProjectSchema.prefault({}),
});
export type WatchedProject = z.infer<typeof WatchedProjectSchema>;

export const DailyReportWindowSchema = z.object({
  mode: z.enum(['last24h', 'sinceLastReport', 'sinceDate', 'customHours']).default('last24h'),
  customHours: z.number().positive().optional(),
  sinceDate: z.string().optional(),
  mondayCoversWeekend: z.boolean().default(true),
});

export const ProfileSettingsSchema = z.object({
  jira: z
    .object({
      deployment: z.enum(['cloud', 'datacenter']).default('cloud'),
      baseUrl: z.string().default(''),
      /** Jira Cloud only: account email used with the API token. */
      email: z.string().default(''),
      /** Optional board id; when unset "current sprint" means `sprint in openSprints()`. */
      boardId: z.string().optional(),
      sprintOnlyDefault: z.boolean().default(true),
      doneStatuses: z.array(z.string()).default([]),
      blockedStatuses: z.array(z.string()).default(['Blocked']),
      /** Entered by the user (YYYY-MM-DD): Jira's API doesn't report token expiry. */
      tokenExpiresAt: z.string().optional(),
    })
    .prefault({}),
  gitlab: z
    .object({
      baseUrl: z.string().default('https://gitlab.com'),
      projects: z.array(WatchedProjectSchema).default([]),
    })
    .prefault({}),
  keyRegex: z.string().default(DEFAULT_KEY_REGEX),
  claude: z
    .object({
      approvedForClient: z.boolean().default(false),
      maxParallelRuns: z.number().int().min(1).max(8).default(2),
      presets: z.record(PresetIdSchema, TaskPresetSchema).default(DEFAULT_PRESETS),
      softLimits: z
        .object({
          perRunUsd: z.number().positive().optional(),
          perDayUsd: z.number().positive().optional(),
        })
        .prefault({}),
    })
    .prefault({}),
  rtk: z
    .object({
      mode: z.enum(['off', 'global', 'per-run']).default('off'),
      // Each of these can send client content to another service. Off unless explicitly opted in.
      routing: z.boolean().default(false),
      proxy: z.boolean().default(false),
      telemetry: z.boolean().default(false),
    })
    .prefault({}),
  timeWindows: z
    .object({
      dailyReport: DailyReportWindowSchema.prefault({}),
      recentRetentionDays: z.number().positive().default(3),
      staleReviewHours: z.number().positive().default(24),
    })
    .prefault({}),
  contextCaps: z
    .object({
      descriptionChars: z.number().int().positive().default(4000),
      commentsCount: z.number().int().nonnegative().default(5),
      jobLogTailLines: z.number().int().positive().default(120),
      diffChars: z.number().int().positive().default(60000),
    })
    .prefault({}),
  promptTemplates: z
    .object({
      'next-ticket': z.string().default(DEFAULT_TEMPLATES['next-ticket']),
      'address-feedback': z.string().default(DEFAULT_TEMPLATES['address-feedback']),
      'fix-pipeline': z.string().default(DEFAULT_TEMPLATES['fix-pipeline']),
      'resolve-conflicts': z.string().default(DEFAULT_TEMPLATES['resolve-conflicts']),
      review: z.string().default(DEFAULT_TEMPLATES.review),
    })
    .prefault({}),
  messageTemplates: z
    .object({
      'daily-report': z.string().default(DEFAULT_MESSAGE_TEMPLATES['daily-report']),
      'review-request': z.string().default(DEFAULT_MESSAGE_TEMPLATES['review-request']),
    })
    .prefault({}),
  reviewExcludeGlobs: z
    .array(z.string())
    .default([
      '**/pnpm-lock.yaml',
      '**/package-lock.json',
      '**/yarn.lock',
      '**/*.snap',
      '**/vendor/**',
      '**/dist/**',
      '**/*.min.js',
      '**/*.generated.*',
    ]),
  verification: z
    .object({
      captureVideo: z.boolean().default(false),
      /** Also run the walkthrough on the target branch (needs a start command) for "before" shots. */
      captureBefore: z.boolean().default(false),
    })
    .prefault({}),
  // Every write action is off by default and still needs a confirmation click when on.
  writeActions: z
    .object({
      jiraTransition: z.boolean().default(false),
      jiraComment: z.boolean().default(false),
      gitlabComment: z.boolean().default(false),
      gitlabApprove: z.boolean().default(false),
      gitPush: z.boolean().default(false),
      openMergeRequest: z.boolean().default(false),
    })
    .prefault({}),
  syncIntervalMinutes: z.number().int().min(1).default(5),
});

export type ProfileSettings = z.infer<typeof ProfileSettingsSchema>;

export function defaultProfileSettings(): ProfileSettings {
  return ProfileSettingsSchema.parse({});
}

/**
 * Watched projects as edited in Settings: one per line, a GitLab path or numeric
 * id, optionally followed by "=" and the local clone path.
 */
export function parseWatchedProjects(text: string): WatchedProject[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const eq = line.indexOf('=');
      const project = (eq < 0 ? line : line.slice(0, eq)).trim().replace(/^\/+|\/+$/g, '');
      const localPath = eq < 0 ? '' : line.slice(eq + 1).trim();
      return WatchedProjectSchema.parse({
        // A path works as an id too: GitLab accepts the URL-encoded path.
        id: project,
        path: /^\d+$/.test(project) ? '' : project,
        ...(localPath ? { localPath } : {}),
      });
    });
}

export function formatWatchedProjects(projects: WatchedProject[]): string {
  return projects
    .map((p) => `${p.path || p.id}${p.localPath ? ` = ${p.localPath}` : ''}`)
    .join('\n');
}

/** Parse stored settings, filling in defaults for fields added since they were saved. */
export function parseProfileSettings(raw: unknown): ProfileSettings {
  const settings = ProfileSettingsSchema.parse(raw ?? {});
  // M3–M5 stored a verification preset that let Claude write files and run
  // Playwright; since M6 Claude only returns JSON steps. Upgrade that old default.
  const verify = settings.claude.presets['verification-script'];
  if (verify.allowedTools.includes('Bash(npx playwright:*)')) {
    settings.claude.presets['verification-script'] = DEFAULT_PRESETS['verification-script'];
  }
  return settings;
}
