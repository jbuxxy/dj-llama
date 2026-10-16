import { useQuery } from '@tanstack/react-query'
import { ChevronDown, Loader2, Music, Pause, Play } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useClickOutside } from '../hooks/use-click-outside'
import { getAlbumPreview, getArtistTopTracks } from '../lib/api'
import { GENRE_COLORS } from '../lib/constants'
import { usePreviewContext } from '../lib/preview-context'
import { readStoredVolume } from '../lib/preview-volume'
import { cn, hueFromName } from '../lib/utils'
import { ArtistEnrichmentPanel } from './artist-enrichment-panel'
import { ArtistThumb } from './artist-thumb'
import { StreamingLinks } from './streaming-links'
import { Button } from './ui/button'
import { WhyRecommendedButton } from './why-recommended'

export type Recommendation = {
  id: number
  kind: 'artist' | 'album'
  score: number
  status: string
  aiReasoning: string | null
  sources: Record<string, number> | null
  lidarrError: string | null
  targetActions?: Record<string, { status?: string; error?: string } | null> | null
  recommendedReleaseGroupId: string | null
  recommendedReleaseGroupTitle: string | null
  libraryConfirmedAt?: string | null
  artist: {
    id: number
    name: string
    mbid: string
    disambiguation: string | null
    genres: string[] | null
    tags: string[] | null
    imageUrl: string | null
    logoUrl?: string | null
    streamingUrls: Record<string, string> | null
    beginYear?: number | null
    endYear?: number | null
  }
}

type RecommendationCardProps = {
  recommendation: Recommendation
  onApprove: (id: number) => void
  onReject: (id: number) => void
  onClick?: (id: number) => void
  isSelected?: boolean
  expanded?: boolean
  onRetry?: (id: number) => void
  onRetryFailed?: (id: number, failedTargetIds: string[]) => void
  bulkMode?: boolean
  isChecked?: boolean
  onToggleSelect?: (id: number) => void
  warmStatus?: 'warm' | 'warming' | 'unknown'
  approveNode?: React.ReactNode
  targets?: Array<{ id: number; type: string; name: string }>
  onApproveToTarget?: (recId: number, targetId: string) => void
  // 'row' renders a single-line compact row (small thumb, name, score,
  // approve/reject) instead of the full tile while collapsed -- used by
  // Discover's List view so it's actually visually distinct from Grid
  // instead of just being the same card forced to one column. Once
  // expanded, row and card look identical (both show the full detail view).
  layout?: 'card' | 'row'
  // Approve/reject/retry all dispatch to Lidarr and can take several
  // seconds -- true while this recommendation has an action in flight, so
  // ActionButtons/StatusBadge can show a spinner instead of going silent.
  loading?: boolean
}

function StatusBadge({
  status,
  lidarrError,
  targetActions,
  onRetry,
  onRetryFailed,
  id,
  libraryConfirmedAt,
  retrying,
}: {
  status: string
  lidarrError: string | null
  targetActions?: Record<string, { status?: string; error?: string } | null> | null
  onRetry?: (id: number) => void
  onRetryFailed?: (id: number, failedTargetIds: string[]) => void
  id: number
  libraryConfirmedAt?: string | null
  retrying?: boolean
}) {
  const failedTargetIds = Object.entries(targetActions ?? {})
    .filter(([, action]) => action?.status === 'failed')
    .map(([targetId]) => targetId)
  const failedTargetError = Object.values(targetActions ?? {}).find(
    (action) =>
      action?.status === 'failed' && typeof action.error === 'string' && action.error.length > 0,
  )?.error

  if (status === 'added_to_lidarr') {
    return (
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-approve font-medium">Added to Lidarr</span>
        {libraryConfirmedAt && (
          <span className="text-xs font-medium px-1.5 py-0.5 rounded-full bg-approve/15 text-approve">
            In Library
          </span>
        )}
        {failedTargetError && (
          <span className="text-xs text-muted truncate max-w-[200px]" title={failedTargetError}>
            {failedTargetError}
          </span>
        )}
        {onRetryFailed && failedTargetIds.length > 0 && (
          <button
            type="button"
            disabled={retrying}
            onClick={(e) => {
              e.stopPropagation()
              onRetryFailed(id, failedTargetIds)
            }}
            className="text-xs text-accent underline inline-flex items-center gap-1 disabled:opacity-50 disabled:no-underline"
          >
            {retrying && <Loader2 size={12} className="animate-spin" />}
            Retry failed
          </button>
        )}
      </div>
    )
  }
  if (status === 'rejected') {
    return <span className="text-xs text-reject font-medium">Rejected</span>
  }
  if (status === 'add_failed') {
    const errorMessage = lidarrError ?? failedTargetError
    return (
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-reject font-medium">Add Failed</span>
        {errorMessage && (
          <span className="text-xs text-muted truncate max-w-[200px]" title={errorMessage}>
            {errorMessage}
          </span>
        )}
        {onRetry && (
          <button
            type="button"
            disabled={retrying}
            onClick={(e) => {
              e.stopPropagation()
              onRetry(id)
            }}
            className="text-xs text-accent underline inline-flex items-center gap-1 disabled:opacity-50 disabled:no-underline"
          >
            {retrying && <Loader2 size={12} className="animate-spin" />}
            Retry
          </button>
        )}
      </div>
    )
  }
  return null
}

function GenrePills({
  genres,
  max = 4,
  compact = false,
}: {
  genres: string[] | null
  max?: number
  compact?: boolean
}) {
  if (!genres || genres.length === 0) return null
  const shown = genres.slice(0, max)
  return (
    <div className={cn('flex gap-1', compact ? 'overflow-hidden' : 'flex-wrap')}>
      {shown.map((g, i) => (
        <span
          key={g}
          className={cn(
            'text-micro px-1.5 py-0.5 rounded-full shrink-0',
            GENRE_COLORS[i % GENRE_COLORS.length],
          )}
        >
          {g}
        </span>
      ))}
      {genres.length > max && (
        <span className="text-micro px-1.5 py-0.5 rounded-full bg-surface text-muted shrink-0">
          +{genres.length - max}
        </span>
      )}
    </div>
  )
}

import { canApproveArtistToTarget, TargetIcon, targetActionLabel } from './target-utils'

function ApproveDropdown({
  recId,
  targets,
  onApprove,
  onApproveToTarget,
  fullWidth,
}: {
  recId: number
  targets: Array<{ id: number; type: string; name: string }>
  onApprove: (id: number) => void
  onApproveToTarget?: (recId: number, targetId: string) => void
  fullWidth?: boolean
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useClickOutside(ref, () => setOpen(false), open)
  const actionableTargets = targets.filter((target) => canApproveArtistToTarget(target.type))

  return (
    <div ref={ref} className={cn('relative', fullWidth && 'w-full')}>
      <div className="flex">
        <Button
          size="sm"
          variant="outline"
          className={cn(
            'text-approve border-approve/40 hover:bg-approve/10 hover:text-approve rounded-r-none',
            fullWidth && 'flex-1',
          )}
          onClick={(e) => {
            e.stopPropagation()
            onApprove(recId)
          }}
        >
          Approve
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="text-approve border-approve/40 hover:bg-approve/10 hover:text-approve rounded-l-none border-l-0 px-1.5"
          onClick={(e) => {
            e.stopPropagation()
            setOpen(!open)
          }}
        >
          <ChevronDown size={14} />
        </Button>
      </div>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-10 rounded-lg border border-border bg-surface shadow-lg py-1 min-w-[180px]">
          {actionableTargets.map((target) => (
            <button
              key={target.id}
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onApproveToTarget?.(recId, `${target.type}-${target.id}`)
                setOpen(false)
              }}
              className="w-full text-left px-3 py-1.5 text-sm text-text hover:bg-accent/10 flex items-center gap-2"
            >
              <TargetIcon type={target.type} />
              {targetActionLabel(target.type, target.name)}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function ActionButtons({
  rec,
  bulkMode,
  isPending,
  isApproved,
  onApprove,
  onReject,
  approveNode,
  targets,
  onApproveToTarget,
  loading,
  fullWidth,
}: {
  rec: Recommendation
  bulkMode: boolean
  isPending: boolean
  isApproved: boolean
  onApprove: (id: number) => void
  onReject: (id: number) => void
  approveNode?: React.ReactNode
  targets?: Array<{ id: number; type: string; name: string }>
  onApproveToTarget?: (recId: number, targetId: string) => void
  loading?: boolean
  /** Stretch the row and its buttons to fill the available width (collapsed card layout only). */
  fullWidth?: boolean
}) {
  if (bulkMode) return null
  // Approve/reject dispatch to Lidarr and can take several seconds -- without
  // this, onApprove/onReject just get swapped for no-ops while acting (see
  // discover.tsx), so a click during that window looked identical to a click
  // that did nothing at all. Short-circuit every status branch below with a
  // single spinner so an in-flight action is always visibly in flight.
  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted h-9">
        <Loader2 size={14} className="animate-spin" />
      </div>
    )
  }
  const actionableTargets = (targets ?? []).filter((target) =>
    canApproveArtistToTarget(target.type),
  )
  function stop(e: React.MouseEvent | React.KeyboardEvent) {
    e.stopPropagation()
  }

  if (isPending) {
    return (
      <div className={fullWidth ? 'grid grid-cols-2 gap-2 w-full' : 'flex gap-2'}>
        <Button
          size="sm"
          variant="outline"
          className={cn(
            'text-reject border-reject/40 hover:bg-reject/10 hover:text-reject',
            fullWidth && 'w-full',
          )}
          onClick={(e) => {
            stop(e)
            onReject(rec.id)
          }}
        >
          Reject
        </Button>
        {approveNode ??
          (actionableTargets.length > 1 ? (
            <ApproveDropdown
              recId={rec.id}
              targets={actionableTargets}
              onApprove={onApprove}
              onApproveToTarget={onApproveToTarget}
              fullWidth={fullWidth}
            />
          ) : (
            <Button
              size="sm"
              variant="outline"
              className={cn(
                'text-approve border-approve/40 hover:bg-approve/10 hover:text-approve',
                fullWidth && 'w-full',
              )}
              onClick={(e) => {
                stop(e)
                onApprove(rec.id)
              }}
            >
              Approve
            </Button>
          ))}
      </div>
    )
  }
  if (isApproved) {
    return (
      <div className={fullWidth ? 'w-full' : 'flex gap-2'}>
        <Button
          size="sm"
          variant="outline"
          className={cn(
            'text-reject border-reject/40 hover:bg-reject/10 hover:text-reject',
            fullWidth && 'w-full',
          )}
          onClick={(e) => {
            stop(e)
            onReject(rec.id)
          }}
        >
          Reject
        </Button>
      </div>
    )
  }
  if (rec.status === 'rejected') {
    return (
      <div className={fullWidth ? 'w-full' : 'flex gap-2'}>
        <Button
          size="sm"
          variant="outline"
          className={cn(
            'text-muted border-border/60 hover:bg-surface hover:text-text',
            fullWidth && 'w-full',
          )}
          onClick={(e) => {
            stop(e)
            onApprove(rec.id)
          }}
        >
          Restore
        </Button>
      </div>
    )
  }
  return null
}

function TopTracks({ artistId, albumTitle }: { artistId: number; albumTitle?: string }) {
  const preview = usePreviewContext()
  const { data, isLoading } = useQuery({
    queryKey: ['top-tracks', artistId, albumTitle],
    queryFn: () => getArtistTopTracks(artistId, albumTitle),
    staleTime: 5 * 60 * 1000,
  })

  const [playingUrl, setPlayingUrl] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const lastGlobalPlayIdRef = useRef(preview.globalPlayId)

  function handlePlay(previewUrl: string) {
    if (playingUrl === previewUrl) {
      audioRef.current?.pause()
      setPlayingUrl(null)
      return
    }
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current.onended = null
      audioRef.current.onerror = null
      audioRef.current.src = ''
    }
    // Stop global preview when playing a track
    preview.stop()
    const params = new URLSearchParams({ url: previewUrl })
    const proxyUrl = `/api/v1/preview/audio?${params.toString()}`
    const audio = new Audio(proxyUrl)
    audio.volume = readStoredVolume()
    audioRef.current = audio
    audio.onended = () => setPlayingUrl(null)
    audio.onerror = () => {
      setPlayingUrl(null)
      toast.error('Audio preview not available')
    }
    audio.play().catch(() => {
      setPlayingUrl(null)
      toast.error('Audio preview not available')
    })
    setPlayingUrl(previewUrl)
  }

  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause()
        audioRef.current.onended = null
        audioRef.current.onerror = null
        audioRef.current.src = ''
      }
    }
  }, [])

  // Stop local audio when global preview starts
  useEffect(() => {
    if (preview.globalPlayId === lastGlobalPlayIdRef.current) return
    lastGlobalPlayIdRef.current = preview.globalPlayId
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current.src = ''
      setPlayingUrl(null)
    }
  }, [preview.globalPlayId])

  const tracks = data?.tracks ?? []

  if (isLoading) {
    return (
      <div className="space-y-2 mt-3">
        <div className="text-xs font-medium text-muted">
          {albumTitle ? 'Top Tracks (this album)' : 'Top Tracks'}
        </div>
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-4 bg-surface rounded animate-pulse w-3/4" />
        ))}
      </div>
    )
  }

  if (tracks.length === 0) return null

  return (
    <div className="space-y-1.5 mt-3">
      <div className="text-xs font-medium text-muted">Top Tracks</div>
      {tracks.map((track) => (
        <div key={track.name} className="flex items-center gap-2 text-sm">
          {track.previewUrl ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                if (track.previewUrl) handlePlay(track.previewUrl)
              }}
              className="text-accent hover:text-accent/80 transition-colors shrink-0 w-4 text-center"
              aria-label={playingUrl === track.previewUrl ? 'Stop preview' : 'Play preview'}
            >
              {playingUrl === track.previewUrl ? (
                <Pause className="w-3 h-3" />
              ) : (
                <Play className="w-3 h-3" />
              )}
            </button>
          ) : (
            <span className="text-muted shrink-0 w-4 text-center">
              <Music className="w-3 h-3" />
            </span>
          )}
          <span className="text-text truncate">{track.name}</span>
          {track.durationMs != null && (
            <span className="text-muted text-xs ml-auto shrink-0">
              {Math.floor(track.durationMs / 60000)}:
              {String(Math.floor((track.durationMs % 60000) / 1000)).padStart(2, '0')}
            </span>
          )}
        </div>
      ))}
    </div>
  )
}

// Full-bleed banner across the top of the card, styled after Today's Pick:
// album cover (falling back to the artist photo, then a name-derived hue),
// big title + smaller artist line bottom-left, artist logo bottom-right.
function CardHero({
  name,
  imageUrl,
  fallbackImageUrl,
  logoUrl,
  title,
  subtitle,
  topLeft,
  topRight,
}: {
  name: string
  imageUrl: string | null
  fallbackImageUrl?: string | null
  logoUrl?: string | null
  title: string
  subtitle?: string | null
  topLeft?: React.ReactNode
  topRight?: React.ReactNode
}) {
  const [primaryError, setPrimaryError] = useState(false)
  const [fallbackError, setFallbackError] = useState(false)
  const [logoError, setLogoError] = useState(false)
  const src =
    imageUrl && !primaryError
      ? imageUrl
      : fallbackImageUrl && !fallbackError
        ? fallbackImageUrl
        : null
  const showLogo = !!logoUrl && !logoError

  return (
    <div
      className="relative h-52 sm:h-56 rounded-t-lg overflow-hidden shrink-0"
      style={src ? undefined : { background: `hsl(${hueFromName(name)}, 40%, 35%)` }}
    >
      {src && (
        <img
          src={src}
          alt={name}
          loading="lazy"
          decoding="async"
          className="absolute inset-0 w-full h-full object-cover"
          onError={() => {
            if (src === imageUrl) setPrimaryError(true)
            else setFallbackError(true)
          }}
        />
      )}
      <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/25 to-transparent" />

      {topLeft && <div className="absolute top-3 left-3">{topLeft}</div>}
      {topRight && <div className="absolute top-3 right-3">{topRight}</div>}

      <div className="absolute bottom-3 left-4 right-4 flex items-end justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-white font-bold text-xl leading-tight drop-shadow-lg line-clamp-2">
            {title}
          </h3>
          {subtitle && (
            <p className="text-white/75 text-sm truncate drop-shadow-lg mt-0.5">{subtitle}</p>
          )}
        </div>
        {showLogo && (
          <img
            src={logoUrl}
            alt=""
            aria-hidden="true"
            className="h-14 max-w-[40%] object-contain object-right shrink-0 drop-shadow-[0_2px_6px_rgba(0,0,0,0.9)]"
            onError={() => setLogoError(true)}
          />
        )}
      </div>
    </div>
  )
}

export function RecommendationCard({
  recommendation: rec,
  onApprove,
  onReject,
  onClick,
  isSelected = false,
  expanded = false,
  onRetry,
  onRetryFailed,
  bulkMode = false,
  isChecked = false,
  onToggleSelect,
  warmStatus,
  approveNode,
  targets,
  onApproveToTarget,
  layout = 'card',
  loading,
}: RecommendationCardProps) {
  const isPending = rec.status === 'pending' || rec.status === 'approved'
  const isActed = rec.status !== 'pending'
  const isApproved =
    rec.status === 'added_to_lidarr' || rec.status === 'add_failed' || rec.status === 'approved'
  // Album-kind recs are a specific release-group pick -- show its actual
  // cover art rather than the artist photo, falling back to the artist photo
  // (then ArtistThumb's letter placeholder) if Cover Art Archive has nothing
  // for that release group. Same convention as todays-pick.tsx / recently-approved.tsx.
  const albumCoverUrl =
    rec.kind === 'album' && rec.recommendedReleaseGroupId
      ? `https://coverartarchive.org/release-group/${rec.recommendedReleaseGroupId}/front-500`
      : null
  const thumbImageUrl = albumCoverUrl ?? rec.artist.imageUrl
  const thumbFallbackUrl = albumCoverUrl ? rec.artist.imageUrl : undefined

  // Only needed for the expanded embed on album-kind recs -- fetched lazily
  // since it costs a Spotify scraper round trip (see getAlbumPreview).
  const { data: albumPreview } = useQuery({
    queryKey: ['album-preview', rec.artist.id, rec.recommendedReleaseGroupTitle],
    queryFn: () =>
      // biome-ignore lint/style/noNonNullAssertion: guarded by enabled
      getAlbumPreview(rec.artist.id, rec.recommendedReleaseGroupTitle!),
    enabled: expanded && rec.kind === 'album' && !!rec.recommendedReleaseGroupTitle,
    staleTime: 60 * 60_000,
  })

  function handleCardClick() {
    if (bulkMode) {
      onToggleSelect?.(rec.id)
    } else {
      onClick?.(rec.id)
    }
  }

  return (
    <div className="relative group">
      {bulkMode && (
        <button
          type="button"
          className="absolute top-2 left-2 z-20 bg-transparent border-none p-0"
          onClick={(e) => {
            e.stopPropagation()
            onToggleSelect?.(rec.id)
          }}
        >
          <input
            type="checkbox"
            checked={isChecked}
            onChange={() => onToggleSelect?.(rec.id)}
            className="w-4 h-4 accent-accent cursor-pointer"
            aria-label={`Select ${rec.artist.name}`}
            tabIndex={-1}
          />
        </button>
      )}
      {/* Hover edge buttons - desktop only, pending cards, not when expanded */}
      {!bulkMode && isPending && !expanded && (
        <>
          <button
            type="button"
            className="hidden md:group-hover:flex absolute left-0 top-0 bottom-0 z-10 items-center justify-center w-10 -translate-x-1/2 opacity-0 group-hover:opacity-100 transition-all duration-150 bg-transparent border-none p-0"
            onClick={(e) => {
              e.stopPropagation()
              onReject(rec.id)
            }}
            aria-label="Reject"
          >
            <span className="w-8 h-8 rounded-full bg-surface border border-reject/40 text-reject hover:bg-reject/30 transition-colors flex items-center justify-center shadow-lg">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2.5}
                strokeLinecap="round"
                strokeLinejoin="round"
                className="w-4 h-4"
                aria-hidden="true"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </span>
          </button>
          <button
            type="button"
            className="hidden md:group-hover:flex absolute right-0 top-0 bottom-0 z-10 items-center justify-center w-10 translate-x-1/2 opacity-0 group-hover:opacity-100 transition-all duration-150 bg-transparent border-none p-0"
            onClick={(e) => {
              e.stopPropagation()
              onApprove(rec.id)
            }}
            aria-label="Approve"
          >
            <span className="w-8 h-8 rounded-full bg-surface border border-approve/40 text-approve hover:bg-approve/30 transition-colors flex items-center justify-center shadow-lg">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2.5}
                strokeLinecap="round"
                strokeLinejoin="round"
                className="w-4 h-4"
                aria-hidden="true"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </span>
          </button>
        </>
      )}
      {/* biome-ignore lint/a11y/useSemanticElements: intentional div[role=button] - nesting <button> inside <button> is invalid HTML */}
      <div
        role="button"
        tabIndex={0}
        data-testid="rec-card-button"
        className={cn(
          'bg-surface border rounded-lg transition-all cursor-pointer w-full text-left flex flex-col relative',
          bulkMode && isChecked
            ? 'border-accent bg-accent/5'
            : isSelected
              ? 'border-accent'
              : 'border-border hover:border-border/80',
        )}
        onClick={handleCardClick}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            handleCardClick()
          }
        }}
      >
        {/* Single-line row layout (List view, collapsed only -- expands into the same detail view as the card layout below) */}
        {layout === 'row' && !expanded ? (
          <div className="p-2.5 flex items-center gap-3">
            <ArtistThumb
              name={rec.artist.name}
              imageUrl={thumbImageUrl}
              fallbackImageUrl={thumbFallbackUrl}
              size={8}
            />
            <div className="flex-1 min-w-0">
              <div className="flex items-baseline gap-2 min-w-0">
                <span className="text-sm font-medium text-text truncate">
                  {rec.kind === 'album'
                    ? (rec.recommendedReleaseGroupTitle ?? rec.artist.name)
                    : rec.artist.name}
                </span>
                {rec.kind === 'album' && (
                  <span className="text-xs text-muted truncate shrink-0 hidden sm:inline">
                    {rec.artist.name}
                  </span>
                )}
              </div>
              {isActed && (
                <StatusBadge
                  status={rec.status}
                  lidarrError={rec.lidarrError}
                  targetActions={rec.targetActions}
                  onRetry={onRetry}
                  onRetryFailed={onRetryFailed}
                  id={rec.id}
                  libraryConfirmedAt={rec.libraryConfirmedAt}
                  retrying={loading}
                />
              )}
            </div>
            <WhyRecommendedButton reasoning={rec.aiReasoning} sources={rec.sources} />
            <div className="shrink-0">
              <ActionButtons
                rec={rec}
                bulkMode={bulkMode}
                isPending={isPending}
                isApproved={isApproved}
                onApprove={onApprove}
                onReject={onReject}
                approveNode={approveNode}
                targets={targets}
                onApproveToTarget={onApproveToTarget}
                loading={loading}
              />
            </div>
          </div>
        ) : (
          <div className="flex flex-col flex-1">
            <CardHero
              name={rec.artist.name}
              imageUrl={thumbImageUrl}
              fallbackImageUrl={thumbFallbackUrl}
              logoUrl={rec.artist.logoUrl}
              title={
                rec.kind === 'album'
                  ? (rec.recommendedReleaseGroupTitle ?? rec.artist.name)
                  : rec.artist.name
              }
              subtitle={rec.kind === 'album' ? rec.artist.name : rec.artist.disambiguation}
              topLeft={
                warmStatus === 'warm' ? (
                  <span
                    className="block w-2 h-2 rounded-full bg-approve"
                    title="Metadata cached"
                    role="img"
                    aria-label="Metadata cached"
                  />
                ) : warmStatus === 'warming' ? (
                  <span
                    className="block w-2 h-2 rounded-full bg-warning animate-pulse"
                    title="Warming cache..."
                    role="img"
                    aria-label="Warming cache..."
                  />
                ) : null
              }
              topRight={
                <WhyRecommendedButton
                  reasoning={rec.aiReasoning}
                  sources={rec.sources}
                  variant="hero"
                />
              }
            />

            <div className="p-4 space-y-3 flex-1">
              {rec.kind !== 'album' && rec.recommendedReleaseGroupTitle && (
                <p className="text-xs text-muted truncate">
                  Start with: <span className="italic">{rec.recommendedReleaseGroupTitle}</span>
                </p>
              )}

              <div className="flex flex-wrap items-center gap-1.5">
                <GenrePills genres={rec.artist.genres} max={expanded ? 8 : 6} />
              </div>

              {!expanded && (
                <StreamingLinks
                  streamingUrls={rec.artist.streamingUrls}
                  artistName={rec.artist.name}
                  albumTitle={
                    rec.kind === 'album'
                      ? (rec.recommendedReleaseGroupTitle ?? undefined)
                      : undefined
                  }
                  compact
                  fill
                />
              )}

              {isActed && (
                <StatusBadge
                  status={rec.status}
                  lidarrError={rec.lidarrError}
                  targetActions={rec.targetActions}
                  onRetry={onRetry}
                  onRetryFailed={onRetryFailed}
                  id={rec.id}
                  libraryConfirmedAt={rec.libraryConfirmedAt}
                  retrying={loading}
                />
              )}

              {/* Action buttons - compact mode only, hidden in bulk mode */}
              {!expanded && (
                <ActionButtons
                  rec={rec}
                  bulkMode={bulkMode}
                  isPending={isPending}
                  isApproved={isApproved}
                  onApprove={onApprove}
                  onReject={onReject}
                  approveNode={approveNode}
                  targets={targets}
                  onApproveToTarget={onApproveToTarget}
                  loading={loading}
                  fullWidth
                />
              )}
            </div>
          </div>
        )}

        {expanded && (
          <div className="border-t border-border pb-4 space-y-4">
            <div className="px-4 flex items-center gap-2">
              <a
                href={
                  rec.kind === 'album' && rec.recommendedReleaseGroupId
                    ? `https://musicbrainz.org/release-group/${rec.recommendedReleaseGroupId}`
                    : `https://musicbrainz.org/artist/${rec.artist.mbid}`
                }
                target="_blank"
                rel="noreferrer"
                className="text-xs text-accent underline"
                onClick={(e) => e.stopPropagation()}
              >
                {rec.kind === 'album' && rec.recommendedReleaseGroupId
                  ? 'View album on MusicBrainz'
                  : 'View on MusicBrainz'}
              </a>
            </div>

            {/* Wikidata enrichment: bio + external links */}
            <div className="px-4">
              <ArtistEnrichmentPanel
                artistId={rec.artist.id}
                mbid={rec.artist.mbid}
                artistName={rec.artist.name}
                releaseGroupId={
                  rec.kind === 'album' ? (rec.recommendedReleaseGroupId ?? undefined) : undefined
                }
                albumTitle={
                  rec.kind === 'album' ? (rec.recommendedReleaseGroupTitle ?? undefined) : undefined
                }
              />
            </div>

            <div className="px-4">
              <TopTracks
                artistId={rec.artist.id}
                albumTitle={
                  rec.kind === 'album' ? (rec.recommendedReleaseGroupTitle ?? undefined) : undefined
                }
              />
            </div>

            {/* Full streaming links with optional Spotify embed */}
            <div className="px-4">
              <p className="text-xs text-muted uppercase tracking-wide mb-2">Streaming</p>
              <StreamingLinks
                streamingUrls={rec.artist.streamingUrls}
                artistName={rec.artist.name}
                albumTitle={
                  rec.kind === 'album' ? (rec.recommendedReleaseGroupTitle ?? undefined) : undefined
                }
                spotifyTrackUrl={albumPreview?.spotifyUrl ?? undefined}
                compact={false}
                fill
              />
            </div>

            {isActed && (
              <StatusBadge
                status={rec.status}
                lidarrError={rec.lidarrError}
                targetActions={rec.targetActions}
                onRetry={onRetry}
                onRetryFailed={onRetryFailed}
                id={rec.id}
                libraryConfirmedAt={rec.libraryConfirmedAt}
                retrying={loading}
              />
            )}

            {/* Action buttons (re-shown in expanded too) - hidden in bulk mode */}
            <div className="px-4">
              <ActionButtons
                rec={rec}
                bulkMode={bulkMode}
                isPending={isPending}
                isApproved={isApproved}
                onApprove={onApprove}
                onReject={onReject}
                approveNode={approveNode}
                targets={targets}
                onApproveToTarget={onApproveToTarget}
                loading={loading}
                fullWidth
              />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
