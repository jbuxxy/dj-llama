import { useQuery } from '@tanstack/react-query'
import { StatCard } from '../components/stat-card'
import { Skeleton } from '../components/ui/skeleton'
import {
  type AnalyticsBatch,
  type AnalyticsGenre,
  type ApprovalTrend,
  getAnalyticsBatches,
  getAnalyticsGenres,
  getAnalyticsOverview,
  getApprovalTrend,
} from '../lib/api'
import { formatDate, formatDateTime } from '../lib/intl'

function formatAnalyticsDate(dateStr: string): string {
  return formatDateTime(dateStr)
}

function formatAnalyticsShortDate(dateStr: string): string {
  return formatDate(dateStr, { month: 'short', day: 'numeric' })
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`
}

function DiscoveryChart({ batches }: { batches: AnalyticsBatch[] }) {
  const recent = batches.slice(0, 20).reverse()
  const maxTotal = Math.max(...recent.map((b) => b.total), 1)
  const firstDate = recent[0]?.createdAt
  const lastDate = recent[recent.length - 1]?.createdAt

  return (
    <div className="bg-surface border border-border rounded-lg p-4">
      <div className="flex items-end gap-1 h-24">
        {recent.map((b) => {
          const h = Math.max((b.total / maxTotal) * 100, 4)
          const approvedH = b.total > 0 ? (b.approved / b.total) * h : 0
          return (
            <div
              key={b.id}
              className="flex-1 h-full flex flex-col justify-end group relative"
              title={`${formatAnalyticsDate(b.createdAt)}: ${b.total} recs (${b.approved} approved)`}
            >
              <div
                className="w-full rounded-t bg-accent/30"
                style={{ height: `${h - approvedH}%` }}
              />
              <div className="w-full rounded-b bg-approve" style={{ height: `${approvedH}%` }} />
            </div>
          )
        })}
      </div>
      <div className="flex justify-between mt-2 text-micro text-muted">
        <span>{firstDate ? formatAnalyticsShortDate(firstDate) : ''}</span>
        <span>{lastDate ? formatAnalyticsShortDate(lastDate) : ''}</span>
      </div>
    </div>
  )
}

function GenreBreakdown({
  genres,
  loading,
}: {
  genres: AnalyticsGenre[] | null
  loading: boolean
}) {
  if (loading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className="h-5 w-full" />
        ))}
      </div>
    )
  }

  if (!genres || genres.length === 0) {
    return (
      <div className="bg-surface border border-border rounded-lg px-4 py-8 text-center text-muted text-sm">
        No genre data available yet.
      </div>
    )
  }

  return (
    <div className="bg-surface border border-border rounded-lg p-4 space-y-2.5">
      {genres.map((g) => (
        <div key={g.genre} className="flex items-center gap-3">
          <span className="w-28 text-sm text-text truncate shrink-0" title={g.genre}>
            {g.genre}
          </span>
          <div className="flex-1 h-4 bg-bg rounded overflow-hidden">
            <div
              className="h-full bg-approve rounded transition-[width] duration-300"
              style={{ width: `${Math.round(g.approvalRate * 100)}%` }}
            />
          </div>
          <span className="text-xs text-muted w-20 text-right shrink-0">
            {pct(g.approvalRate)} of {g.count}
          </span>
        </div>
      ))}
    </div>
  )
}

// Running approval rate across all decisions so far, one point per batch.
// Batches only hold a handful of decided recs, so per-batch rates swing
// between 0% and 100%; the running rate shows the real trend and ends on the
// same number as the Approval Rate card.
function ApprovalTrendChart({ trend }: { trend: ApprovalTrend[] }) {
  if (trend.length < 2) return null
  let approved = 0
  let acted = 0
  const points = trend.map((t) => {
    approved += t.approved
    acted += t.acted
    return { ...t, running: acted > 0 ? approved / acted : 0 }
  })
  const firstDate = points[0]?.createdAt
  const lastDate = points[points.length - 1]?.createdAt
  const xOf = (i: number) => (i / (points.length - 1)) * 100
  const yOf = (rate: number) => 100 - rate * 100
  const line = points.map((p, i) => `${xOf(i)},${yOf(p.running)}`).join(' ')

  return (
    <div className="bg-surface border border-border rounded-lg p-4">
      <div className="flex gap-2">
        <div className="flex h-28 w-7 shrink-0 flex-col justify-between text-right text-micro text-muted tabular-nums -my-1.5">
          <span>100%</span>
          <span>50%</span>
          <span>0%</span>
        </div>
        <div className="relative h-28 flex-1">
          {/* The SVG stretches to fill the box, so it only draws lines (with
              non-scaling strokes). Dots are HTML so they stay round. */}
          <svg
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            className="absolute inset-0 h-full w-full overflow-visible"
            role="img"
            aria-label="Approval rate over time"
          >
            {[0, 50, 100].map((y) => (
              <line
                key={y}
                x1="0"
                x2="100"
                y1={y}
                y2={y}
                stroke="var(--color-border)"
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
              />
            ))}
            <polyline
              points={line}
              fill="none"
              stroke="var(--color-approve)"
              strokeWidth="2"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          {points.map((p, i) => (
            <span
              key={p.batchId}
              className="absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-approve"
              style={{ left: `${xOf(i)}%`, top: `${yOf(p.running)}%` }}
              title={`${formatAnalyticsShortDate(p.createdAt)}: ${p.approved} of ${p.acted} approved · ${pct(p.running)} overall`}
            />
          ))}
        </div>
      </div>
      <div className="mt-1.5 flex justify-between pl-9 text-micro text-muted">
        <span>{firstDate ? formatAnalyticsShortDate(firstDate) : ''}</span>
        <span>{lastDate ? formatAnalyticsShortDate(lastDate) : ''}</span>
      </div>
    </div>
  )
}

export function AnalyticsPage({ embedded = false }: { embedded?: boolean }) {
  const { data: overview, isLoading: overviewLoading } = useQuery({
    queryKey: ['analytics', 'overview'],
    queryFn: getAnalyticsOverview,
  })
  const { data: batches } = useQuery({
    queryKey: ['analytics', 'batches'],
    queryFn: getAnalyticsBatches,
  })
  const { data: genres, isLoading: genresLoading } = useQuery({
    queryKey: ['analytics', 'genres'],
    queryFn: getAnalyticsGenres,
  })
  const { data: trend } = useQuery({
    queryKey: ['analytics', 'trend'],
    queryFn: getApprovalTrend,
  })

  return (
    <div className={embedded ? 'space-y-6' : 'p-6 space-y-6 max-w-6xl mx-auto'}>
      <h1 className="sr-only">Analytics</h1>
      {/* Overview cards */}
      <div className="grid grid-cols-2 gap-4">
        <StatCard
          label="Recommendations"
          value={overviewLoading ? '--' : (overview?.totalRecs ?? 0)}
          loading={overviewLoading}
        />
        <StatCard
          label="Approval Rate"
          value={overviewLoading ? '--' : pct(overview?.approvalRate ?? 0)}
          loading={overviewLoading}
        />
      </div>

      {/* Discovery over time chart */}
      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-text uppercase tracking-wide">
          Discovery Over Time
        </h2>
        {batches && batches.length > 0 ? (
          <>
            <p className="text-xs text-muted -mt-2">Recommendations per batch (green = approved)</p>
            <DiscoveryChart batches={batches} />
          </>
        ) : (
          <div className="bg-surface border border-border rounded-lg p-6 text-center">
            <p className="text-sm text-muted">
              No discovery batches yet. Run a scan to see your history here.
            </p>
          </div>
        )}
      </div>

      {/* Approval trend + genres side by side on large screens */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-text uppercase tracking-wide">
            Approval Rate Over Time
          </h2>
          <p className="text-xs text-muted -mt-2">Running total across all your decisions</p>
          {trend && trend.length > 1 ? (
            <ApprovalTrendChart trend={trend} />
          ) : (
            <div className="bg-surface border border-border rounded-lg p-6 text-center">
              <p className="text-sm text-muted">Need 2+ batches to show trend</p>
            </div>
          )}
        </div>
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-text uppercase tracking-wide">
            Top Genres by Approval Rate
          </h2>
          <GenreBreakdown genres={genres ?? null} loading={genresLoading} />
        </div>
      </div>
    </div>
  )
}
