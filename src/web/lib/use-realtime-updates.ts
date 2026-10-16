import { useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { toast } from 'sonner'
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

// Push-based counterpart to the periodic library sync: the Plex webhook
// (library.new) and missing-playlist-track auto-requests both broadcast
// here (see core/realtime/broker.ts) so an open tab picks up a newly
// confirmed request/recommendation or a freshly-synced library within
// seconds, instead of waiting on its next manual refetch. Deliberately
// coarse -- every event just invalidates the relevant query keys rather than
// patching specific rows, since the underlying data is cheap to refetch.
export function useRealtimeUpdates(): void {
  const queryClient = useQueryClient()
  const { data } = useSSE('/api/v1/realtime/events')

  useEffect(() => {
    if (!data) return
    const event = data as RealtimeEvent
    switch (event.type) {
      case 'library-updated':
        // A full library resync touches practically every page (dashboard
        // stats, library health/reconciliation, per-artist coverage badges,
        // requests, recommendations, playlists) -- rather than hand-maintain
        // an ever-growing list of query keys that's guaranteed to drift out
        // of sync as pages get added, invalidate everything. Only
        // currently-mounted/observed queries actually refetch; the rest
        // just get marked stale.
        queryClient.invalidateQueries()
        break
      case 'request-confirmed':
      case 'request-updated':
        queryClient.invalidateQueries({ queryKey: ['requests-mine'] })
        queryClient.invalidateQueries({ queryKey: ['requests-pending'] })
        break
      case 'recommendation-confirmed':
        queryClient.invalidateQueries({ queryKey: ['recommendations'] })
        break
      case 'playlist-generated':
        clearPlaylistGenerating(queryClient, event.playlistId)
        queryClient.invalidateQueries({ queryKey: ['playlists'] })
        queryClient.invalidateQueries({ queryKey: ['playlists', 'scheduler'] })
        if (event.status === 'error') {
          toast.error('Failed to start generation')
        }
        break
      case 'listening-updated':
        queryClient.invalidateQueries({ queryKey: ['dashboard-top-artists'] })
        queryClient.invalidateQueries({ queryKey: ['dashboard-recent-tracks'] })
        break
      case 'activity-updated':
        queryClient.invalidateQueries({ queryKey: ['dashboard-activity'] })
        break
      default:
        break
    }
  }, [data, queryClient])
}
