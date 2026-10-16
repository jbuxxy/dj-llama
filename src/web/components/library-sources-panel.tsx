import { useQuery } from '@tanstack/react-query'
import { AlertTriangle } from 'lucide-react'
import { getLibrarySources } from '../lib/api'
import { formatRelativeTime } from '../lib/format-time'

function statusColor(status: string | null): string {
  if (status === 'completed') return 'text-green-500'
  if (status === 'failed') return 'text-red-500'
  if (status === 'running') return 'text-amber-500'
  return 'text-muted'
}

// Read-only status per source. Syncing is started from the page's single
// "Sync now" button (library-health.tsx), which syncs every source.
export function LibrarySourcesPanel() {
  const sourcesQuery = useQuery({
    queryKey: ['library', 'sources'],
    queryFn: getLibrarySources,
    refetchInterval: (query) =>
      query.state.data?.sources?.some((s) => s.lastSyncStatus === 'running') ? 5000 : false,
  })

  const sources = sourcesQuery.data?.sources ?? []

  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold text-text uppercase tracking-wide">Library Sources</h2>

      {sources.length === 0 ? (
        <div className="bg-surface border border-border rounded-lg px-4 py-8 text-center text-muted text-sm">
          No library sources configured. Add Lidarr or Plex in Settings.
        </div>
      ) : (
        <div className="bg-surface border border-border rounded-lg divide-y divide-border">
          {sources.map((row) => {
            const counts = row.lastSyncCounts
            const unmatched =
              counts != null
                ? (counts.unreconciledAmbiguous ?? 0) + (counts.unreconciledNoCandidate ?? 0)
                : null

            return (
              <div key={`${row.source}-${row.userId ?? 'global'}`} className="px-4 py-3 space-y-1">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-medium text-text capitalize">{row.source}</span>
                  <span className={`text-xs ${statusColor(row.lastSyncStatus)}`}>
                    {row.lastSyncStatus === 'completed' && row.lastSyncCompletedAt
                      ? `Synced ${formatRelativeTime(row.lastSyncCompletedAt)}`
                      : (row.lastSyncStatus ?? 'Never synced')}
                  </span>
                </div>

                {counts != null && (
                  <div className="text-xs text-muted">
                    {`${counts.total.toLocaleString()} artists`}
                    {typeof counts.albumsSynced === 'number'
                      ? ` · ${counts.albumsSynced.toLocaleString()} albums`
                      : ''}
                    {unmatched ? ` · ${unmatched} unmatched (listed below)` : ''}
                  </div>
                )}

                {typeof counts?.mbApiCallsFailed === 'number' && counts.mbApiCallsFailed > 0 && (
                  <div
                    className="flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400"
                    data-testid={`mb-warning-${row.source}`}
                  >
                    <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                    <span>
                      {`${counts.mbApiCallsFailed} MusicBrainz lookups failed. Affected artists are left unmatched and will retry next sync.`}
                    </span>
                  </div>
                )}

                {row.lastSyncError && (
                  <div className="text-xs text-red-500">{row.lastSyncError}</div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
