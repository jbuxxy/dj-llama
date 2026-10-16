import { useQuery } from '@tanstack/react-query'
import { ExternalLink } from 'lucide-react'
import {
  ARTIST_EXTERNAL_LINK_KEYS,
  ARTIST_EXTERNAL_LINK_LABEL,
} from '@/core/artists/external-links'
import { getArtistEnrichment } from '../lib/api'

type ArtistEnrichmentPanelProps = {
  artistId: number
  mbid: string
  artistName?: string
  // Set for album-kind recommendations: there's no Wikidata release-group
  // lookup in this app, so Wikipedia/official-site links can't be resolved
  // to the album itself -- instead of showing artist-level links unlabeled
  // as "album" links, MusicBrainz points at the real release group, and
  // Wikipedia becomes an artist+album search rather than the artist's own
  // page. Official site has no per-album equivalent at all, so it's dropped.
  releaseGroupId?: string
  albumTitle?: string
}

export function ArtistEnrichmentPanel({
  artistId,
  mbid,
  artistName,
  releaseGroupId,
  albumTitle,
}: ArtistEnrichmentPanelProps) {
  const { data, isLoading } = useQuery({
    queryKey: ['artist-enrichment', artistId],
    queryFn: () => getArtistEnrichment(artistId),
    staleTime: 30 * 60 * 1000,
  })

  const isAlbum = Boolean(albumTitle)
  const linkMap: Record<string, string> = {
    ...(data?.externalLinks ?? {}),
    musicbrainz: isAlbum
      ? `https://musicbrainz.org/release-group/${releaseGroupId ?? ''}`
      : `https://musicbrainz.org/artist/${mbid}`,
    ...(isAlbum
      ? {
          wikipedia: `https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(
            `${artistName ?? ''} ${albumTitle ?? ''}`,
          )}`,
        }
      : {}),
  }
  if (isAlbum) delete linkMap.officialSite
  if (isAlbum && !releaseGroupId) delete linkMap.musicbrainz
  const availableLinks = ARTIST_EXTERNAL_LINK_KEYS.filter((k) => linkMap[k])

  if (isLoading) {
    return <div className="mt-3 h-10 animate-pulse rounded bg-surface" aria-busy="true" />
  }

  const description = data?.description ?? 'No description available.'

  return (
    <div className="mt-3 space-y-2" data-testid="artist-enrichment">
      <p className="text-sm text-text" data-testid="artist-bio">
        {description}
      </p>
      {availableLinks.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {availableLinks.map((key) => (
            <a
              key={key}
              href={linkMap[key]}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded-full border border-muted px-2 py-0.5 text-xs text-muted hover:text-text"
            >
              <ExternalLink className="h-3 w-3" />
              {ARTIST_EXTERNAL_LINK_LABEL[key]}
            </a>
          ))}
        </div>
      )}
    </div>
  )
}
