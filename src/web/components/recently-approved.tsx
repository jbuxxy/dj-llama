import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { getAlbums } from '../lib/api'
import { hueFromName } from '../lib/utils'
import { Skeleton } from './ui/skeleton'

type RecentlyApprovedProps = {
  recs: Array<{
    id: number
    kind?: 'artist' | 'album' | null
    recommendedReleaseGroupId?: string | null
    recommendedReleaseGroupTitle?: string | null
    artist: { name: string; mbid?: string; imageUrl?: string | null; genres?: string[] | null }
  }>
  loading: boolean
}

const SKELETON_SLOTS = ['s0', 's1', 's2', 's3', 's4', 's5'] as const

function Tile({
  name,
  mbid,
  imageUrl,
  kind,
  releaseGroupId,
  releaseGroupTitle,
}: {
  name: string
  mbid?: string
  imageUrl?: string | null
  kind?: 'artist' | 'album' | null
  releaseGroupId?: string | null
  releaseGroupTitle?: string | null
}) {
  const [imgError, setImgError] = useState(false)
  const [coverError, setCoverError] = useState(false)
  const hue = hueFromName(name)

  // Album-kind recs already know their exact release group (see
  // todays-pick.tsx's identical pattern) -- only artist-kind recs need the
  // most-recent-album lookup as a cover-art fallback.
  const needsFallback = kind !== 'album' && (!imageUrl || imgError)
  const { data: albumData, isLoading: albumLoading } = useQuery({
    queryKey: ['tile-albums', mbid],
    queryFn: () => {
      if (!mbid) {
        throw new Error('Expected mbid for album fallback')
      }
      return getAlbums(mbid)
    },
    enabled: needsFallback && !!mbid,
    staleTime: 5 * 60_000,
  })

  const albumCoverUrl = releaseGroupId
    ? `https://coverartarchive.org/release-group/${releaseGroupId}/front-500`
    : null
  const firstAlbumId = albumData?.find((a: { type: string }) => a.type === 'Album')?.id
  const coverFallback = firstAlbumId
    ? `https://coverartarchive.org/release-group/${firstAlbumId}/front-500`
    : null

  const displayUrl =
    kind === 'album'
      ? (!coverError && albumCoverUrl) || (!imgError && imageUrl)
      : (!imgError && imageUrl) || (!coverError && coverFallback)
  const showShimmer = needsFallback && albumLoading

  const caption = kind === 'album' && releaseGroupTitle ? releaseGroupTitle : name
  const subCaption = kind === 'album' && releaseGroupTitle ? name : null

  return (
    <Link
      to="/discover"
      className="w-24 shrink-0 snap-start aspect-square rounded-lg overflow-hidden relative group block"
    >
      {displayUrl ? (
        <img
          src={displayUrl}
          alt={caption}
          loading="lazy"
          decoding="async"
          className="w-full h-full object-cover"
          onError={() => {
            if (displayUrl === imageUrl) setImgError(true)
            else setCoverError(true)
          }}
        />
      ) : showShimmer ? (
        <div
          className="w-full h-full animate-pulse"
          style={{ background: `hsl(${hue}, 30%, 30%)` }}
        />
      ) : (
        <div className="w-full h-full" style={{ background: `hsl(${hue}, 40%, 45%)` }} />
      )}
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-2 pt-6">
        <p className="text-white text-xs font-medium truncate">{caption}</p>
        {subCaption && <p className="text-white/70 text-[10px] truncate">{subCaption}</p>}
      </div>
    </Link>
  )
}

export function RecentlyApproved({ recs, loading }: RecentlyApprovedProps) {
  if (loading) {
    return (
      <div className="flex gap-1.5 overflow-hidden">
        {SKELETON_SLOTS.map((key) => (
          <Skeleton key={key} className="w-24 shrink-0 aspect-square rounded-lg" />
        ))}
      </div>
    )
  }

  if (recs.length === 0) {
    return (
      <div className="flex gap-1.5 min-h-[96px]">
        {SKELETON_SLOTS.slice(0, 4).map((key) => (
          <div
            key={key}
            className="w-24 shrink-0 aspect-square rounded-lg bg-bg border border-border"
          />
        ))}
      </div>
    )
  }

  return (
    <div className="flex gap-1.5 overflow-x-auto snap-x snap-mandatory pb-1">
      {recs.map((rec) => (
        <Tile
          key={rec.id}
          name={rec.artist.name}
          mbid={rec.artist.mbid}
          imageUrl={rec.artist.imageUrl}
          kind={rec.kind}
          releaseGroupId={rec.recommendedReleaseGroupId}
          releaseGroupTitle={rec.recommendedReleaseGroupTitle}
        />
      ))}
    </div>
  )
}
