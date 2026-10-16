import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { useCallback, useRef, useState } from 'react'
import { toast } from 'sonner'
import { HealthCheckCard } from '../components/health-check-card'
import { LibraryFirstSyncBanner } from '../components/library-first-sync-banner'
import { LibrarySourcesPanel } from '../components/library-sources-panel'
import { LibraryStatsDisplay } from '../components/library-stats'
import { Skeleton } from '../components/ui/skeleton'
import {
  fixHealthCheck,
  getLibraryHealth,
  getLibraryStats,
  getSettings,
  type HealthCheckResult,
  type LibraryStats,
  scanLibraryHealth,
  triggerLibrarySync,
} from '../lib/api'
import { formatRelativeTime } from '../lib/format-time'
import { LibraryReconciliationPage } from './library-reconciliation'

// Checks where the fix is a Lidarr background task (refresh/search),
// not an immediate DB write. These need longer delay before rescan.
const DEFERRED_FIXES = new Set(['genre-gaps', 'missing-albums'])

const RESCAN_DELAY_DEFERRED = 30_000
const RESCAN_DELAY_IMMEDIATE = 5_000

function ChecksSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      {[1, 2, 3, 4].map((i) => (
        <div key={i} className="bg-surface border border-border rounded-lg p-4 space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1.5 flex-1">
              <Skeleton className="h-4 w-36" />
              <Skeleton className="h-3 w-52" />
            </div>
            <Skeleton className="h-5 w-8 rounded-full shrink-0" />
          </div>
          <Skeleton className="h-20 w-full" />
        </div>
      ))}
    </div>
  )
}

function StatsSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="bg-surface border border-border rounded-lg p-4 space-y-2">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-8 w-24" />
          </div>
        ))}
      </div>
      <Skeleton className="h-48 w-full" />
    </div>
  )
}

export function LibraryHealthPage({ embedded = false }: { embedded?: boolean }) {
  const queryClient = useQueryClient()
  const [fixingIds, setFixingIds] = useState<Set<string>>(new Set())
  const rescanTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const healthQuery = useQuery({
    queryKey: ['library', 'health'],
    queryFn: getLibraryHealth,
    refetchInterval: (query) => (query.state.data?.scanning ? 3000 : false),
  })

  const statsQuery = useQuery({
    queryKey: ['library', 'stats'],
    queryFn: getLibraryStats,
  })

  const settingsQuery = useQuery({ queryKey: ['settings'], queryFn: getSettings })

  const rescanMutation = useMutation({
    mutationFn: scanLibraryHealth,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['library', 'health'] }),
  })

  const syncMutation = useMutation({
    mutationFn: async () => {
      await Promise.all([triggerLibrarySync(), scanLibraryHealth()])
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['library', 'health'] })
      queryClient.invalidateQueries({ queryKey: ['library', 'sources'] })
    },
    onError: (err: Error) => toast.error(`Sync failed: ${err.message}`),
  })

  const scheduleRescan = useCallback(
    (delayMs: number) => {
      if (rescanTimer.current) clearTimeout(rescanTimer.current)
      rescanTimer.current = setTimeout(() => {
        rescanMutation.mutate()
        rescanTimer.current = null
      }, delayMs)
    },
    [rescanMutation],
  )

  const artistLabel = useCallback((count: number) => (count === 1 ? 'artist' : 'artists'), [])

  const handleFix = useCallback(
    async (checkId: string) => {
      setFixingIds((prev) => new Set(prev).add(checkId))
      try {
        const data = await fixHealthCheck(checkId)
        const isDeferred = DEFERRED_FIXES.has(checkId)

        if (data.failed === 0) {
          if (isDeferred) {
            toast.success(
              `Triggered action for ${data.completed} ${artistLabel(data.completed)} - re-scanning in 30s to verify`,
            )
          } else {
            toast.success(`Updated ${data.completed} ${artistLabel(data.completed)}`)
          }
        } else {
          toast.warning(`Processed: ${data.completed} • Failed: ${data.failed}/${data.total}`, {
            description: data.errors.slice(0, 3).join('; '),
          })
        }

        queryClient.invalidateQueries({ queryKey: ['library', 'health'] })
        scheduleRescan(isDeferred ? RESCAN_DELAY_DEFERRED : RESCAN_DELAY_IMMEDIATE)
      } catch {
        toast.error('Fix failed - check Lidarr connection')
      } finally {
        setFixingIds((prev) => {
          const next = new Set(prev)
          next.delete(checkId)
          return next
        })
      }
    },
    [artistLabel, queryClient, scheduleRescan],
  )

  const scanning = healthQuery.data?.scanning ?? false
  const checks: HealthCheckResult[] = healthQuery.data?.checks ?? []
  const lastCompletedAt = healthQuery.data?.lastCompletedAt ?? null
  const syncIntervalHours = healthQuery.data?.syncIntervalHours ?? 6
  const stats: LibraryStats | undefined = statsQuery.data
  const prefs = (settingsQuery.data?.preferences ?? {}) as Record<string, unknown>
  const lidarrBaseUrl =
    (prefs.lidarrPublicUrl as string) || (settingsQuery.data?.lidarrUrl as string) || null
  const pendingRescan = rescanTimer.current !== null

  return (
    <div className={embedded ? 'space-y-8' : 'p-6 space-y-8 max-w-6xl mx-auto'}>
      <h1 className={embedded ? 'sr-only' : 'text-2xl font-display tracking-wide text-text'}>
        Library Health
      </h1>

      <LibraryFirstSyncBanner />

      {/* One button syncs every library source and re-runs the checks; both
          also run on their own every syncIntervalHours. */}
      <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface px-4 py-3">
        <div className="min-w-0 text-sm">
          <div className="text-text">
            {scanning
              ? 'Checking your library...'
              : pendingRescan
                ? 'Re-checking shortly to confirm the fix...'
                : lastCompletedAt
                  ? `Checked ${formatRelativeTime(lastCompletedAt)}`
                  : 'Not checked yet'}
          </div>
          <div className="text-xs text-muted">{`Syncs and checks every ${syncIntervalHours}h`}</div>
        </div>
        <button
          type="button"
          onClick={() => syncMutation.mutate()}
          disabled={scanning || syncMutation.isPending}
          className="flex shrink-0 items-center gap-2 px-3 py-1.5 bg-accent text-accent-fg rounded-md text-sm font-medium hover:opacity-90 disabled:opacity-50 transition-opacity"
        >
          <RefreshCw size={14} className={scanning ? 'animate-spin' : undefined} />
          {scanning ? 'Syncing...' : 'Sync now'}
        </button>
      </div>

      {/* Health checks */}
      <div className="space-y-3">
        {healthQuery.isLoading ? (
          <ChecksSkeleton />
        ) : checks.length === 0 && !scanning ? (
          <div className="bg-surface border border-border rounded-lg px-4 py-8 text-center text-muted text-sm">
            {lastCompletedAt ? 'No problems found.' : 'Tap Sync now to check your library.'}
          </div>
        ) : checks.length > 0 ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {checks.map((check) => (
              <HealthCheckCard
                key={check.id}
                check={check}
                onFix={handleFix}
                fixing={fixingIds.has(check.id)}
                lidarrBaseUrl={lidarrBaseUrl}
              />
            ))}
          </div>
        ) : null}
      </div>

      {/* Library sources */}
      <LibrarySourcesPanel />

      {/* Formerly its own Settings section; the unmatched counts above point here. */}
      <LibraryReconciliationPage embedded />

      {/* Divider */}
      <hr className="border-border" />

      {/* Library stats */}
      <div className="space-y-4">
        <h2 className="text-sm font-semibold text-text uppercase tracking-wide">
          Library Statistics
        </h2>
        {statsQuery.isLoading ? (
          <StatsSkeleton />
        ) : stats ? (
          <LibraryStatsDisplay stats={stats} />
        ) : (
          <div className="bg-surface border border-border rounded-lg px-4 py-8 text-center text-muted text-sm">
            Library statistics unavailable. Check your Lidarr connection in Settings.
          </div>
        )}
      </div>
    </div>
  )
}
