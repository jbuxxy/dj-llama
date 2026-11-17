import { type QueryClient, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ActivityJob, ActivityKind } from '@/core/jobs/activity'

export type { ActivityJob, ActivityKind }

/**
 * Client mirror of the server's per-user activity feed (core/jobs/activity.ts).
 * Lives in the React Query cache -- populated by the realtime SSE channel's
 * `activity-snapshot` (on every connect) and `job` events -- so the header
 * indicator, Dashboard progress card, toasts and buttons all read one source
 * of truth without any polling.
 */
export const ACTIVITY_KEY = ['activity'] as const

export function useActivity(): ActivityJob[] {
  const queryClient = useQueryClient()
  const { data } = useQuery<ActivityJob[]>({
    queryKey: ACTIVITY_KEY,
    // Client-only state: a blanket invalidateQueries() (library-updated,
    // reconnect) must not "refetch" it back to empty.
    queryFn: () => queryClient.getQueryData<ActivityJob[]>(ACTIVITY_KEY) ?? [],
    initialData: [],
    staleTime: Number.POSITIVE_INFINITY,
  })
  return data
}

export function isActive(job: Pick<ActivityJob, 'status'>): boolean {
  return job.status === 'queued' || job.status === 'running'
}

/** The newest active job of a kind (optionally for one entity), if any. */
export function useActiveJob(kind: ActivityKind, ref?: string): ActivityJob | undefined {
  return useActivity().find(
    (j) => j.kind === kind && isActive(j) && (ref === undefined || j.ref === ref),
  )
}

export function applySnapshot(queryClient: QueryClient, jobs: ActivityJob[]): void {
  // Keep optimistic placeholders the server doesn't know about yet.
  queryClient.setQueryData<ActivityJob[]>(ACTIVITY_KEY, (old = []) => [
    ...jobs,
    ...old.filter((j) => j.id.startsWith(OPTIMISTIC_PREFIX) && isActive(j)),
  ])
}

/** Returns the previous version of this job (undefined if new). */
export function applyJob(queryClient: QueryClient, job: ActivityJob): ActivityJob | undefined {
  let previous: ActivityJob | undefined
  queryClient.setQueryData<ActivityJob[]>(ACTIVITY_KEY, (old = []) => {
    previous = old.find((j) => j.id === job.id)
    // A real job replaces the optimistic placeholder for the same kind/ref.
    const rest = old.filter(
      (j) =>
        j.id !== job.id &&
        !(
          j.id.startsWith(OPTIMISTIC_PREFIX) &&
          j.kind === job.kind &&
          (j.ref === undefined || j.ref === job.ref)
        ),
    )
    return [job, ...rest].slice(0, 30)
  })
  return previous
}

const OPTIMISTIC_PREFIX = 'optimistic:'
const OPTIMISTIC_TTL_MS = 15_000

/**
 * Show a job as started the instant the user clicks -- before the request
 * even returns -- so the UI never looks idle. Replaced by the real job event
 * (applyJob) or dropped after a short TTL / on failure.
 */
export function addOptimisticJob(
  queryClient: QueryClient,
  init: { kind: ActivityKind; label: string; ref?: string; message?: string },
): () => void {
  const id = `${OPTIMISTIC_PREFIX}${init.kind}:${init.ref ?? ''}:${Date.now()}`
  const now = new Date().toISOString()
  queryClient.setQueryData<ActivityJob[]>(ACTIVITY_KEY, (old = []) => [
    { ...init, id, status: 'running', startedAt: now, updatedAt: now },
    ...old,
  ])
  const remove = () =>
    queryClient.setQueryData<ActivityJob[]>(ACTIVITY_KEY, (old = []) =>
      old.filter((j) => j.id !== id),
    )
  setTimeout(remove, OPTIMISTIC_TTL_MS)
  return remove
}

// Jobs this tab kicked off (by kind + optional ref), so their progress gets a
// live toast while scheduled/background jobs stay quietly in the header.
const watched = new Map<string, number>()
const WATCH_WINDOW_MS = 30_000

function watchKey(kind: ActivityKind, ref?: string): string {
  return `${kind}:${ref ?? ''}`
}

export function watchJob(kind: ActivityKind, ref?: string): void {
  watched.set(watchKey(kind, ref), Date.now())
}

/** True if this job was started from this tab (consumes the watch on finish). */
export function isWatched(job: ActivityJob): boolean {
  const keys = [watchKey(job.kind, job.ref), watchKey(job.kind)]
  for (const key of keys) {
    const at = watched.get(key)
    if (at === undefined) continue
    // Once a job attaches it stays watched until it finishes.
    if (Date.now() - at > WATCH_WINDOW_MS && !watchedIds.has(job.id)) {
      watched.delete(key)
      continue
    }
    watchedIds.add(job.id)
    if (!isActive(job)) watched.delete(key)
    return true
  }
  return watchedIds.has(job.id)
}

const watchedIds = new Set<string>()
