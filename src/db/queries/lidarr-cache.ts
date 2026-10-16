import { and, eq } from 'drizzle-orm'
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
