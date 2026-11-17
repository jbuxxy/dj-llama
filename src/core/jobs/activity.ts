import { randomUUID } from 'node:crypto'
import { realtimeBroker } from '@/core/realtime/broker'

/**
 * Live, per-user view of background work ("what is DJ Llama doing for me
 * right now?") pushed to the browser over the realtime SSE channel. This is
 * the UI-facing twin of JobRecorder: JobRecorder writes durable job_runs
 * history; this keeps a small in-memory list of active and just-finished
 * jobs so every page can show progress, queue position and a result link
 * without polling. Lost on restart by design -- job_runs is the record.
 */

export type ActivityKind =
  | 'pipeline'
  | 'quick_discover'
  | 'library_sync'
  | 'artist_rescan'
  | 'playlist'
  | 'lidarr_dispatch'
  | 'retry_failed'
  | 'bulk_action'
  | 'taste_profile'

export type ActivityStatus = 'queued' | 'running' | 'done' | 'error'

export type ActivityJob = {
  id: string
  kind: ActivityKind
  label: string
  status: ActivityStatus
  /** Short machine stage (pipeline: collect/analyze/...). */
  stage?: string
  /** Human progress line, e.g. "Looking up 12/40 tracks on MusicBrainz". */
  message?: string
  current?: number
  total?: number
  /** 1-based place in line while status === 'queued'. */
  queuePosition?: number
  startedAt: string
  updatedAt: string
  finishedAt?: string
  /** In-app link to the thing this job produced (e.g. /discover). */
  resultHref?: string
  /** One-line outcome shown when done, e.g. "Found 14 new picks". */
  resultSummary?: string
  /** Free-form key so callers can find "the" job for an entity (playlist id). */
  ref?: string
}

export type ActivityPatch = Partial<Omit<ActivityJob, 'id' | 'kind' | 'startedAt' | 'updatedAt'>>

export type ActivityHandle = {
  readonly id: string
  update(patch: ActivityPatch): void
  done(patch?: ActivityPatch): void
  fail(message: string, patch?: ActivityPatch): void
}

/** How long a finished job stays in the snapshot (so a reconnecting tab sees it). */
const FINISHED_TTL_MS = 10 * 60 * 1000
const MAX_FINISHED_PER_USER = 15
/** An active job with no update for this long is presumed dead. */
const STALE_ACTIVE_MS = 2 * 60 * 60 * 1000
/** Coalesce rapid-fire progress updates (pipeline emits per item) to ~4/s. */
const PUBLISH_THROTTLE_MS = 250

type Entry = {
  job: ActivityJob
  lastPublish: number
  pending: ReturnType<typeof setTimeout> | null
}

export class ActivityTracker {
  private readonly byUser = new Map<number, Map<string, Entry>>()

  constructor(
    private readonly publish: (userId: number, job: ActivityJob) => void = (userId, job) =>
      realtimeBroker.publish(userId, { type: 'job', job }),
    private readonly now: () => number = Date.now,
  ) {}

  start(
    userId: number,
    init: { kind: ActivityKind; label: string } & ActivityPatch,
  ): ActivityHandle {
    const iso = new Date(this.now()).toISOString()
    const job: ActivityJob = {
      status: 'running',
      ...init,
      id: randomUUID(),
      startedAt: iso,
      updatedAt: iso,
    }
    const entry: Entry = { job, lastPublish: 0, pending: null }
    this.jobsFor(userId).set(job.id, entry)
    this.flush(userId, entry)
    return this.handle(userId, job.id)
  }

  /** The active (queued/running) job of this kind+ref, if any. */
  findActive(userId: number, kind: ActivityKind, ref?: string): ActivityHandle | null {
    for (const entry of this.byUser.get(userId)?.values() ?? []) {
      const { job } = entry
      if (job.kind !== kind || (ref !== undefined && job.ref !== ref)) continue
      if (job.status === 'queued' || job.status === 'running') return this.handle(userId, job.id)
    }
    return null
  }

  /** Active jobs plus recently finished ones, newest first. */
  list(userId: number): ActivityJob[] {
    this.prune(userId)
    return [...(this.byUser.get(userId)?.values() ?? [])]
      .map((e) => e.job)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  }

  private handle(userId: number, id: string): ActivityHandle {
    return {
      id,
      update: (patch) => this.patch(userId, id, patch, false),
      done: (patch) =>
        this.patch(userId, id, { ...patch, status: 'done', queuePosition: undefined }, true),
      fail: (message, patch) =>
        this.patch(
          userId,
          id,
          { ...patch, status: 'error', message, queuePosition: undefined },
          true,
        ),
    }
  }

  private patch(userId: number, id: string, patch: ActivityPatch, final: boolean): void {
    const entry = this.byUser.get(userId)?.get(id)
    if (!entry) return
    // A finished job is immutable -- late progress from a stray callback
    // mustn't flip it back to running.
    if (entry.job.status === 'done' || entry.job.status === 'error') return
    const nowMs = this.now()
    entry.job = { ...entry.job, ...patch, updatedAt: new Date(nowMs).toISOString() }
    if (final) entry.job.finishedAt = entry.job.updatedAt
    const statusChanged = patch.status !== undefined
    if (final || statusChanged || nowMs - entry.lastPublish >= PUBLISH_THROTTLE_MS) {
      this.flush(userId, entry)
    } else if (!entry.pending) {
      entry.pending = setTimeout(
        () => this.flush(userId, entry),
        PUBLISH_THROTTLE_MS - (nowMs - entry.lastPublish),
      )
      entry.pending.unref?.()
    }
    if (final) this.prune(userId)
  }

  private flush(userId: number, entry: Entry): void {
    if (entry.pending) clearTimeout(entry.pending)
    entry.pending = null
    entry.lastPublish = this.now()
    try {
      this.publish(userId, entry.job)
    } catch (err) {
      console.warn('[activity] publish failed:', err)
    }
  }

  private jobsFor(userId: number): Map<string, Entry> {
    let jobs = this.byUser.get(userId)
    if (!jobs) {
      jobs = new Map()
      this.byUser.set(userId, jobs)
    }
    return jobs
  }

  private prune(userId: number): void {
    const jobs = this.byUser.get(userId)
    if (!jobs) return
    const nowMs = this.now()
    // Safety net: a job whose owner crashed without calling done/fail must
    // not spin in the header forever.
    for (const e of jobs.values()) {
      if (e.job.finishedAt) continue
      if (nowMs - Date.parse(e.job.updatedAt) > STALE_ACTIVE_MS) {
        const iso = new Date(nowMs).toISOString()
        e.job = {
          ...e.job,
          status: 'error',
          message: 'Stopped reporting progress',
          updatedAt: iso,
          finishedAt: iso,
        }
      }
    }
    const cutoff = nowMs - FINISHED_TTL_MS
    const finished = [...jobs.values()].filter((e) => e.job.finishedAt)
    finished.sort((a, b) => (b.job.finishedAt ?? '').localeCompare(a.job.finishedAt ?? ''))
    finished.forEach((e, i) => {
      if (i >= MAX_FINISHED_PER_USER || Date.parse(e.job.finishedAt ?? '') < cutoff) {
        jobs.delete(e.job.id)
      }
    })
    if (jobs.size === 0) this.byUser.delete(userId)
  }
}

export const activityTracker = new ActivityTracker()

/**
 * Run `work` as a tracked activity: marks it done with whatever summary the
 * work returns, or failed with the error message, and rethrows so callers'
 * own error handling is unchanged.
 */
export async function trackActivity<T>(
  userId: number | undefined,
  init: { kind: ActivityKind; label: string } & ActivityPatch,
  work: (job: ActivityHandle | null) => Promise<T>,
  summarize?: (result: T) => ActivityPatch | undefined,
): Promise<T> {
  if (userId == null) return work(null)
  const job = activityTracker.start(userId, init)
  try {
    const result = await work(job)
    job.done(summarize?.(result))
    return result
  } catch (err) {
    job.fail(err instanceof Error ? err.message : String(err))
    throw err
  }
}
