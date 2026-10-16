import { useQuery } from '@tanstack/react-query'
import { ChevronDown } from 'lucide-react'
import { Fragment, useRef, useState } from 'react'
import { useClickOutside } from '../hooks/use-click-outside'
import { usePopularAlbumsAvailability } from '../hooks/use-popular-albums-availability'
import { getAlbumPreview, getAlbums } from '../lib/api'
import { hueFromName } from '../lib/utils'
import { AlbumApprove } from './album-approve'
import { Hint } from './hint'
import { MonitoringOptions, type MonitorOption } from './monitoring-options'
import { StreamingLinks } from './streaming-links'
import { Skeleton } from './ui/skeleton'
import { WhyRecommendedButton } from './why-recommended'

export type Recommendation = {
  id: number
  kind?: 'artist' | 'album' | null
  score: number
  status: string
  aiReasoning?: string | null
  sources?: Record<string, number> | null
  recommendedReleaseGroupId?: string | null
  recommendedReleaseGroupTitle?: string | null
  artist: {
    id: number
    name: string
    mbid?: string
    genres?: string[] | null
    imageUrl?: string | null
    logoUrl?: string | null
    streamingUrls?: Record<string, string> | null
  }
}

import { canApproveArtistToTarget, TargetIcon, targetActionLabel } from './target-utils'

type TodaysPickProps = {
  rec: Recommendation | null
  loading: boolean
  onApprove: (id: number) => void
  onReject: (id: number) => void
  onSkip: (id: number) => void
  onRunScan: () => void
  targets?: Array<{ id: number; type: string; name: string }>
  onApproveToTarget?: (recId: number, targetId: string) => void
  onApproveWithOption?: (recId: number, option: MonitorOption) => void
  onOpenAlbumPicker?: (recId: number) => void
  onApproveWholeDiscography?: (recId: number) => void
}

export function TodaysPick({
  rec,
  loading,
  onApprove,
  onReject,
  onSkip,
  onRunScan,
  targets,
  onApproveToTarget,
  onApproveWithOption,
  onOpenAlbumPicker,
  onApproveWholeDiscography,
}: TodaysPickProps) {
  const [imgError, setImgError] = useState(false)
  const [coverError, setCoverError] = useState(false)
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const actionableTargets = (targets ?? []).filter((target) =>
    canApproveArtistToTarget(target.type),
  )

  useClickOutside(dropdownRef, () => setDropdownOpen(false), dropdownOpen)
  const popularAvailable = usePopularAlbumsAvailability()

  // Only needed as a cover-art fallback for artist-kind recs -- album-kind
  // recs already know their exact release group and skip this query entirely.
  const needsAlbumFallback = rec?.kind !== 'album'
  const { data: albumData } = useQuery({
    queryKey: ['todays-pick-albums', rec?.artist.mbid],
    // biome-ignore lint/style/noNonNullAssertion: guarded by enabled
    queryFn: () => getAlbums(rec!.artist.mbid!),
    enabled: needsAlbumFallback && !!rec?.artist.mbid,
    staleTime: 60_000,
  })

  const { data: albumPreview } = useQuery({
    queryKey: ['album-preview', rec?.artist.id, rec?.recommendedReleaseGroupTitle],
    queryFn: () =>
      // biome-ignore lint/style/noNonNullAssertion: guarded by enabled
      getAlbumPreview(rec!.artist.id, rec!.recommendedReleaseGroupTitle!),
    enabled: rec?.kind === 'album' && !!rec?.recommendedReleaseGroupTitle,
    staleTime: 60 * 60_000,
  })

  if (loading) {
    return (
      <div className="bg-surface border border-border rounded-lg overflow-hidden h-full">
        <Skeleton className="h-72 w-full" />
        <div className="p-4 space-y-3">
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-4/5" />
          <Skeleton className="h-3 w-3/5" />
        </div>
      </div>
    )
  }

  if (!rec) {
    return (
      <div className="bg-surface border border-border rounded-lg p-8 flex flex-col items-center justify-center text-center h-full">
        <p className="text-muted text-sm mb-3">No pending recommendations</p>
        <button
          type="button"
          onClick={onRunScan}
          className="px-4 py-2 bg-accent text-accent-fg rounded text-sm font-medium hover:bg-accent/90 transition-colors"
        >
          Run Scan
        </button>
      </div>
    )
  }

  const { artist } = rec
  const hue = hueFromName(artist.name)

  // Album-kind recs show the actual recommended album's cover art first
  // (this is a specific-album recommendation, not just "an artist"); artist
  // image and the most-recent-album lookup are the fallback chain for both.
  const albumCoverUrl = rec.recommendedReleaseGroupId
    ? `https://coverartarchive.org/release-group/${rec.recommendedReleaseGroupId}/front-500`
    : null
  const firstAlbumId = albumData?.find((a) => a.type === 'Album')?.id
  const coverFallback = firstAlbumId
    ? `https://coverartarchive.org/release-group/${firstAlbumId}/front-500`
    : null
  const bannerUrl =
    rec.kind === 'album'
      ? (!coverError && albumCoverUrl) || (!imgError && artist.imageUrl) || null
      : (!imgError && artist.imageUrl) || coverFallback
  const hasImage = rec.kind === 'album' ? !!bannerUrl : !!bannerUrl && !coverError

  const bannerStyle = hasImage
    ? {
        backgroundImage: `url(${bannerUrl})`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
      }
    : { background: `hsl(${hue}, 40%, 35%)` }
  const highlightedReasoning = rec.aiReasoning
    ? (() => {
        const parts = rec.aiReasoning.split(
          new RegExp(`(${artist.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'),
        )
        let offset = 0

        return parts.map((part) => {
          const key = `${offset}:${part}`
          offset += part.length
          return part.toLowerCase() === artist.name.toLowerCase() ? (
            <span key={key} className="text-text font-semibold">
              {part}
            </span>
          ) : (
            <Fragment key={key}>{part}</Fragment>
          )
        })
      })()
    : null

  return (
    <div className="bg-surface border border-border rounded-lg overflow-hidden flex flex-col md:flex-row">
      <div
        className="relative shrink-0 h-56 md:h-auto md:w-1/2 md:min-h-[20rem]"
        style={bannerStyle}
      >
        {hasImage && (
          <img
            src={bannerUrl ?? undefined}
            alt={artist.name}
            className="sr-only"
            onError={() => {
              if (bannerUrl === artist.imageUrl) setImgError(true)
              else setCoverError(true)
            }}
          />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent md:bg-gradient-to-r md:from-transparent md:via-black/20 md:to-black/60" />

        <div className="absolute top-3 right-3">
          <WhyRecommendedButton reasoning={rec.aiReasoning} sources={rec.sources} variant="hero" />
        </div>

        <div className="absolute bottom-3 left-4 right-4 flex items-end justify-between gap-3">
          <div className="min-w-0 flex-1">
            {artist.logoUrl && rec.kind !== 'album' ? (
              <img
                src={artist.logoUrl}
                alt={artist.name}
                className="h-10 max-w-[70%] object-contain object-left drop-shadow-lg"
                onError={(e) => {
                  e.currentTarget.style.display = 'none'
                  const sibling = e.currentTarget.nextElementSibling
                  if (sibling) sibling.classList.remove('hidden')
                }}
              />
            ) : null}
            <h3
              className={`text-white font-bold text-xl md:text-2xl leading-tight drop-shadow-lg truncate${artist.logoUrl && rec.kind !== 'album' ? ' hidden' : ''}`}
            >
              {rec.kind === 'album'
                ? (rec.recommendedReleaseGroupTitle ?? artist.name)
                : artist.name}
            </h3>
            {rec.kind === 'album' && (
              <p className="text-white/70 text-xs md:text-sm truncate drop-shadow-lg">
                {artist.name}
              </p>
            )}
          </div>
          {artist.logoUrl && rec.kind === 'album' && (
            <img
              src={artist.logoUrl}
              alt=""
              aria-hidden="true"
              className="h-14 max-w-[40%] object-contain object-right shrink-0 drop-shadow-[0_2px_6px_rgba(0,0,0,0.9)]"
              onError={(e) => {
                e.currentTarget.style.display = 'none'
              }}
            />
          )}
        </div>
      </div>

      <div className="flex flex-col flex-1 min-w-0">
        <div className="p-4 md:p-5 overflow-y-auto min-h-0 flex-1 space-y-3">
          {artist.genres && artist.genres.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {artist.genres.slice(0, 6).map((genre) => (
                <span
                  key={genre}
                  className="text-micro px-1.5 py-0.5 bg-bg border border-border rounded text-muted"
                >
                  {genre}
                </span>
              ))}
            </div>
          )}

          {rec.aiReasoning && (
            <p className="text-xs md:text-sm text-muted line-clamp-5 md:line-clamp-6">
              {highlightedReasoning}
            </p>
          )}

          <StreamingLinks
            streamingUrls={artist.streamingUrls ?? null}
            artistName={artist.name}
            albumTitle={
              rec.kind === 'album' ? (rec.recommendedReleaseGroupTitle ?? undefined) : undefined
            }
            spotifyTrackUrl={albumPreview?.spotifyUrl ?? undefined}
            fill
          />

          <Hint id="todays-pick-skip-tip" type="inline">
            Skip shows you the next artist without rejecting - skipped artists will come back in
            future scans.
          </Hint>
        </div>

        <div className="px-4 md:px-5 pb-4 flex gap-2 shrink-0">
          <button
            type="button"
            onClick={() => onReject(rec.id)}
            className="flex-1 py-2 text-sm font-medium text-center rounded-lg border border-reject/30 text-reject bg-reject/5 hover:bg-reject/15 transition-colors"
          >
            Reject
          </button>
          <button
            type="button"
            onClick={() => onSkip(rec.id)}
            className="flex-1 py-2 text-sm font-medium text-center rounded-lg border border-warning/35 text-warning bg-warning/8 hover:bg-warning/15 transition-colors"
            title="Skip for now - this artist will come back later"
          >
            Skip
          </button>
          {actionableTargets.length > 1 ? (
            <div ref={dropdownRef} className="relative flex-1">
              <div className="flex">
                <button
                  type="button"
                  onClick={() => onApprove(rec.id)}
                  className="flex-1 py-2 text-sm font-medium text-center rounded-l-lg border border-approve/30 text-approve bg-approve/5 hover:bg-approve/15 transition-colors"
                >
                  Approve
                </button>
                <button
                  type="button"
                  onClick={() => setDropdownOpen((v) => !v)}
                  className="px-2 py-2 text-sm font-medium rounded-r-lg border border-l-0 border-approve/30 text-approve bg-approve/5 hover:bg-approve/15 transition-colors"
                  aria-label="Approve to specific target"
                >
                  <ChevronDown size={14} />
                </button>
              </div>
              {dropdownOpen && (
                <div className="absolute right-0 bottom-full mb-1 z-20 rounded-lg border border-border bg-surface shadow-lg py-1 min-w-[180px]">
                  {actionableTargets.map((target) => (
                    <button
                      key={target.id}
                      type="button"
                      onClick={() => {
                        onApproveToTarget?.(rec.id, `${target.type}-${target.id}`)
                        setDropdownOpen(false)
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
          ) : (
            <div className="flex-1">
              {rec.kind === 'album' ? (
                onApproveWholeDiscography ? (
                  <AlbumApprove
                    fill
                    onApprove={() => onApprove(rec.id)}
                    onApproveWholeDiscography={() => onApproveWholeDiscography(rec.id)}
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => onApprove(rec.id)}
                    className="w-full py-2 text-sm font-medium text-center rounded-lg border border-approve/30 text-approve bg-approve/5 hover:bg-approve/15 transition-colors"
                  >
                    Approve
                  </button>
                )
              ) : !onApproveWithOption || !onOpenAlbumPicker ? (
                <button
                  type="button"
                  onClick={() => onApprove(rec.id)}
                  className="w-full py-2 text-sm font-medium text-center rounded-lg border border-approve/30 text-approve bg-approve/5 hover:bg-approve/15 transition-colors"
                >
                  Approve
                </button>
              ) : (
                <MonitoringOptions
                  fill
                  popularAvailable={popularAvailable}
                  onApprove={(option) => onApproveWithOption(rec.id, option)}
                  onOpenAlbumPicker={() => onOpenAlbumPicker(rec.id)}
                />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
