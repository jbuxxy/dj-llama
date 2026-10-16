import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { AlbumPicker } from '../components/album-picker'
import { ArtistThumb } from '../components/artist-thumb'
import { GenreCoverageSummary } from '../components/genre-coverage-summary'
import { Hint } from '../components/hint'
import type { MonitorOption } from '../components/monitoring-options'
import { PagerBar } from '../components/pager-bar'
import { PipelineProgress } from '../components/pipeline-progress'
import { RecentlyApproved } from '../components/recently-approved'
import { canApproveArtistToTarget } from '../components/target-utils'
import { type Recommendation, TodaysPick } from '../components/todays-pick'
import { Skeleton } from '../components/ui/skeleton'
import { Spinner } from '../components/ui/spinner'
import { useCollapsedSections } from '../hooks/use-collapsed-sections'
import {
  type ActivityEntry,
  approveRecommendation,
  approveToTarget,
  type GenreCoverage,
  getAuthStatus,
  getDashboardActivity,
  getDashboardGenreCoverage,
  getDashboardTaste,
  getRecentTracks,
  getRecommendations,
  getTopArtists,
  type ListeningTopRange,
  listMyRequests,
  listTargets,
  type RecentTrackEntry,
  type RequestRecord,
  rescanArtists,
  type TasteProfile as TasteProfileData,
  type TopArtistEntry,
  triggerPipeline,
  updateRecommendation,
} from '../lib/api'
import { reportApprovalOutcome } from '../lib/approval'

function formatRelativeTime(dateStr: string | Date): string {
  const diffMs = new Date(dateStr).getTime() - Date.now()
  const diffMinutes = Math.round(diffMs / 60_000)
  const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })

  if (Math.abs(diffMinutes) < 1) return formatter.format(0, 'second')
  if (Math.abs(diffMinutes) < 60) return formatter.format(diffMinutes, 'minute')

  const diffHours = Math.round(diffMinutes / 60)
  if (Math.abs(diffHours) < 24) return formatter.format(diffHours, 'hour')

  return formatter.format(Math.round(diffHours / 24), 'day')
}

// Every dashboard card except Today's Pick collapses through this, with
// state persisted per-user (see useCollapsedSections) so it survives a
// reload instead of resetting every visit.
function CollapsibleCard({
  id,
  title,
  headerExtra,
  children,
  defaultCollapsed = false,
  variant = 'section',
}: {
  id: string
  title: string
  headerExtra?: React.ReactNode
  children: React.ReactNode
  defaultCollapsed?: boolean
  // 'section' is a top-level dashboard card (bold uppercase header);
  // 'subsection' is nested inside one (e.g. the taste genre breakdown),
  // styled lighter so it doesn't compete with the card's own header.
  variant?: 'section' | 'subsection'
}) {
  const { isCollapsed, toggleSection } = useCollapsedSections()
  const collapsed = isCollapsed(id, defaultCollapsed)
  return (
    <div>
      <div className="flex items-center justify-between mb-3 gap-2">
        <button
          type="button"
          onClick={() => toggleSection(id)}
          aria-expanded={!collapsed}
          className={
            variant === 'section'
              ? 'flex items-center gap-1.5 text-sm font-semibold text-text uppercase tracking-wide hover:text-accent transition-colors'
              : 'flex items-center gap-1.5 text-xs font-medium text-muted hover:text-text transition-colors'
          }
        >
          <ChevronDown
            size={variant === 'section' ? 14 : 12}
            className={`transition-transform duration-150 ${collapsed ? '-rotate-90' : ''}`}
            aria-hidden="true"
          />
          {title}
        </button>
        {headerExtra}
      </div>
      <div
        className={`grid transition-[grid-template-rows] duration-200 ease-out ${collapsed ? 'grid-rows-[0fr]' : 'grid-rows-[1fr]'}`}
      >
        <div className="overflow-hidden">{children}</div>
      </div>
    </div>
  )
}

const LISTENING_TOP_RANGES: readonly ListeningTopRange[] = [
  'this_week',
  'this_month',
  'this_year',
  'all_time',
]

function rangeLabel(r: ListeningTopRange): string {
  return r === 'this_week'
    ? 'This week'
    : r === 'this_month'
      ? 'This month'
      : r === 'this_year'
        ? 'This year'
        : 'All time'
}

// Shared by both lists below: distinguishes "still loading" (no data
// fetched yet) from "connected but nothing in this window" from "not
// connected at all" -- collapsing all three into one "Connect to Plex"
// message meant it flashed on every range/page change even though the
// user is (and always was) connected, just between fetches.
function ListEmptyState({
  data,
  emptyMessage,
}: {
  data: { hasSource: boolean } | undefined
  emptyMessage: string
}) {
  if (!data) {
    return (
      <div className="p-4 space-y-3">
        {['s1', 's2', 's3'].map((k) => (
          <Skeleton key={k} className="h-4 w-full" />
        ))}
      </div>
    )
  }
  if (!data.hasSource) {
    return (
      <div className="p-6 text-center space-y-2">
        <p className="text-sm text-muted">
          Connect Plex in Settings so DJ Llama can learn what you listen to.
        </p>
        <Link to="/settings" className="text-xs text-accent underline inline-block">
          Connect an account
        </Link>
      </div>
    )
  }
  return (
    <div className="p-6 text-center">
      <p className="text-sm text-muted">{emptyMessage}</p>
    </div>
  )
}

function ListeningHistoryList({
  data,
  page,
  pageSize,
  onPageChange,
  isFetching,
}: {
  data: { tracks: TopArtistEntry[]; total: number; hasSource: boolean } | undefined
  page: number
  pageSize: number
  onPageChange: (p: number) => void
  isFetching: boolean
}) {
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / pageSize))
  return (
    <div>
      <div className="flex items-center gap-2 px-4 pt-3 pb-2">
        <h3 className="text-xs font-medium text-muted uppercase tracking-wide">Artist History</h3>
        {isFetching && <Spinner className="text-muted" />}
      </div>
      {!data?.hasSource || data.tracks.length === 0 ? (
        <ListEmptyState data={data} emptyMessage="No plays in this window" />
      ) : (
        <>
          <div className="divide-y divide-border">
            {data.tracks.map((entry) => (
              <div
                key={`${entry.source}-${entry.artist}-${entry.track}`}
                className="flex items-center gap-3 px-4 py-2.5"
              >
                <ArtistThumb name={entry.artist} imageUrl={entry.imageUrl} size={8} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-text truncate">{entry.artist}</p>
                  <p className="text-xs text-muted truncate">{entry.track}</p>
                </div>
              </div>
            ))}
          </div>
          <PagerBar page={page} totalPages={totalPages} onPageChange={onPageChange} />
        </>
      )}
    </div>
  )
}

function RecentlyPlayedList({
  data,
  page,
  pageSize,
  onPageChange,
  isFetching,
}: {
  data: { tracks: RecentTrackEntry[]; total: number; hasSource: boolean } | undefined
  page: number
  pageSize: number
  onPageChange: (p: number) => void
  isFetching: boolean
}) {
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / pageSize))
  return (
    <div>
      <div className="flex items-center gap-2 px-4 pt-3 pb-2">
        <h3 className="text-xs font-medium text-muted uppercase tracking-wide">Recently Played</h3>
        {isFetching && <Spinner className="text-muted" />}
      </div>
      {!data?.hasSource || data.tracks.length === 0 ? (
        <ListEmptyState data={data} emptyMessage="No recent plays" />
      ) : (
        <>
          <div className="divide-y divide-border">
            {data.tracks.map((entry) => (
              <div
                key={`${entry.source}-${entry.playedAt ?? ''}-${entry.artist}-${entry.track}`}
                className="flex items-center gap-3 px-4 py-2.5"
              >
                <ArtistThumb name={entry.artist} imageUrl={entry.imageUrl} size={8} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-text truncate">{entry.artist}</p>
                  <p className="text-xs text-muted truncate">{entry.track}</p>
                </div>
                {entry.nowPlaying ? (
                  <span className="text-xs text-accent shrink-0">Now playing</span>
                ) : entry.playedAt ? (
                  <span className="text-xs text-muted shrink-0">
                    {formatRelativeTime(entry.playedAt)}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
          <PagerBar page={page} totalPages={totalPages} onPageChange={onPageChange} />
        </>
      )}
    </div>
  )
}

// Range picker for Listening History + Recently Played -- rendered once, in
// CollapsibleCard's header, since both lists below page through the same
// This Week/Month/Year/All Time window (see ListeningActivitySection).
function ListeningRangePicker({
  range,
  onRangeChange,
}: {
  range: ListeningTopRange
  onRangeChange: (r: ListeningTopRange) => void
}) {
  return (
    <div className="flex gap-1 flex-wrap justify-end">
      {LISTENING_TOP_RANGES.map((r) => (
        <button
          key={r}
          type="button"
          onClick={() => onRangeChange(r)}
          className={`text-xs px-2 py-0.5 rounded ${range === r ? 'bg-accent text-accent-fg' : 'text-muted hover:text-text'}`}
        >
          {rangeLabel(r)}
        </button>
      ))}
    </div>
  )
}

// Artist History + Recently Played, divided side by side -- both page
// through the range picked in the shared CollapsibleCard header above them,
// so a divided single card (rather than two separately-bordered widgets)
// makes that sharing visually obvious.
// Two fully separate bordered panels with real space between them --
// rather than one box with an internal divider line -- so the break
// between them reads clearly even at a glance, while the shared header
// above (title + range picker) still makes clear they're one filtered view.
function ListeningActivitySection({
  topArtistsData,
  topArtistsFetching,
  recentTracksData,
  recentTracksFetching,
  listenPage,
  onListenPageChange,
  recentPage,
  onRecentPageChange,
  pageSize,
}: {
  topArtistsData: { tracks: TopArtistEntry[]; total: number; hasSource: boolean } | undefined
  topArtistsFetching: boolean
  recentTracksData: { tracks: RecentTrackEntry[]; total: number; hasSource: boolean } | undefined
  recentTracksFetching: boolean
  listenPage: number
  onListenPageChange: (p: number) => void
  recentPage: number
  onRecentPageChange: (p: number) => void
  pageSize: number
}) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      <div className="bg-surface border border-border rounded-lg overflow-hidden">
        <ListeningHistoryList
          data={topArtistsData}
          page={listenPage}
          pageSize={pageSize}
          onPageChange={onListenPageChange}
          isFetching={topArtistsFetching}
        />
      </div>
      <div className="bg-surface border border-border rounded-lg overflow-hidden">
        <RecentlyPlayedList
          data={recentTracksData}
          page={recentPage}
          pageSize={pageSize}
          onPageChange={onRecentPageChange}
          isFetching={recentTracksFetching}
        />
      </div>
    </div>
  )
}

function TasteProfileSection({
  profile,
  coverage,
  loading,
}: {
  profile: TasteProfileData | undefined
  coverage: GenreCoverage | null | undefined
  loading: boolean
}) {
  const genres = profile?.genres
  return (
    <div>
      <div className="bg-surface border border-border rounded-lg p-4">
        {loading ? (
          <div className="space-y-3">
            {['t1', 't2', 't3', 't4', 't5'].map((k) => (
              <Skeleton key={k} className="h-4 w-full" />
            ))}
          </div>
        ) : !genres || genres.length === 0 ? (
          <p className="text-sm text-muted text-center py-4">
            As you listen and like songs, DJ Llama learns your taste and gets better at reading the
            room.
          </p>
        ) : (
          <div className="space-y-3">
            {profile?.title && (
              <div>
                <p className="text-sm font-semibold text-text">{profile.title}</p>
                {profile.reasoning && (
                  <p className="text-xs text-muted mt-0.5">{profile.reasoning}</p>
                )}
              </div>
            )}
            <CollapsibleCard
              id="dashboard-taste-genres"
              title="Genre Breakdown"
              defaultCollapsed
              variant="subsection"
            >
              <div className="space-y-2.5 pt-1">
                {!profile?.title && (
                  <p className="text-xs text-muted -mt-0.5 mb-1">
                    Genre mix blended from songs you’ve liked, what you’ve played recently, and what
                    you’ve been adding to your library.
                  </p>
                )}
                {genres.map((g, i) => (
                  <div key={g.genre}>
                    <div className="flex items-center justify-between text-xs mb-1">
                      <span className="text-text truncate">{g.genre}</span>
                      <span className="text-muted shrink-0 ml-2">{g.percentage}%</span>
                    </div>
                    <div className="h-2 bg-bg rounded-full overflow-hidden">
                      <div
                        className="h-full bg-accent rounded-full transition-[width] duration-300"
                        style={{ width: `${g.percentage}%`, opacity: 1 - i * 0.15 }}
                      />
                    </div>
                  </div>
                ))}
                {coverage && coverage.totalArtists > 0 ? (
                  <div className="mt-1 pt-3 border-t border-border">
                    <GenreCoverageSummary coverage={coverage} />
                  </div>
                ) : null}
              </div>
            </CollapsibleCard>
          </div>
        )}
      </div>
    </div>
  )
}

// Rows truncate to one line; tapping one toggles the full text (long
// auto-added entries are otherwise unreadable on mobile).
function ActivityRow({ children }: { children: ReactNode }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <button
      type="button"
      aria-expanded={expanded}
      onClick={() => setExpanded((v) => !v)}
      className={`w-full text-left flex gap-3 px-4 py-2.5 ${
        expanded
          ? 'items-start [&_p]:whitespace-normal [&_p]:break-words'
          : 'items-center [&_p]:truncate'
      }`}
    >
      {children}
    </button>
  )
}

function ActivityFeed({
  entries,
  loading,
}: {
  entries: ActivityEntry[] | undefined
  loading: boolean
}) {
  return (
    <div>
      <div className="bg-surface border border-border rounded-lg">
        {loading ? (
          <div className="p-4 space-y-3">
            {['a1', 'a2', 'a3', 'a4', 'a5'].map((k) => (
              <Skeleton key={k} className="h-4 w-full" />
            ))}
          </div>
        ) : !entries || entries.length === 0 ? (
          <p className="text-sm text-muted text-center py-6">
            Nothing on the set list yet. Activity shows up as you discover and approve new artists.
          </p>
        ) : (
          <div className="divide-y divide-border">
            {entries.map((entry) => (
              <ActivityRow key={`${entry.type}-${entry.timestamp}-${entry.data.artistName ?? ''}`}>
                <span className="text-xs shrink-0">
                  {entry.type === 'approved'
                    ? '\u2713'
                    : entry.type === 'rejected'
                      ? '\u2717'
                      : entry.type === 'auto_request_added'
                        ? '\u2795'
                        : '\u25C9'}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-text">
                    {entry.data.username && (
                      <span className="text-muted">{entry.data.username}: </span>
                    )}
                    {entry.type === 'approved' && `Approved ${entry.data.artistName}`}
                    {entry.type === 'rejected' && `Rejected ${entry.data.artistName}`}
                    {entry.type === 'scan_completed' && `Scan: ${entry.data.discovered} discovered`}
                    {entry.type === 'auto_request_added' &&
                      `Auto-added: ${entry.data.albumTitle ? `${entry.data.artistName} \u2013 ${entry.data.albumTitle}` : entry.data.artistName}`}
                  </p>
                  {entry.type === 'auto_request_added' && entry.data.playlistName && (
                    <p className="text-xs text-muted">{`from ${entry.data.playlistName}`}</p>
                  )}
                </div>
                <span className="text-xs text-muted shrink-0">
                  {formatRelativeTime(entry.timestamp)}
                </span>
              </ActivityRow>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export function Dashboard() {
  const queryClient = useQueryClient()
  const [skippedIds, setSkippedIds] = useState<Set<number>>(new Set())
  const [actedIds, setActedIds] = useState<Set<number>>(new Set())
  // Listening History and Recently Played share this range/page-size --
  // see ListeningActivitySection's single filter above both lists.
  const [listenRange, setListenRange] = useState<ListeningTopRange>('this_month')
  const [listenPage, setListenPage] = useState(0)
  const [recentPage, setRecentPage] = useState(0)
  const LISTENING_PAGE_SIZE = 5
  const { data: authStatus } = useQuery({ queryKey: ['auth-status'], queryFn: getAuthStatus })
  const isAdmin = authStatus?.isAdmin ?? false

  // Pending pick - fetch 10 so skip has runway
  const { data: pickData, isLoading: pickLoading } = useQuery({
    queryKey: ['dashboard-pick'],
    queryFn: () => getRecommendations({ status: 'pending', sort: 'score_desc', limit: '10' }),
    staleTime: 30_000,
  })

  // Recently approved
  const { data: approvedData, isLoading: approvedLoading } = useQuery({
    queryKey: ['dashboard-approved'],
    queryFn: () =>
      getRecommendations({
        status: 'added_to_lidarr,add_failed,approved',
        sort: 'acted_on_desc',
        limit: '24',
      }),
    staleTime: 30_000,
  })

  // Recently approved also needs to include manually-searched-and-approved
  // requests -- those live entirely in the separate `requests` table (not
  // `recommendations`), so getRecommendations above never sees them. Pull
  // recent request history and merge the dispatched ones in below.
  const { data: approvedRequestsData, isLoading: approvedRequestsLoading } = useQuery({
    queryKey: ['dashboard-approved-requests'],
    queryFn: async () => (await listMyRequests({ limit: '24' })).items,
    staleTime: 30_000,
  })

  // Listening history (top artists). placeholderData keeps the previous
  // page/range's rows on screen during a refetch instead of the widget
  // dropping to "no data" (and briefly showing the connect-Plex empty
  // state) every time the range or page changes -- isFetching drives a
  // small progress indicator instead.
  const { data: topArtistsData, isFetching: topArtistsFetching } = useQuery({
    queryKey: ['dashboard-top-artists', listenRange, listenPage, LISTENING_PAGE_SIZE],
    queryFn: () =>
      getTopArtists(listenRange, listenPage * LISTENING_PAGE_SIZE, LISTENING_PAGE_SIZE),
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  })

  // Recent activity (latest scrobbles) -- same range as top-artists above
  const { data: recentTracksData, isFetching: recentTracksFetching } = useQuery({
    queryKey: ['dashboard-recent-tracks', listenRange, recentPage, LISTENING_PAGE_SIZE],
    queryFn: () =>
      getRecentTracks(listenRange, recentPage * LISTENING_PAGE_SIZE, LISTENING_PAGE_SIZE),
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  })

  // Taste
  const { data: tasteData, isLoading: tasteLoading } = useQuery({
    queryKey: ['dashboard-taste'],
    queryFn: getDashboardTaste,
    staleTime: 30_000,
  })

  const { data: genreCoverageData } = useQuery({
    queryKey: ['dashboard-genre-coverage'],
    queryFn: getDashboardGenreCoverage,
    staleTime: 30_000,
  })

  // Activity
  const { data: activityData, isLoading: activityLoading } = useQuery({
    queryKey: ['dashboard-activity'],
    queryFn: () => getDashboardActivity(5),
    staleTime: 30_000,
  })

  // Targets (for multi-target approve dropdown)
  const { data: targetsData } = useQuery({
    queryKey: ['targets'],
    queryFn: listTargets,
    staleTime: 60_000,
  })

  const targets = targetsData ?? []
  const approveTargets = targets.filter(
    (target) => target.enabled && target.owned && canApproveArtistToTarget(target.type),
  )

  const [albumPickerRec, setAlbumPickerRec] = useState<Recommendation | null>(null)

  // Auto-rescan images for artists that are missing them (once per mount)
  const rescannedRef = useRef(false)
  useEffect(() => {
    if (!isAdmin || rescannedRef.current) return
    const all = [
      ...((pickData?.items ?? []) as Recommendation[]),
      ...((approvedData?.items ?? []) as Recommendation[]),
    ]
    const missing = all.some((r) => !r.artist.imageUrl)
    if (missing && all.length > 0) {
      rescannedRef.current = true
      rescanArtists()
        .then(() => {
          queryClient.invalidateQueries({ queryKey: ['dashboard-pick'] })
          queryClient.invalidateQueries({ queryKey: ['dashboard-approved'] })
        })
        .catch(() => {})
    }
  }, [isAdmin, pickData, approvedData, queryClient])

  const allPending = (pickData?.items ?? []) as Recommendation[]

  // Daily pick rotation: use date as seed to show a different rec each day.
  // Pool is filtered to recs the user hasn't acted on this session.
  const currentPick = (() => {
    const pool = allPending.filter((r) => !skippedIds.has(r.id) && !actedIds.has(r.id))
    if (pool.length === 0) return null
    const day = new Date().toDateString()
    const hash = [...day].reduce((acc, c) => acc * 31 + c.charCodeAt(0), 0)
    return pool[Math.abs(hash) % pool.length] ?? null
  })()

  // Recently approved recs for the gallery -- merges AI recommendations
  // (recommendations table) with manually-searched-and-approved requests
  // (requests table, dispatched status only), sorted by whichever happened
  // most recently, since RecentlyApproved has no notion of which table an
  // item came from.
  const approvedRecs = (() => {
    const recs = ((approvedData?.items ?? []) as Recommendation[]).map((rec) => ({
      rec,
      actedAt: (rec as unknown as { actedOnAt?: string | null }).actedOnAt ?? null,
    }))
    const dispatchedRequests = ((approvedRequestsData ?? []) as RequestRecord[])
      .filter((req) => req.status === 'dispatched')
      .map((req) => ({
        rec: {
          // Requests and recommendations are separate DB sequences -- offset
          // request ids well clear of any real recommendation id so React
          // keys never collide.
          id: 1_000_000_000 + req.id,
          kind: req.kind,
          recommendedReleaseGroupId: req.releaseGroupMbid,
          recommendedReleaseGroupTitle: req.albumTitle,
          artist: { id: 0, name: req.artistName, mbid: req.artistMbid, imageUrl: req.coverUrl },
        } as Recommendation,
        actedAt: req.decidedAt,
      }))
    return [...recs, ...dispatchedRequests]
      .sort(
        (a, b) => (b.actedAt ? Date.parse(b.actedAt) : 0) - (a.actedAt ? Date.parse(a.actedAt) : 0),
      )
      .slice(0, 24)
      .map((entry) => entry.rec)
  })()

  async function handleAction(id: number, status: 'approved' | 'rejected') {
    setActedIds((prev) => new Set([...prev, id]))
    try {
      const res = await (status === 'approved'
        ? approveRecommendation(id)
        : updateRecommendation(id, { status }))
      if (reportApprovalOutcome(res)) {
        toast.success(status === 'approved' ? 'Approved' : 'Rejected')
      }
      queryClient.invalidateQueries({ queryKey: ['dashboard-pick'] })
      if (status === 'approved') {
        queryClient.invalidateQueries({ queryKey: ['dashboard-approved'] })
      }
    } catch {
      toast.error('Failed')
      setActedIds((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  }

  // Quality/metadata profile and root folder are admin-only global defaults
  // (see buildAddOptions in server/routes/recommendations.ts) -- the server
  // already falls back to settings.preferences whenever the client omits
  // them, so there's nothing for a per-user picker to add here. Approving
  // dispatches immediately with just the monitor scope the user picked.
  async function handleApproveWithOption(recId: number, monitorOption: MonitorOption) {
    setActedIds((prev) => new Set([...prev, recId]))
    try {
      const res = await approveRecommendation(recId, { monitorOption })
      if (reportApprovalOutcome(res)) toast.success('Approved')
      queryClient.invalidateQueries({ queryKey: ['dashboard-pick'] })
      queryClient.invalidateQueries({ queryKey: ['dashboard-approved'] })
    } catch {
      toast.error('Failed')
      setActedIds((prev) => {
        const next = new Set(prev)
        next.delete(recId)
        return next
      })
    }
  }

  async function handleApproveWholeDiscography(recId: number) {
    setActedIds((prev) => new Set([...prev, recId]))
    try {
      const res = await approveRecommendation(recId, {
        monitorOption: 'all',
        expandToDiscography: true,
      })
      if (reportApprovalOutcome(res)) toast.success('Approved')
      queryClient.invalidateQueries({ queryKey: ['dashboard-pick'] })
      queryClient.invalidateQueries({ queryKey: ['dashboard-approved'] })
    } catch {
      toast.error('Failed')
      setActedIds((prev) => {
        const next = new Set(prev)
        next.delete(recId)
        return next
      })
    }
  }

  function handleOpenAlbumPicker(recId: number) {
    const rec = currentPick?.id === recId ? currentPick : null
    if (!rec?.artist.mbid) {
      toast.error('Failed')
      return
    }
    setAlbumPickerRec(rec)
  }

  async function handleApproveToTarget(recId: number, targetId: string) {
    setActedIds((prev) => new Set([...prev, recId]))
    try {
      const res = await approveToTarget(recId, targetId)
      if (reportApprovalOutcome(res)) toast.success('Sent to target')
      queryClient.invalidateQueries({ queryKey: ['dashboard-pick'] })
      queryClient.invalidateQueries({ queryKey: ['dashboard-approved'] })
    } catch {
      toast.error('Failed to approve')
    } finally {
      setActedIds((prev) => {
        const next = new Set(prev)
        next.delete(recId)
        return next
      })
    }
  }

  function handleSkip(id: number) {
    setSkippedIds((prev) => new Set([...prev, id]))
  }

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6 max-w-6xl xl:max-w-7xl mx-auto">
      <h1 className="sr-only">Dashboard</h1>
      {/* Pipeline progress (self-hides) */}
      <PipelineProgress
        onComplete={() => {
          queryClient.invalidateQueries({ queryKey: ['dashboard-pick'] })
          queryClient.invalidateQueries({ queryKey: ['dashboard-approved'] })
          queryClient.invalidateQueries({ queryKey: ['dashboard-activity'] })
          queryClient.invalidateQueries({ queryKey: ['dashboard-genre-coverage'] })
        }}
        isFirstScan={
          (!pickData || pickData.items.length === 0) &&
          (!approvedData || approvedData.items.length === 0) &&
          (!approvedRequestsData || approvedRequestsData.length === 0)
        }
      />

      {/* Today's Pick - full-width hero, the daily-return hook */}
      <section>
        <h2 className="text-base font-semibold text-text mb-3">Today's Pick</h2>
        <TodaysPick
          rec={currentPick}
          loading={pickLoading}
          onApprove={(id) => handleAction(id, 'approved')}
          onReject={(id) => handleAction(id, 'rejected')}
          onSkip={handleSkip}
          onRunScan={() => {
            triggerPipeline()
              .then((res) =>
                toast.success(
                  res.status === 'duplicate'
                    ? 'Scan already running'
                    : res.queued
                      ? `Scan queued (position ${res.position ?? 0}) - it will start when the current run finishes`
                      : 'Scan started - check Dashboard for progress',
                ),
              )
              .catch(() => toast.error('Failed to start scan'))
          }}
          targets={approveTargets}
          onApproveToTarget={handleApproveToTarget}
          onApproveWithOption={handleApproveWithOption}
          onOpenAlbumPicker={handleOpenAlbumPicker}
          onApproveWholeDiscography={handleApproveWholeDiscography}
        />
      </section>

      <Hint id="dashboard-feedback-tip" type="spotlight">
        Approve or reject recommendations to teach DJ Llama your taste. The more feedback you give,
        the better your future recommendations get.
      </Hint>

      {/* Recently Approved - full-width carousel, more visible tiles on wide screens */}
      <CollapsibleCard
        id="dashboard-recently-approved"
        title="Recently Approved"
        headerExtra={
          <Link to="/discover" className="text-xs text-accent underline">
            View all
          </Link>
        }
      >
        <RecentlyApproved
          recs={approvedRecs}
          loading={approvedLoading || approvedRequestsLoading}
        />
      </CollapsibleCard>

      {/* Artist History + Recently Played, sharing one range filter */}
      <CollapsibleCard
        id="dashboard-listening-activity"
        title="Listening Activity"
        headerExtra={
          <div className="flex items-center gap-2">
            <ListeningRangePicker
              range={listenRange}
              onRangeChange={(r) => {
                setListenRange(r)
                setListenPage(0)
                setRecentPage(0)
              }}
            />
            <Hint id="dashboard-listening-tip" type="inline">
              Your listening data comes from Plex.
            </Hint>
          </div>
        }
      >
        <ListeningActivitySection
          topArtistsData={topArtistsData}
          topArtistsFetching={topArtistsFetching}
          recentTracksData={recentTracksData}
          recentTracksFetching={recentTracksFetching}
          listenPage={listenPage}
          onListenPageChange={setListenPage}
          recentPage={recentPage}
          onRecentPageChange={setRecentPage}
          pageSize={LISTENING_PAGE_SIZE}
        />
      </CollapsibleCard>

      {/* Taste Profile + Activity Feed */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <CollapsibleCard
          id="dashboard-taste"
          title="Your Taste"
          headerExtra={
            <Hint id="dashboard-taste-tip" type="inline">
              Built from liked tracks, recent Plex plays, and recently added albums -- weighted
              toward what's fresh, so it shifts as your listening does. Recomputed about once a day.
            </Hint>
          }
        >
          <TasteProfileSection
            profile={tasteData}
            coverage={genreCoverageData}
            loading={tasteLoading}
          />
        </CollapsibleCard>
        <CollapsibleCard id="dashboard-activity" title="Recent Activity">
          <ActivityFeed entries={activityData} loading={activityLoading} />
        </CollapsibleCard>
      </div>

      {albumPickerRec?.artist.mbid &&
        (() => {
          const pickerRec = albumPickerRec
          const artistMbid = pickerRec.artist.mbid
          if (!artistMbid) return null
          return (
            <AlbumPicker
              artistMbid={artistMbid}
              artistName={pickerRec.artist.name}
              artistImageUrl={pickerRec.artist.imageUrl}
              suggestedAlbumId={pickerRec.recommendedReleaseGroupId}
              onConfirm={async (selectedAlbumIds) => {
                setAlbumPickerRec(null)
                setActedIds((prev) => new Set([...prev, pickerRec.id]))
                try {
                  const res = await approveRecommendation(pickerRec.id, {
                    monitorOption: 'selected',
                    selectedAlbumIds,
                  })
                  if (reportApprovalOutcome(res)) toast.success('Approved')
                  queryClient.invalidateQueries({ queryKey: ['dashboard-pick'] })
                  queryClient.invalidateQueries({ queryKey: ['dashboard-approved'] })
                } catch {
                  toast.error('Failed')
                } finally {
                  setActedIds((prev) => {
                    const next = new Set(prev)
                    next.delete(pickerRec.id)
                    return next
                  })
                }
              }}
              onCancel={() => setAlbumPickerRec(null)}
            />
          )
        })()}
    </div>
  )
}
