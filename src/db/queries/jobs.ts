import { and, count, desc, eq, gte, inArray, isNotNull } from 'drizzle-orm'
import type { JobRunRow, JobType, SourceResult } from '@/core/jobs/types'
import type { Database } from '@/db'
import { jobRuns, recommendations } from '@/db/schema'

export type ListJobsFilters = {
  type?: JobType
  status?: string
  limit?: number
  offset?: number
}

export async function listJobs(
  db: Database,
  filters: ListJobsFilters = {},
): Promise<{ items: JobRunRow[]; total: number }> {
  const limit = Math.min(filters.limit ?? 50, 100)
  const offset = filters.offset ?? 0

  const conditions = []
  if (filters.type) conditions.push(eq(jobRuns.type, filters.type))
  if (filters.status) conditions.push(eq(jobRuns.status, filters.status))

  const where = conditions.length > 0 ? and(...conditions) : undefined

  const [items, totalRows] = await Promise.all([
    db
      .select()
      .from(jobRuns)
      .where(where)
      .orderBy(desc(jobRuns.startedAt))
      .limit(limit)
      .offset(offset),
    db.select({ count: count() }).from(jobRuns).where(where),
  ])

  return {
    items: items as JobRunRow[],
    total: totalRows[0]?.count ?? 0,
  }
}

export async function getJobById(db: Database, id: number): Promise<JobRunRow | null> {
  const [row] = await db.select().from(jobRuns).where(eq(jobRuns.id, id)).limit(1)
  return (row as JobRunRow) ?? null
}

export type JobHealthStatus = 'ok' | 'warning' | 'failing' | 'never'

export type JobHealth = {
  status: JobHealthStatus
  running: boolean
  lastSuccessAt: string | null
  /** Set when the most recent finished run didn't succeed. */
  lastProblem: { at: string; error: string | null } | null
}

export type HealthSummary = {
  discovery: JobHealth & { nextRunAt: string | null }
  playlists: JobHealth & { recentRuns: number; recentFailures: number }
  librarySync: JobHealth
  /** Per-source outcome of the latest discovery run that recorded sources. */
  sources: {
    name: string
    ok: boolean
    error: string | null
    role: 'history' | 'candidates' | 'tracks'
    artists: number | null
  }[]
}

// Runs a restart cut off ('interrupted') say nothing about health, so they're
// skipped; 'stuck' (ran far past its normal time) counts as a warning.
const FINISHED_STATUSES = ['completed', 'failed', 'stuck']

async function jobHealth(db: Database, types: string[]): Promise<JobHealth> {
  const typeFilter = inArray(jobRuns.type, types)
  const [[lastFinished], [lastSuccess], [running]] = await Promise.all([
    db
      .select()
      .from(jobRuns)
      .where(and(typeFilter, inArray(jobRuns.status, FINISHED_STATUSES)))
      .orderBy(desc(jobRuns.startedAt))
      .limit(1),
    db
      .select({ completedAt: jobRuns.completedAt })
      .from(jobRuns)
      .where(and(typeFilter, eq(jobRuns.status, 'completed')))
      .orderBy(desc(jobRuns.completedAt))
      .limit(1),
    db
      .select({ id: jobRuns.id })
      .from(jobRuns)
      .where(and(typeFilter, eq(jobRuns.status, 'running')))
      .limit(1),
  ])
  const status: JobHealthStatus = !lastFinished
    ? 'never'
    : lastFinished.status === 'completed'
      ? 'ok'
      : lastFinished.status === 'failed'
        ? 'failing'
        : 'warning'
  return {
    status,
    running: !!running,
    lastSuccessAt: lastSuccess?.completedAt?.toISOString() ?? null,
    lastProblem:
      lastFinished && lastFinished.status !== 'completed'
        ? {
            at: (lastFinished.completedAt ?? lastFinished.startedAt).toISOString(),
            error:
              lastFinished.error ??
              (lastFinished.status === 'stuck' ? 'Ran much longer than usual.' : null),
          }
        : null,
  }
}

export async function getJobHealth(
  db: Database,
  nextPipelineRun: Date | null,
): Promise<HealthSummary> {
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000)

  const [discovery, playlists, librarySync, recentPlaylistRuns, [lastWithSources]] =
    await Promise.all([
      jobHealth(db, ['pipeline']),
      jobHealth(db, ['playlist']),
      jobHealth(db, ['library_sync']),
      db
        .select({ status: jobRuns.status, n: count() })
        .from(jobRuns)
        .where(
          and(
            eq(jobRuns.type, 'playlist'),
            gte(jobRuns.startedAt, since24h),
            inArray(jobRuns.status, FINISHED_STATUSES),
          ),
        )
        .groupBy(jobRuns.status),
      db
        .select({ sourceResults: jobRuns.sourceResults })
        .from(jobRuns)
        .where(
          and(
            inArray(jobRuns.type, ['pipeline', 'quick_discover']),
            isNotNull(jobRuns.sourceResults),
          ),
        )
        .orderBy(desc(jobRuns.startedAt))
        .limit(1),
    ])

  // Playlists run many times a day; one bad generation among dozens is a
  // warning, not "failing".
  const recentRuns = recentPlaylistRuns.reduce((n, r) => n + r.n, 0)
  const recentFailures = recentPlaylistRuns
    .filter((r) => r.status !== 'completed')
    .reduce((n, r) => n + r.n, 0)
  const playlistStatus: JobHealthStatus =
    recentRuns === 0
      ? playlists.status
      : recentFailures === 0
        ? 'ok'
        : recentFailures === recentRuns
          ? 'failing'
          : 'warning'

  const results = (lastWithSources?.sourceResults ?? {}) as Record<string, SourceResult>
  // 'skipped' = not configured for this run, so not worth showing.
  const sources = Object.entries(results)
    .filter(([, r]) => r.status !== 'skipped')
    .map(([name, r]) => {
      // Runs recorded before roles existed flagged Plex (history-only, never
      // a candidate source) as "No artists returned" -- that was never a fault.
      const legacyPlex = !r.role && name === 'plex'
      const ok = r.status === 'ok' || legacyPlex
      return {
        name,
        ok,
        error: ok ? null : (r.error ?? null),
        role: r.role ?? (name === 'plex' ? 'history' : 'candidates'),
        artists: legacyPlex ? null : (r.artists ?? null),
      }
    })

  return {
    discovery: { ...discovery, nextRunAt: nextPipelineRun?.toISOString() ?? null },
    playlists: { ...playlists, status: playlistStatus, recentRuns, recentFailures },
    librarySync,
    sources,
  }
}

export type DigestStats = {
  discovered: number
  added: number
  runs: number
}

/**
 * Aggregate notification-digest stats for the trailing window starting at
 * `since`. Derived from existing tables (no bookmark/migration):
 * - `discovered`: recommendations created in the window.
 * - `added`: recommendations approved or added to Lidarr in the window.
 * - `runs`: discovery job runs (pipeline/quick_discover) that
 *   completed in the window.
 */
export async function getDigestStats(db: Database, since: Date): Promise<DigestStats> {
  const [discoveredRows, addedRows, runRows] = await Promise.all([
    db
      .select({ count: count() })
      .from(recommendations)
      .where(gte(recommendations.createdAt, since)),
    db
      .select({ count: count() })
      .from(recommendations)
      .where(
        and(
          gte(recommendations.createdAt, since),
          inArray(recommendations.status, ['approved', 'added_to_lidarr']),
        ),
      ),
    db
      .select({ count: count() })
      .from(jobRuns)
      .where(
        and(
          eq(jobRuns.status, 'completed'),
          gte(jobRuns.startedAt, since),
          inArray(jobRuns.type, ['pipeline', 'quick_discover']),
        ),
      ),
  ])

  return {
    discovered: discoveredRows[0]?.count ?? 0,
    added: addedRows[0]?.count ?? 0,
    runs: runRows[0]?.count ?? 0,
  }
}
