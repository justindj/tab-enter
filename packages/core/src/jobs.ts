import { z } from 'zod';

// The worker's job protocol: JSON jobs in, JSON events out. Keep every job
// serializable so a hosted version can hand jobs to a local runner unchanged.

export const JobSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('detect-tools') }),
  z.object({ type: z.literal('sync'), profileId: z.string() }),
  z.object({ type: z.literal('delete-profile-files'), profileId: z.string() }),
  /** Execute a queued agent_runs row (the row holds the prompt and preset). */
  z.object({ type: z.literal('agent-run'), profileId: z.string(), runId: z.string() }),
  /** Verify a ticket: walkthrough or test evidence, assessed, rendered as a slideshow. */
  z.object({
    type: z.literal('verify'),
    profileId: z.string(),
    /** The verification_artifacts row (status "running") this job fills in. */
    artifactId: z.string(),
    mode: z.enum(['auto', 'ui', 'backend']),
    /** Re-run the saved walkthrough instead of asking Claude for a new one. */
    rerun: z.boolean(),
  }),
  /**
   * Open Claude Code interactively in the user's terminal: resuming a run's
   * session, or fresh in the worktree for a ticket/MR.
   */
  z.object({
    type: z.literal('open-terminal'),
    profileId: z.string(),
    runId: z.string().optional(),
    target: z
      .object({
        issueKey: z.string().nullable(),
        mrKey: z.string().nullable(),
        projectId: z.string().nullable(),
      })
      .optional(),
  }),
]);

export type Job = z.infer<typeof JobSchema>;
export type JobType = Job['type'];
export type JobState = 'queued' | 'running' | 'done' | 'failed';
