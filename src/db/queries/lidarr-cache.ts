import { and, eq, inArray } from 'drizzle-orm'
import type { Database } from '@/db'
import { libraryAlbums, libraryArtists } from '@/db/schema'

export type CachedLidarrIds = {
  artistId: number | null
  albumId: number | null
}

// DJ Llama already keeps its own synced copy of Lidarr's library
// (library_artists/library_albums, source='lidarr', userId=null -- one
// global instance) from the periodic/webhook-triggered library sync.
// Checking that cache first lets addAlbum (targets/lidarr.ts) skip Lidarr's
// full-library getArtists() fetch (confirmed live: a ~19MB payload taking
// ~30s on a library this size) and the getAlbums() polling loop entirely
// for anything already known, instead of hitting Lidarr's live API on every
// single approval. Returns null for whichever id isn't in the cache yet
// (freshly added, not synced) so the caller can fall back to the live API
// for just that piece.
export async function getCachedLidarrIds(
  db: Database,
  artistMbid: string,
  albumMbid: string,
): Promise<CachedLidarrIds> {
  const [artistRows, albumRows] = await Promise.all([
    db
      .select({ sourceArtistId: libraryArtists.sourceArtistId })
      .from(libraryArtists)
      .where(and(eq(libraryArtists.source, 'lidarr'), eq(libraryArtists.mbid, artistMbid)))
      .limit(1),
    db
      .select({ sourceAlbumId: libraryAlbums.sourceAlbumId })
      .from(libraryAlbums)
      .where(and(eq(libraryAlbums.source, 'lidarr'), eq(libraryAlbums.albumMbid, albumMbid)))
      .limit(1),
  ])

  const artistId = artistRows[0]?.sourceArtistId ? Number(artistRows[0].sourceArtistId) : null
  const albumId = albumRows[0]?.sourceAlbumId ? Number(albumRows[0].sourceAlbumId) : null
  return {
    artistId: artistId != null && Number.isFinite(artistId) ? artistId : null,
    albumId: albumId != null && Number.isFinite(albumId) ? albumId : null,
  }
}

/**
 * Normalized album titles per normalized artist name, from the synced Lidarr
 * library snapshot. Replaces a live `GET /api/v1/artist` (tens of MB and
 * ~30s on a large library) plus one `GET /album?artistId` per artist for
 * "do I already own this?" checks.
 */
export async function getLidarrAlbumTitlesByArtist(
  db: Database,
  artistNamesNormalized: string[],
): Promise<Map<string, Set<string>>> {
  const result = new Map<string, Set<string>>()
  const names = [...new Set(artistNamesNormalized.filter(Boolean))]
  if (names.length === 0) return result
  const rows = await db
    .select({ artist: libraryArtists.nameNormalized, title: libraryAlbums.titleNormalized })
    .from(libraryArtists)
    .innerJoin(
      libraryAlbums,
      and(
        eq(libraryAlbums.source, libraryArtists.source),
        eq(libraryAlbums.sourceArtistId, libraryArtists.sourceArtistId),
      ),
    )
    .where(and(eq(libraryArtists.source, 'lidarr'), inArray(libraryArtists.nameNormalized, names)))
  for (const row of rows) {
    let titles = result.get(row.artist)
    if (!titles) {
      titles = new Set()
      result.set(row.artist, titles)
    }
    titles.add(row.title)
  }
  return result
}
