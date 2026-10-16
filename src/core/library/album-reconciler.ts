import { type createMusicBrainzClient, parseYear } from '@/core/clients/musicbrainz'
import { normalizeAlbumTitle } from './normalize'
import type { LibraryAlbum } from './sources/types'

type MBClient = Pick<
  ReturnType<typeof createMusicBrainzClient>,
  'getReleaseGroups' | 'searchReleaseGroupByTitle'
>

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type ReconciledAlbum = {
  sourceAlbumId: string
  sourceArtistId: string
  title: string
  titleNormalized: string
  albumMbid: string | null
  artistMbid: string
  releaseYear: number | null
  primaryType: 'Album' | 'EP' | 'Single' | 'Compilation' | 'Live' | 'Other' | null
  matchMethod: 'mbid' | 'title_exact' | 'title_year' | null
  matchConfidence: number | null
}

function makeRow(
  album: LibraryAlbum,
  titleNormalized: string,
  artistMbid: string,
  releaseYear: number | null,
  primaryType: ReconciledAlbum['primaryType'],
  albumMbid: string | null,
  matchMethod: ReconciledAlbum['matchMethod'],
  matchConfidence: number | null,
): ReconciledAlbum {
  return {
    sourceAlbumId: album.sourceAlbumId,
    sourceArtistId: album.sourceArtistId,
    title: album.title,
    titleNormalized,
    albumMbid,
    artistMbid,
    releaseYear,
    primaryType,
    matchMethod,
    matchConfidence,
  }
}

export async function reconcileAlbumsForArtist(
  artistMbid: string,
  albums: LibraryAlbum[],
  deps: {
    mbClient: MBClient
    /**
     * Invoked when MB getReleaseGroups throws (5xx, timeout, network). Albums
     * for this artist fall through to `albumMbid: null` rather than aborting
     * the sync.
     */
    onMbError?: (err: unknown) => void
  },
): Promise<ReconciledAlbum[]> {
  let releaseGroups: Awaited<ReturnType<MBClient['getReleaseGroups']>>
  try {
    // Unlike request/recommendation flows (Album/EP only), reconciliation
    // must match anything a user might actually own, including singles. This
    // bulk fetch excludes Compilation/Live/etc. secondary types (see
    // getReleaseGroups) -- albums that miss here fall back to a targeted
    // per-title search below, which is the only way to find those safely.
    releaseGroups = await deps.mbClient.getReleaseGroups(artistMbid, ['Album', 'EP', 'Single'])
  } catch (err) {
    deps.onMbError?.(err)
    console.warn(
      `[library-reconcile] MB getReleaseGroups failed for artist ${artistMbid}; albums left unreconciled: ${err instanceof Error ? err.message : String(err)}`,
    )
    releaseGroups = []
  }

  return Promise.all(
    albums.map(async (album) => {
      const titleNormalized = normalizeAlbumTitle(album.title)
      const direct =
        typeof album.mbid === 'string' && UUID_RE.test(album.mbid)
          ? releaseGroups.find((rg) => rg.id === album.mbid)
          : undefined

      if (direct) {
        return makeRow(
          album,
          titleNormalized,
          artistMbid,
          parseYear(direct.firstReleaseDate) ?? album.releaseYear ?? null,
          (direct.type as ReconciledAlbum['primaryType']) ?? album.primaryType ?? null,
          direct.id,
          'mbid',
          1,
        )
      }

      let candidates = releaseGroups.filter(
        (rg) => normalizeAlbumTitle(rg.title) === titleNormalized,
      )

      // Fallback: the bulk fetch excludes Compilation/Live/etc., so a title
      // that matched nothing there might still be a legitimate release-group
      // MB just filed under one of those secondary types. Search by title
      // directly instead of widening the bulk fetch -- for a heavily-bootlegged
      // artist that would blow past MB's 100-result page cap and bury the real
      // release (confirmed live: Nirvana has 521 Album/EP/Single release-groups
      // once secondary types are included, and MB's non-relevance browse order
      // doesn't put official releases first).
      if (candidates.length === 0) {
        try {
          const searched = await deps.mbClient.searchReleaseGroupByTitle(artistMbid, album.title)
          candidates = searched.filter((rg) => normalizeAlbumTitle(rg.title) === titleNormalized)
        } catch (err) {
          deps.onMbError?.(err)
          console.warn(
            `[library-reconcile] MB searchReleaseGroupByTitle failed for "${album.title}" (artist ${artistMbid}); leaving unreconciled: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      }

      if (candidates.length === 1 && candidates[0]) {
        return makeRow(
          album,
          titleNormalized,
          artistMbid,
          parseYear(candidates[0].firstReleaseDate) ?? album.releaseYear ?? null,
          (candidates[0].type as ReconciledAlbum['primaryType']) ?? album.primaryType ?? null,
          candidates[0].id,
          'title_exact',
          0.8,
        )
      }

      if (album.releaseYear != null) {
        const yearMatches = candidates.filter(
          (candidate) => parseYear(candidate.firstReleaseDate) === album.releaseYear,
        )
        const allOtherCandidatesHaveKnownDifferentYears = candidates.every((candidate) => {
          const candidateYear = parseYear(candidate.firstReleaseDate)
          return candidateYear === album.releaseYear || candidateYear !== undefined
        })
        if (
          yearMatches.length === 1 &&
          yearMatches[0] &&
          allOtherCandidatesHaveKnownDifferentYears
        ) {
          return makeRow(
            album,
            titleNormalized,
            artistMbid,
            album.releaseYear,
            (yearMatches[0].type as ReconciledAlbum['primaryType']) ?? album.primaryType ?? null,
            yearMatches[0].id,
            'title_year',
            0.7,
          )
        }
      }

      return makeRow(
        album,
        titleNormalized,
        artistMbid,
        album.releaseYear ?? null,
        album.primaryType ?? null,
        null,
        null,
        null,
      )
    }),
  )
}
