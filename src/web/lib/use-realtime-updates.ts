import { type QueryClient, useQueryClient } from '@tanstack/react-query'
import { useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { queryKeys } from '@/web/lib/query-keys'
import { type ActivityJob, applyJob, applySnapshot, isActive, isWatched } from './activity'
import { clearPlaylistGenerating } from './generating-playlists'
import { useSSE } from './hooks'

type RealtimeEvent =
  | { type: 'library-updated' }
  | { type: 'request-confirmed'; requestId: number }
  | { type: 'recommendation-confirmed'; recommendationId: number }
  | { type: 'request-updated'; requestId: number }
  | { type: 'playlist-generated'; playlistId: number; status: 'success' | 'error' }
  | { type: 'listening-updated' }
  | { type: 'activity-updated' }
  | { type: 'job'; job: ActivityJob }
  | { type: 'activity-snapshot'; jobs: ActivityJob[] }

// What each kind of finished job should refresh. Replaces the old
// "toast says check the Dashboard" + blind setTimeout refetches: the page
// you're on updates itself the moment the work actually lands.
function invalidateForFinishedJob(queryClient: QueryClient, job: ActivityJob): void {
  switch (job.kind) {
    case 'pipeline':
    case 'quick_discover':
    case 'artist_rescan':
      queryClient.invalidateQueries({ queryKey: queryKeys.recommendations.all })
      queryClient.invalidateQueries({ queryKey: queryKeys.dashboard.activity })
      queryClient.invalidateQueries({ queryKey: ['pipelineStatus'] })
      break
    case 'library_sync':
      queryClient.invalidateQueries()
      break
    case 'playlist':
      queryClient.invalidateQueries({ queryKey: ['playlists'] })
      if (job.ref) clearPlaylistGenerating(queryClient, Number(job.ref))
      break
    case 'lidarr_dispatch':
    case 'retry_failed':
    case 'bulk_action':
      queryClient.invalidateQueries({ queryKey: queryKeys.recommendations.all })
      queryClient.invalidateQueries({ queryKey: queryKeys.requests.all })
      queryClient.invalidateQueries({ queryKey: queryKeys.dashboard.activity })
      break
    case 'taste_profile':
      queryClient.invalidateQueries({ queryKey: queryKeys.dashboard.taste })
      break
  }
}

function progressText(job: ActivityJob): string | undefined {
  const count =
    job.current !== undefined && job.total !== undefined && job.total > 0
      ? `${job.current}/${job.total}`
      : undefined
  if (job.status === 'queued') {
    return job.queuePosition ? `Queued - #${job.queuePosition} in line` : 'Queued'
  }
  return [job.message, count].filter(Boolean).join(' · ') || undefined
}

// Push-based counterpart to periodic refetching: the server publishes here
// (see core/realtime/broker.ts) and every event invalidates the relevant
// query keys -- deliberately coarse, since the data is cheap to refetch.
export function useRealtimeUpdates(): void {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const navigateRef = useRef(navigate)
  navigateRef.current = navigate

  const onJob = useCallback(
    (job: ActivityJob) => {
      const previous = applyJob(queryClient, job)
      const finishedNow = !isActive(job) && (previous === undefined || isActive(previous))
      if (finishedNow) invalidateForFinishedJob(queryClient, job)
      if (job.kind === 'pipeline') {
        queryClient.invalidateQueries({ queryKey: ['pipelineStatus'] })
      }

      // Live toast only for work this tab started; background/scheduled
      // jobs stay in the header Activity Center without interrupting.
      if (!isWatched(job)) return
      const toastId = `job:${job.kind}:${job.ref ?? job.id}`
      if (job.status === 'done') {
        const href = job.resultHref
        toast.success(job.resultSummary ?? `${job.label} finished`, {
          id: toastId,
          description: job.label,
          duration: 8000,
          action: href ? { label: 'View', onClick: () => navigateRef.current(href) } : undefined,
        })
      } else if (job.status === 'error') {
        toast.error(`${job.label} failed`, {
          id: toastId,
          description: job.message,
          duration: 10000,
        })
      } else {
        toast.loading(job.label, {
          id: toastId,
          description: progressText(job),
          duration: Number.POSITIVE_INFINITY,
        })
      }
    },
    [queryClient],
  )

  const onMessage = useCallback(
    (data: unknown) => {
      const event = data as RealtimeEvent
      switch (event.type) {
        case 'job':
          onJob(event.job)
          break
        case 'activity-snapshot':
          applySnapshot(queryClient, event.jobs)
          break
        case 'library-updated':
          // A full library resync touches practically every page -- rather
          // than hand-maintain a list of keys that will drift, invalidate
          // everything. Only mounted queries actually refetch.
          queryClient.invalidateQueries()
          break
        case 'request-confirmed':
        case 'request-updated':
          queryClient.invalidateQueries({ queryKey: queryKeys.requests.all })
          // Auto-dispatched requests show up in the Dashboard activity feed too.
          queryClient.invalidateQueries({ queryKey: queryKeys.dashboard.activity })
          break
        case 'recommendation-confirmed':
          queryClient.invalidateQueries({ queryKey: queryKeys.recommendations.all })
          break
        case 'playlist-generated':
          clearPlaylistGenerating(queryClient, event.playlistId)
          queryClient.invalidateQueries({ queryKey: ['playlists'] })
          break
        case 'listening-updated':
          queryClient.invalidateQueries({ queryKey: queryKeys.dashboard.listening })
          break
        case 'activity-updated':
          queryClient.invalidateQueries({ queryKey: queryKeys.dashboard.activity })
          break
        default:
          break
      }
    },
    [queryClient, onJob],
  )

  // Events published while the stream was down are gone -- refetch whatever
  // is on screen so a sleeping phone / flaky Wi-Fi never leaves stale data.
  // (The fresh connection's activity-snapshot restores job state itself.)
  const onReconnect = useCallback(() => {
    queryClient.invalidateQueries({ refetchType: 'active' })
  }, [queryClient])

  useSSE('/api/v1/realtime/events', { onMessage, onReconnect })
}
