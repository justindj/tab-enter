import { z } from 'zod';

// The worker's job protocol: JSON jobs in, JSON events out. Keep every job
// serializable so a hosted version can hand jobs to a local runner unchanged.

export const JobSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('detect-tools') }),
  z.object({ type: z.literal('sync'), profileId: z.string() }),
  z.object({ type: z.literal('delete-profile-files'), profileId: z.string() }),
]);

export type Job = z.infer<typeof JobSchema>;
export type JobType = Job['type'];
export type JobState = 'queued' | 'running' | 'done' | 'failed';
