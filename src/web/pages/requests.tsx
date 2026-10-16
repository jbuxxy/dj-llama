import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Check,
  Disc3,
  ListPlus,
  Loader2,
  Music,
  RefreshCw,
  SearchIcon,
  User as UserIcon,
  X,
} from 'lucide-react'
import { useDeferredValue, useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { errMsg } from '@/core/validation'
import { ConfirmDialog } from '../components/confirm-dialog'
import { LibraryAlbumCoverageBadge } from '../components/library-album-coverage-badge'
import { PagerBar } from '../components/pager-bar'
import { Button } from '../components/ui/button'
import { Card, CardContent } from '../components/ui/card'
import {
  approveRequest,
  createRequest,
  dismissAllInLibraryRequests,
  dismissRequest,
  getCurrentUser,
  listMyRequests,
  listPendingRequests,
  type PendingRequestRecord,
  type RequestRecord,
  type RequestSearchAlbum,
  type RequestSearchTrack,
  rejectRequest,
  retryFailedRequests,
  retryRequest,
  searchRequestable,
  searchTracksRequestable,
} from '../lib/api'

type SearchMode = 'artists' | 'tracks'

const MY_REQUESTS_PAGE_SIZE = 10

const REQUEST_STATUS_LABEL: Record<RequestRecord['status'], string> = {
  pending: 'Pending approval',
  dispatched: 'Sent to Lidarr',
  failed: 'Failed',
  rejected: 'Rejected',
}

function statusBadgeClass(status: RequestRecord['status']): string {
  switch (status) {
    case 'dispatched':
      return 'bg-approve/10 text-approve'
    case 'rejected':
      return 'bg-reject/10 text-reject'
    case 'failed':
      return 'bg-reject/10 text-reject'
    default:
      return 'bg-bg text-muted border border-border'
  }
}

// The real failure reason lives in per-target targetActions (e.g.
// { "lidarr-1": { status: "failed", error: "album not found in Lidarr" } }),
// not on the request row itself -- surfaced here since it used to be fetched
// and silently discarded.
function requestFailureReason(req: RequestRecord): string | null {
  if (!req.targetActions) return null
  for (const action of Object.values(req.targetActions)) {
    const error = (action as { error?: unknown } | null)?.error
    if (typeof error === 'string' && error.trim()) return error
  }
  return null
}

// Whether dismissing this request will actually cancel something in Lidarr
// (see server/routes/requests.ts's cancelRequestInTargets) vs. just a plain
// hide -- a still-pending/failed/rejected request never reached Lidarr at all.
function hasDispatchedTarget(req: RequestRecord): boolean {
  if (!req.targetActions) return false
  return Object.values(req.targetActions).some((action) => {
    const status = (action as { status?: unknown } | null)?.status
    return status === 'added' || status === 'queued'
  })
}

// coverUrl often points at Lidarr's own MediaCoverProxy (a relative path
// resolved against lidarrPublicUrl server-side) -- that only actually loads
// for a browser that can reach the Lidarr instance's public URL, which an
// off-network client (e.g. on a work/cellular connection, behind whatever
// access gate fronts that subdomain) may not be able to do even though the
// server-side request that built the URL succeeded fine. coverartarchive.org
// is a public CDN with no such dependency, so it's the fallback on an actual
// *load* failure here -- not just when coverUrl is absent to begin with,
// which is what the previous version of this component did (a `??` only
// engages when the left side is null/undefined, so a present-but-unreachable
// coverUrl never actually fell through to the archive).
function CoverThumb({
  coverUrl,
  releaseGroupMbid,
  shape,
  placeholderIcon: Icon,
}: {
  coverUrl?: string | null
  releaseGroupMbid?: string | null
  shape: 'square' | 'circle'
  placeholderIcon: typeof Disc3
}) {
  const [primaryFailed, setPrimaryFailed] = useState(false)
  const [archiveFailed, setArchiveFailed] = useState(false)
  const archiveUrl = releaseGroupMbid
    ? `https://coverartarchive.org/release-group/${releaseGroupMbid}/front-500`
    : null
  const displayUrl = coverUrl && !primaryFailed ? coverUrl : !archiveFailed ? archiveUrl : null
  const sizeClass =
    shape === 'square'
      ? 'w-12 h-12 rounded object-cover flex-shrink-0'
      : 'w-12 h-12 rounded-full object-cover flex-shrink-0'
  const placeholderClass =
    shape === 'square'
      ? 'w-12 h-12 rounded bg-bg flex items-center justify-center flex-shrink-0'
      : 'w-12 h-12 rounded-full bg-bg flex items-center justify-center flex-shrink-0'

  if (displayUrl) {
    return (
      <img
        src={displayUrl}
        alt=""
        className={sizeClass}
        onError={() => (displayUrl === coverUrl ? setPrimaryFailed(true) : setArchiveFailed(true))}
      />
    )
  }
  return (
    <div className={placeholderClass}>
      <Icon size={20} className="text-muted" />
    </div>
  )
}

function RequestThumb({ req }: { req: RequestRecord }) {
  return (
    <CoverThumb
      coverUrl={req.coverUrl}
      releaseGroupMbid={req.kind === 'album' ? req.releaseGroupMbid : null}
      shape={req.kind === 'album' ? 'square' : 'circle'}
      placeholderIcon={req.kind === 'album' ? Disc3 : UserIcon}
    />
  )
}

// Failure/rejection reasons are often long Lidarr error strings that a
// one-line truncate cuts to "The operation was ..." -- tap to read the rest.
function ExpandableReason({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <button
      type="button"
      aria-expanded={expanded}
      onClick={() => setExpanded((v) => !v)}
      className={`block w-full text-left text-xs text-reject ${
        expanded ? 'whitespace-normal break-words' : 'truncate'
      }`}
    >
      {text}
    </button>
  )
}

function RequestRow({
  req,
  onRetry,
  retrying,
  onDismiss,
  dismissing,
}: {
  req: RequestRecord
  onRetry?: () => void
  retrying?: boolean
  onDismiss?: () => void
  dismissing?: boolean
}) {
  const failureReason = req.status === 'failed' ? requestFailureReason(req) : null

  return (
    <div className="flex items-center justify-between gap-3 p-3 rounded-lg border border-border bg-surface">
      <div className="flex items-center gap-3 min-w-0">
        <RequestThumb req={req} />
        <div className="min-w-0">
          <p className="text-sm font-medium text-text truncate">
            {req.kind === 'album' ? req.albumTitle : req.artistName}
          </p>
          {req.kind === 'album' && <p className="text-xs text-muted truncate">{req.artistName}</p>}
          {req.status === 'rejected' && req.rejectionReason && (
            <ExpandableReason text={req.rejectionReason} />
          )}
          {failureReason && <ExpandableReason text={failureReason} />}
        </div>
      </div>
      <div className="flex items-center gap-1.5 flex-shrink-0">
        {req.libraryConfirmedAt ? (
          <span className="text-xs px-2 py-0.5 rounded-full bg-approve/15 text-approve">
            Added to Library
          </span>
        ) : (
          <span className={`text-xs px-2 py-0.5 rounded-full ${statusBadgeClass(req.status)}`}>
            {REQUEST_STATUS_LABEL[req.status]}
          </span>
        )}
        {req.status === 'failed' && onRetry && (
          <Button
            size="icon"
            variant="outline"
            onClick={onRetry}
            disabled={retrying}
            aria-label="Retry"
            title="Retry"
          >
            <RefreshCw size={14} className={retrying ? 'animate-spin' : undefined} />
          </Button>
        )}
        {onDismiss && (
          <Button
            size="icon"
            variant="outline"
            onClick={onDismiss}
            disabled={dismissing}
            aria-label="Dismiss"
            title="Dismiss"
          >
            <X size={14} />
          </Button>
        )}
      </div>
    </div>
  )
}

export function RequestsPage() {
  const queryClient = useQueryClient()
  const [mode, setMode] = useState<SearchMode>('artists')
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)

  // Track search hits MusicBrainz directly (no Lidarr proxy exists for
  // recording search), which is rate-limited to ~1 req/sec and needs a
  // follow-up request per result -- too slow to run on every keystroke, so
  // it only searches on explicit submit (Enter / button), not live typing.
  const [trackQuery, setTrackQuery] = useState('')
  const [submittedTrackQuery, setSubmittedTrackQuery] = useState('')

  // Deep link from a missing-playlist-track entry (playlists.tsx's "Search &
  // Request" action) -- prefills and runs the track search immediately
  // instead of landing on an empty page.
  const [searchParams, setSearchParams] = useSearchParams()
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once against the initial URL only
  useEffect(() => {
    const q = searchParams.get('q')
    if (!q) return
    setMode('tracks')
    setTrackQuery(q)
    setSubmittedTrackQuery(q)
    setSearchParams({}, { replace: true })
  }, [])

  const { data: currentUser } = useQuery({ queryKey: ['currentUser'], queryFn: getCurrentUser })

  const searchQuery = useQuery({
    queryKey: ['requests-search', deferredQuery],
    queryFn: () => searchRequestable(deferredQuery),
    enabled: mode === 'artists' && deferredQuery.trim().length >= 2,
    staleTime: 30_000,
  })

  const trackSearchQuery = useQuery({
    queryKey: ['requests-search-tracks', submittedTrackQuery],
    queryFn: () => searchTracksRequestable(submittedTrackQuery),
    enabled: mode === 'tracks' && submittedTrackQuery.trim().length >= 2,
    staleTime: 30_000,
  })

  function submitTrackSearch() {
    setSubmittedTrackQuery(trackQuery)
  }

  // Confirmed-in-library requests pile up over time and drown out the ones
  // that still need attention -- a tab switch (instead of sorting to the
  // bottom of one long list, or hiding them entirely) keeps the open-request
  // list scannable while still surfacing library confirmations as real,
  // visible history. Each tab is its own server-side filter + page (not a
  // client-side split of one shared page), so paging through Open Requests
  // walks every open request, not just whatever lands on a mixed page.
  const [myRequestsTab, setMyRequestsTab] = useState<'open' | 'in_library'>('open')
  const [myRequestsPage, setMyRequestsPage] = useState(0)

  function selectMyRequestsTab(tab: 'open' | 'in_library') {
    setMyRequestsTab(tab)
    setMyRequestsPage(0)
  }

  const myRequestsQuery = useQuery({
    queryKey: ['requests-mine', myRequestsTab, myRequestsPage],
    queryFn: () =>
      listMyRequests({
        limit: String(MY_REQUESTS_PAGE_SIZE),
        offset: String(myRequestsPage * MY_REQUESTS_PAGE_SIZE),
        libraryStatus: myRequestsTab,
      }),
    placeholderData: keepPreviousData,
    // Realtime events refresh this as each retried request finishes; the
    // poll is a fallback so the button can't get stuck spinning.
    refetchInterval: (query) => (query.state.data?.retryingFailed ? 10_000 : false),
  })
  const retryingFailed = myRequestsQuery.data?.retryingFailed === true

  const myRequests = myRequestsQuery.data?.items ?? []
  const myRequestsTotalPages = Math.max(
    1,
    Math.ceil((myRequestsQuery.data?.total ?? 0) / MY_REQUESTS_PAGE_SIZE),
  )

  const pendingQuery = useQuery({
    queryKey: ['requests-pending'],
    queryFn: listPendingRequests,
    enabled: !!currentUser?.isAdmin,
  })

  // Requesting a search result doesn't remove it from the list (the same
  // album/track can be re-requested), so instead of an optimistic removal
  // this just flashes a checkmark on the button that was clicked -- keyed by
  // releaseGroupMbid since that's the one field every requestable result has.
  const [justRequested, setJustRequested] = useState<string | null>(null)
  const justRequestedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    return () => {
      if (justRequestedTimeoutRef.current) clearTimeout(justRequestedTimeoutRef.current)
    }
  }, [])

  const submit = useMutation({
    mutationFn: createRequest,
    onSuccess: (result, variables) => {
      queryClient.invalidateQueries({ queryKey: ['requests-mine'] })
      toast.success(
        result.status === 'dispatched'
          ? 'Request sent to Lidarr'
          : result.status === 'failed'
            ? 'Request approved, but Lidarr could not add it'
            : 'Request submitted for admin approval',
      )
      if (variables.releaseGroupMbid) {
        if (justRequestedTimeoutRef.current) clearTimeout(justRequestedTimeoutRef.current)
        setJustRequested(variables.releaseGroupMbid)
        justRequestedTimeoutRef.current = setTimeout(() => setJustRequested(null), 2000)
      }
    },
    onError: (err) => toast.error(errMsg(err)),
  })

  // Approving/rejecting removes the row from the pending queue the instant
  // the click happens (instead of waiting on the round trip + refetch) so
  // it's obvious the click registered; rolled back if the request fails.
  const approve = useMutation({
    mutationFn: approveRequest,
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: ['requests-pending'] })
      const previous = queryClient.getQueryData<PendingRequestRecord[]>(['requests-pending'])
      queryClient.setQueryData<PendingRequestRecord[]>(['requests-pending'], (old) =>
        (old ?? []).filter((r) => r.id !== id),
      )
      return { previous }
    },
    onSuccess: () => {
      toast.success('Request approved and sent to Lidarr')
    },
    onError: (err, _id, context) => {
      if (context?.previous) queryClient.setQueryData(['requests-pending'], context.previous)
      toast.error(errMsg(err))
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['requests-pending'] })
      queryClient.invalidateQueries({ queryKey: ['requests-mine'] })
    },
  })

  const reject = useMutation({
    mutationFn: ({ id, reason }: { id: number; reason?: string }) => rejectRequest(id, reason),
    onMutate: async ({ id }) => {
      await queryClient.cancelQueries({ queryKey: ['requests-pending'] })
      const previous = queryClient.getQueryData<PendingRequestRecord[]>(['requests-pending'])
      queryClient.setQueryData<PendingRequestRecord[]>(['requests-pending'], (old) =>
        (old ?? []).filter((r) => r.id !== id),
      )
      return { previous }
    },
    onSuccess: () => {
      toast.success('Request rejected')
    },
    onError: (err, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(['requests-pending'], context.previous)
      toast.error(errMsg(err))
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['requests-pending'] })
      queryClient.invalidateQueries({ queryKey: ['requests-mine'] })
    },
  })

  const retry = useMutation({
    mutationFn: retryRequest,
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['requests-mine'] })
      toast.success(
        result.status === 'dispatched'
          ? 'Request sent to Lidarr'
          : 'Request approved, but Lidarr could not add it',
      )
    },
    onError: (err) => toast.error(errMsg(err)),
  })

  const retryFailed = useMutation({
    mutationFn: retryFailedRequests,
    onSuccess: ({ retrying }) => {
      queryClient.invalidateQueries({ queryKey: ['requests-mine'] })
      toast.success(
        `Retrying ${retrying} failed request${retrying === 1 ? '' : 's'} -- this can take a few minutes`,
      )
    },
    onError: (err) => toast.error(errMsg(err)),
  })

  // Optimistically drops the row from the current page's cache (not
  // backfilled from the next page -- a minor, acceptable gap vs. the cost of
  // re-paginating client-side) so the click feels instant; onSettled's
  // invalidate reconciles counts/pages with the server regardless.
  const dismissQueryKey = ['requests-mine', myRequestsTab, myRequestsPage] as const
  const dismiss = useMutation({
    mutationFn: dismissRequest,
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: dismissQueryKey })
      const previous = queryClient.getQueryData<{ items: RequestRecord[]; total: number }>(
        dismissQueryKey,
      )
      queryClient.setQueryData<{ items: RequestRecord[]; total: number }>(
        dismissQueryKey,
        (old) =>
          old && {
            items: old.items.filter((r) => r.id !== id),
            total: Math.max(0, old.total - 1),
          },
      )
      return { previous }
    },
    onError: (err, _id, context) => {
      if (context?.previous) queryClient.setQueryData(dismissQueryKey, context.previous)
      toast.error(errMsg(err))
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['requests-mine'] })
    },
  })

  const [showClearAllConfirm, setShowClearAllConfirm] = useState(false)
  const clearAll = useMutation({
    mutationFn: dismissAllInLibraryRequests,
    onSuccess: ({ count }) => {
      setMyRequestsPage(0)
      queryClient.invalidateQueries({ queryKey: ['requests-mine'] })
      toast.success(`Cleared ${count} items from Added to Library`)
    },
    onError: (err) => toast.error(errMsg(err)),
  })

  // Open Requests has no bulk clear -- each one is still in-flight, so
  // dismissing it (hiding it from this list, see dismissRequest's comment)
  // is individual-only and gated by its own confirmation. Added to Library
  // rows are already-fulfilled history, so their dismiss is instant, same as
  // clearing a single notification.
  const [confirmDismissId, setConfirmDismissId] = useState<number | null>(null)
  const requestToDismiss = myRequests.find((r) => r.id === confirmDismissId) ?? null

  const [rejectingId, setRejectingId] = useState<number | null>(null)
  const [rejectReason, setRejectReason] = useState('')

  function confirmReject(id: number) {
    reject.mutate({ id, reason: rejectReason.trim() || undefined })
    setRejectingId(null)
    setRejectReason('')
  }

  // Which bulk action (if any) is currently running -- approve/rejectAllPending
  // share this instead of each having their own flag so only the button
  // actually doing work shows the spinner+counter; the other stays a plain
  // disabled button instead of parroting the same progress.
  const [bulkAction, setBulkAction] = useState<'approve' | 'reject' | null>(null)
  const bulkActing = bulkAction !== null
  // Each request in a bulk run dispatches to Lidarr one at a time and can
  // take up to ~30s on a busy Lidarr instance -- "Approve All" on a full
  // queue could otherwise sit on a disabled, unchanging button for minutes
  // with zero indication it was still working rather than stuck/ignored.
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null)
  const [showApproveAllConfirm, setShowApproveAllConfirm] = useState(false)
  const [showRejectAllConfirm, setShowRejectAllConfirm] = useState(false)

  // No bulk endpoint exists for requests (unlike recommendations/bulk) -- the
  // pending queue is admin-reviewed one at a time by design, so this just
  // drives approve/rejectRequest sequentially and reports one summary toast
  // instead of firing the per-row mutations' individual success toasts.
  async function handleApproveAllPending() {
    const ids = (pendingQuery.data ?? []).map((r) => r.id)
    if (ids.length === 0) return
    setBulkAction('approve')
    setBulkProgress({ done: 0, total: ids.length })
    let succeeded = 0
    for (const id of ids) {
      try {
        await approveRequest(id)
        succeeded++
      } catch {
        // counted via succeeded < ids.length below
      } finally {
        setBulkProgress((prev) => (prev ? { ...prev, done: prev.done + 1 } : prev))
      }
    }
    setBulkAction(null)
    setBulkProgress(null)
    queryClient.invalidateQueries({ queryKey: ['requests-pending'] })
    queryClient.invalidateQueries({ queryKey: ['requests-mine'] })
    if (succeeded === ids.length) {
      toast.success(`Request approved and sent to Lidarr (${succeeded})`)
    } else {
      toast.error(`Approved ${succeeded} of ${ids.length} requests - some failed`)
    }
  }

  async function handleRejectAllPending() {
    const ids = (pendingQuery.data ?? []).map((r) => r.id)
    if (ids.length === 0) return
    setBulkAction('reject')
    setBulkProgress({ done: 0, total: ids.length })
    let succeeded = 0
    for (const id of ids) {
      try {
        await rejectRequest(id)
        succeeded++
      } catch {
        // counted via succeeded < ids.length below
      } finally {
        setBulkProgress((prev) => (prev ? { ...prev, done: prev.done + 1 } : prev))
      }
    }
    setBulkAction(null)
    setBulkProgress(null)
    queryClient.invalidateQueries({ queryKey: ['requests-pending'] })
    queryClient.invalidateQueries({ queryKey: ['requests-mine'] })
    if (succeeded === ids.length) {
      toast.success(`Request rejected (${succeeded})`)
    } else {
      toast.error(`Rejected ${succeeded} of ${ids.length} requests - some failed`)
    }
  }

  function requestAlbum(album: RequestSearchAlbum) {
    if (!album.artistMbid || !album.artistName) return
    submit.mutate({
      kind: 'album',
      artistMbid: album.artistMbid,
      artistName: album.artistName,
      releaseGroupMbid: album.releaseGroupMbid,
      albumTitle: album.albumTitle,
      coverUrl: album.coverUrl,
    })
  }

  function requestTrackAlbum(track: RequestSearchTrack) {
    submit.mutate({
      kind: 'album',
      artistMbid: track.artistMbid,
      artistName: track.artistName,
      releaseGroupMbid: track.releaseGroupMbid,
      albumTitle: track.albumTitle,
      coverUrl: track.coverUrl,
    })
  }

  const showResults = mode === 'artists' && deferredQuery.trim().length >= 2
  const isPending = query !== deferredQuery || searchQuery.isLoading
  const albums = searchQuery.data?.albums ?? []
  const artists = searchQuery.data?.artists ?? []

  const showTrackResults = mode === 'tracks' && submittedTrackQuery.trim().length >= 2
  const isTrackPending = trackSearchQuery.isFetching
  const tracks = trackSearchQuery.data?.tracks ?? []

  return (
    <div className="max-w-3xl mx-auto px-4 py-6 space-y-6">
      <div>
        <h1 className="text-2xl font-display tracking-wide text-text mb-1">{'Search & Request'}</h1>
        <p className="text-sm text-muted">
          Search for a specific artist or album to request from Lidarr
        </p>
      </div>

      <div className="flex items-center gap-1 bg-surface border border-border rounded-lg p-1 w-fit">
        <button
          type="button"
          onClick={() => setMode('artists')}
          className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
            mode === 'artists' ? 'bg-accent text-accent-fg' : 'text-muted hover:text-text'
          }`}
        >
          {'Artists & Albums'}
        </button>
        <button
          type="button"
          onClick={() => setMode('tracks')}
          className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
            mode === 'tracks' ? 'bg-accent text-accent-fg' : 'text-muted hover:text-text'
          }`}
        >
          Tracks
        </button>
      </div>

      {mode === 'artists' ? (
        <div className="relative">
          <SearchIcon
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none"
          />
          <input
            type="search"
            placeholder="Search albums and artists..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full pl-9 pr-4 py-2.5 bg-surface border border-border rounded-lg text-text placeholder:text-muted text-sm focus:outline-none focus:border-accent transition-colors"
          />
        </div>
      ) : (
        <div className="relative flex gap-2">
          <div className="relative flex-1">
            <SearchIcon
              size={16}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none"
            />
            <input
              type="search"
              placeholder="Search for a song title..."
              value={trackQuery}
              onChange={(e) => setTrackQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitTrackSearch()
              }}
              className="w-full pl-9 pr-4 py-2.5 bg-surface border border-border rounded-lg text-text placeholder:text-muted text-sm focus:outline-none focus:border-accent transition-colors"
            />
          </div>
          <Button onClick={submitTrackSearch} disabled={trackQuery.trim().length < 2}>
            Search
          </Button>
        </div>
      )}

      {mode === 'artists' && !showResults && (
        <p className="text-sm text-muted text-center pt-4">Type at least 2 characters to search</p>
      )}

      {mode === 'tracks' && !showTrackResults && (
        <p className="text-sm text-muted text-center pt-4">Type at least 2 characters to search</p>
      )}

      {showResults && isPending && (
        <div className="grid gap-2">
          {['req-skeleton-1', 'req-skeleton-2'].map((key) => (
            <div
              key={key}
              className="bg-surface border border-border rounded-lg p-3 h-16 animate-pulse"
            />
          ))}
        </div>
      )}

      {showResults && !isPending && searchQuery.isError && (
        <p className="text-sm text-reject text-center pt-4">Search failed - try again</p>
      )}

      {showResults && !isPending && albums.length === 0 && artists.length === 0 && (
        <p className="text-sm text-muted text-center pt-4">No matches found</p>
      )}

      {showResults && !isPending && albums.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-sm font-semibold text-muted uppercase tracking-wide">Albums</h2>
          {albums.map((album) => (
            <div
              key={album.releaseGroupMbid}
              className="flex items-center gap-3 p-3 rounded-lg border border-border bg-surface"
            >
              <Link
                to={`/requests/album/${album.releaseGroupMbid}`}
                className="flex items-center gap-3 flex-1 min-w-0"
              >
                <CoverThumb
                  coverUrl={album.coverUrl}
                  releaseGroupMbid={album.releaseGroupMbid}
                  shape="square"
                  placeholderIcon={Disc3}
                />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-text truncate hover:underline">
                    {album.albumTitle}
                  </p>
                  <p className="text-xs text-muted truncate">{album.artistName}</p>
                </div>
              </Link>
              {album.alreadyOwned ? (
                <span className="text-xs text-approve px-2 py-1 whitespace-nowrap">
                  Already in your library
                </span>
              ) : (
                <Button
                  size="icon"
                  variant="outline"
                  onClick={() => requestAlbum(album)}
                  disabled={
                    (submit.isPending &&
                      submit.variables?.releaseGroupMbid === album.releaseGroupMbid) ||
                    !album.artistMbid
                  }
                  aria-label="Request"
                  title="Request"
                >
                  {justRequested === album.releaseGroupMbid ? (
                    <Check size={16} className="text-approve" />
                  ) : submit.isPending &&
                    submit.variables?.releaseGroupMbid === album.releaseGroupMbid ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : (
                    <ListPlus size={16} />
                  )}
                </Button>
              )}
            </div>
          ))}
        </div>
      )}

      {showResults && !isPending && artists.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-sm font-semibold text-muted uppercase tracking-wide">Artists</h2>
          {artists.map((artist) => (
            <Link
              key={artist.artistMbid}
              to={`/requests/artist/${artist.artistMbid}`}
              className="flex items-center gap-3 p-3 rounded-lg border border-border bg-surface hover:border-accent/40 transition-colors"
            >
              <CoverThumb
                coverUrl={artist.coverUrl}
                releaseGroupMbid={null}
                shape="circle"
                placeholderIcon={UserIcon}
              />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-text truncate">{artist.artistName}</p>
                {artist.genres.length > 0 && (
                  <p className="text-xs text-muted truncate">
                    {artist.genres.slice(0, 3).join(', ')}
                  </p>
                )}
                <LibraryAlbumCoverageBadge artistMbid={artist.artistMbid} />
              </div>
            </Link>
          ))}
        </div>
      )}

      {showTrackResults && isTrackPending && (
        <div className="grid gap-2">
          {['track-skeleton-1', 'track-skeleton-2'].map((key) => (
            <div
              key={key}
              className="bg-surface border border-border rounded-lg p-3 h-16 animate-pulse"
            />
          ))}
        </div>
      )}

      {showTrackResults && !isTrackPending && trackSearchQuery.isError && (
        <p className="text-sm text-reject text-center pt-4">Search failed - try again</p>
      )}

      {showTrackResults && !isTrackPending && !trackSearchQuery.isError && tracks.length === 0 && (
        <p className="text-sm text-muted text-center pt-4">No matches found</p>
      )}

      {showTrackResults && !isTrackPending && tracks.length > 0 && (
        <div className="space-y-2">
          {tracks.map((track) => (
            <div
              key={track.releaseGroupMbid}
              className="flex items-center gap-3 p-3 rounded-lg border border-border bg-surface"
            >
              <Link
                to={`/requests/album/${track.releaseGroupMbid}`}
                className="flex items-center gap-3 flex-1 min-w-0"
              >
                <CoverThumb
                  coverUrl={track.coverUrl}
                  releaseGroupMbid={track.releaseGroupMbid}
                  shape="square"
                  placeholderIcon={Music}
                />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-text truncate">{track.trackName}</p>
                  <p className="text-xs text-muted truncate">
                    {`Track found on ${track.albumTitle}`} · {track.artistName}
                  </p>
                </div>
              </Link>
              {track.inLidarr ? (
                <span className="text-xs text-approve px-2 py-1 whitespace-nowrap">
                  Already in Lidarr
                </span>
              ) : (
                <Button
                  size="icon"
                  variant="outline"
                  onClick={() => requestTrackAlbum(track)}
                  disabled={
                    submit.isPending &&
                    submit.variables?.releaseGroupMbid === track.releaseGroupMbid
                  }
                  aria-label="Request"
                  title="Request"
                >
                  {justRequested === track.releaseGroupMbid ? (
                    <Check size={16} className="text-approve" />
                  ) : submit.isPending &&
                    submit.variables?.releaseGroupMbid === track.releaseGroupMbid ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : (
                    <ListPlus size={16} />
                  )}
                </Button>
              )}
            </div>
          ))}
        </div>
      )}

      {currentUser?.isAdmin && (pendingQuery.data?.length ?? 0) > 0 && (
        <Card>
          <CardContent className="p-4 space-y-3">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <h2 className="text-sm font-semibold text-text">
                Pending approval ({pendingQuery.data?.length})
              </h2>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="text-approve border-approve/40 hover:bg-approve/10"
                  onClick={() => setShowApproveAllConfirm(true)}
                  disabled={bulkActing || approve.isPending || reject.isPending}
                >
                  {bulkAction === 'approve' && bulkProgress ? (
                    <>
                      <Loader2 size={14} className="animate-spin" />
                      {bulkProgress.done}/{bulkProgress.total}
                    </>
                  ) : (
                    'Approve All'
                  )}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="text-reject border-reject/40 hover:bg-reject/10"
                  onClick={() => setShowRejectAllConfirm(true)}
                  disabled={bulkActing || approve.isPending || reject.isPending}
                >
                  {bulkAction === 'reject' && bulkProgress ? (
                    <>
                      <Loader2 size={14} className="animate-spin" />
                      {bulkProgress.done}/{bulkProgress.total}
                    </>
                  ) : (
                    'Reject All'
                  )}
                </Button>
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {pendingQuery.data?.map((req: PendingRequestRecord) => (
                <div key={req.id} className="rounded-lg border border-border p-3 space-y-2">
                  <div className="flex items-center gap-3">
                    <RequestThumb req={req} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-text truncate">
                        {req.kind === 'album' ? req.albumTitle : req.artistName}
                      </p>
                      <p className="text-xs text-muted truncate">
                        {req.kind === 'album' ? req.artistName : 'whole discography'}
                      </p>
                      <p className="text-xs text-muted truncate">
                        requested by {req.requestedByUsername}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => approve.mutate(req.id)}
                      disabled={bulkActing || approve.isPending || reject.isPending}
                      aria-label="Sent to Lidarr"
                    >
                      {approve.isPending && approve.variables === req.id ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : (
                        <Check size={14} />
                      )}
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() =>
                        setRejectingId((current) => (current === req.id ? null : req.id))
                      }
                      disabled={bulkActing || approve.isPending || reject.isPending}
                      aria-label="Rejected"
                    >
                      {reject.isPending && reject.variables?.id === req.id ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : (
                        <X size={14} />
                      )}
                    </Button>
                  </div>
                  {rejectingId === req.id && (
                    <div className="flex items-center gap-2 pl-[3.75rem]">
                      <input
                        type="text"
                        value={rejectReason}
                        onChange={(e) => setRejectReason(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') confirmReject(req.id)
                          if (e.key === 'Escape') setRejectingId(null)
                        }}
                        placeholder="Reason (optional)"
                        className="flex-1 min-w-0 px-2 py-1 text-xs bg-bg border border-border rounded text-text placeholder:text-muted focus:outline-none focus:border-accent"
                      />
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => confirmReject(req.id)}
                        disabled={reject.isPending}
                      >
                        Confirm reject
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1 bg-surface border border-border rounded-lg p-1 w-fit min-w-0">
            <button
              type="button"
              onClick={() => selectMyRequestsTab('open')}
              className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                myRequestsTab === 'open' ? 'bg-accent text-accent-fg' : 'text-muted hover:text-text'
              }`}
            >
              Open Requests
            </button>
            <button
              type="button"
              onClick={() => selectMyRequestsTab('in_library')}
              className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                myRequestsTab === 'in_library'
                  ? 'bg-accent text-accent-fg'
                  : 'text-muted hover:text-text'
              }`}
            >
              Added to Library
            </button>
          </div>
          {myRequestsTab === 'open' &&
            ((myRequestsQuery.data?.failedCount ?? 0) > 0 || retryingFailed) && (
              // Icon + failed count on phones so it stays on the tabs' row
              // instead of wrapping onto a line of its own; full label from sm up.
              <Button
                size="sm"
                variant="outline"
                className="shrink-0"
                onClick={() => retryFailed.mutate()}
                disabled={retryFailed.isPending || retryingFailed}
                aria-label={
                  retryingFailed
                    ? 'Retrying failed requests'
                    : `Retry ${myRequestsQuery.data?.failedCount ?? 0} failed`
                }
                title={retryingFailed ? 'Retrying failed requests...' : 'Retry failed requests'}
              >
                {retryFailed.isPending || retryingFailed ? (
                  <>
                    <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                    <span className="hidden sm:inline">Retrying...</span>
                  </>
                ) : (
                  <>
                    <RefreshCw size={14} aria-hidden="true" />
                    <span className="hidden sm:inline">Retry Failed</span>
                    <span className="sm:hidden tabular-nums">
                      {myRequestsQuery.data?.failedCount}
                    </span>
                  </>
                )}
              </Button>
            )}
          {myRequestsTab === 'in_library' && (myRequestsQuery.data?.total ?? 0) > 0 && (
            <Button
              size="sm"
              variant="outline"
              className="shrink-0 text-reject border-reject/40 hover:bg-reject/10"
              onClick={() => setShowClearAllConfirm(true)}
              disabled={clearAll.isPending}
            >
              {clearAll.isPending ? <Loader2 size={14} className="animate-spin" /> : 'Clear All'}
            </Button>
          )}
        </div>
        {myRequests.length === 0 && (
          <p className="text-sm text-muted">
            {myRequestsTab === 'open'
              ? "You don't have any open requests."
              : "Nothing you've requested has arrived in your library yet."}
          </p>
        )}
        {myRequests.map((req) => (
          <RequestRow
            key={req.id}
            req={req}
            onRetry={() => retry.mutate(req.id)}
            retrying={retry.isPending && retry.variables === req.id}
            onDismiss={
              myRequestsTab === 'open'
                ? () => setConfirmDismissId(req.id)
                : () => dismiss.mutate(req.id)
            }
            dismissing={dismiss.isPending && dismiss.variables === req.id}
          />
        ))}
      </div>

      <PagerBar
        page={myRequestsPage}
        totalPages={myRequestsTotalPages}
        onPageChange={setMyRequestsPage}
      />

      {showApproveAllConfirm && (
        <ConfirmDialog
          title="Approve all pending requests?"
          message={`This approves all ${pendingQuery.data?.length ?? 0} pending requests and sends them to Lidarr. This cannot be undone in bulk.`}
          confirmLabel="Approve All"
          destructive={false}
          onConfirm={() => {
            setShowApproveAllConfirm(false)
            handleApproveAllPending()
          }}
          onCancel={() => setShowApproveAllConfirm(false)}
        />
      )}
      {showRejectAllConfirm && (
        <ConfirmDialog
          title="Reject all pending requests?"
          message={`This rejects all ${pendingQuery.data?.length ?? 0} pending requests. This cannot be undone in bulk.`}
          confirmLabel="Reject All"
          onConfirm={() => {
            setShowRejectAllConfirm(false)
            handleRejectAllPending()
          }}
          onCancel={() => setShowRejectAllConfirm(false)}
        />
      )}
      {showClearAllConfirm && (
        <ConfirmDialog
          title="Clear all from Added to Library?"
          message={`This removes all ${myRequestsQuery.data?.total ?? 0} items from this list. This cannot be undone.`}
          confirmLabel="Clear All"
          onConfirm={() => {
            setShowClearAllConfirm(false)
            clearAll.mutate()
          }}
          onCancel={() => setShowClearAllConfirm(false)}
        />
      )}
      {requestToDismiss && (
        <ConfirmDialog
          title={`Dismiss "${
            requestToDismiss.kind === 'album'
              ? (requestToDismiss.albumTitle ?? requestToDismiss.artistName)
              : requestToDismiss.artistName
          }"?`}
          message={
            !hasDispatchedTarget(requestToDismiss)
              ? 'This removes it from your Open Requests list.'
              : requestToDismiss.kind === 'album'
                ? "This un-monitors the album in Lidarr so it stops searching for it. Anything already downloaded isn't affected."
                : 'This removes the artist from Lidarr and stops it searching for the rest of the discography. Anything already downloaded stays on disk.'
          }
          confirmLabel="Dismiss"
          onConfirm={() => {
            dismiss.mutate(requestToDismiss.id)
            setConfirmDismissId(null)
          }}
          onCancel={() => setConfirmDismissId(null)}
        />
      )}
    </div>
  )
}
