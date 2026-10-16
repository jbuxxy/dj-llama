import { and, eq, lt, sql } from 'drizzle-orm'
import type { Database } from '@/db'
import { jobRuns } from '@/db/schema'
import type { CompleteJobParams, JobRecorder, StartJobParams } from './types'

const STUCK_THRESHOLDS_MS: Record<string, number> = {
  // A normal discovery run takes ~35 minutes on a real library.
  pipeline: 90 * 60 * 1000,
  quick_discover: 5 * 60 * 1000,
  target: 2 * 60 * 1000,
  // Generations run one at a time (see index.ts's executePlaylistGeneration)
  // and an import with many missing tracks waits on the Lidarr add throttle,
  // so a large playlist legitimately takes far longer than a few minutes.
  playlist: 60 * 60 * 1000,
  library_sync: 90 * 60 * 1000,
}

export function createJobRecorder(db: Database): JobRecorder {
  return {
    async start(params: StartJobParams): Promise<number> {
      const rows = await db
        .insert(jobRuns)
        .values({
          type: params.type,
          status: 'running',
          userId: params.userId ?? null,
          metadata: params.metadata ?? {},
        })
        .returning({ id: jobRuns.id })
      const row = rows[0]
      if (!row) throw new Error('insertJobRun: no row returned')
      return row.id
    },

    async complete(jobId: number, params?: CompleteJobParams): Promise<void> {
      const now = new Date()
      await db
        .update(jobRuns)
        .set({
          status: 'completed',
          completedAt: now,
          durationMs: sql<number>`ROUND(EXTRACT(EPOCH FROM (NOW() - ${jobRuns.startedAt})) * 1000)::integer`,
          ...(params?.metadata != null
            ? {
                metadata: sql`${jobRuns.metadata} || ${JSON.stringify(params.metadata)}::jsonb`,
              }
            : {}),
          ...(params?.sourceResults !== undefined
            ? { sourceResults: params.sourceResults as unknown }
            : {}),
          ...(params?.batchId !== undefined ? { batchId: params.batchId } : {}),
        })
        .where(eq(jobRuns.id, jobId))
    },

    async fail(jobId: number, error: string): Promise<void> {
      const MAX_ERROR_LENGTH = 2048
      const truncatedError =
        error.length > MAX_ERROR_LENGTH ? `${error.slice(0, MAX_ERROR_LENGTH)}...` : error
      const now = new Date()
      await db
        .update(jobRuns)
        .set({
          status: 'failed',
          completedAt: now,
          durationMs: sql<number>`ROUND(EXTRACT(EPOCH FROM (NOW() - ${jobRuns.startedAt})) * 1000)::integer`,
          error: truncatedError,
        })
        .where(eq(jobRuns.id, jobId))
    },

    async markInterrupted(): Promise<number> {
      // Only called at startup: nothing can be running in a process that just
      // started, so every 'running' row was cut off by the previous one exiting.
      const result = await db
        .update(jobRuns)
        .set({
          status: 'interrupted',
          completedAt: new Date(),
          error: 'DJ Llama restarted while this was running.',
        })
        .where(eq(jobRuns.status, 'running'))
        .returning({ id: jobRuns.id })
      return result.length
    },

    async markStuck(): Promise<number> {
      let totalMarked = 0
      for (const [type, thresholdMs] of Object.entries(STUCK_THRESHOLDS_MS)) {
        const cutoff = new Date(Date.now() - thresholdMs)
        try {
          const result = await db
            .update(jobRuns)
            .set({ status: 'stuck' })
            .where(
              and(
                eq(jobRuns.type, type),
                eq(jobRuns.status, 'running'),
                lt(jobRuns.startedAt, cutoff),
              ),
            )
            .returning({ id: jobRuns.id })
          if (result.length > 0) {
            console.warn(`[jobs] Marked ${result.length} stuck ${type} job(s)`)
            totalMarked += result.length
          }
        } catch (err) {
          console.error(`[jobs] Failed to mark stuck ${type} jobs:`, err)
        }
      }
      return totalMarked
    },
  }
}
