import { and, asc, eq, inArray, isNotNull, isNull, or } from 'drizzle-orm'
import { normalizeAlbumTitle, normalizeArtistName } from '@/core/library/normalize'
import { albumTitleFromPath } from '@/core/playlists/local-path'
import type { Database } from '@/db'
import { libraryAlbums, libraryArtists, playlistTracks } from '@/db/schema'

const COLLAGE_SIZE = 4

function coverArtUrl(releaseGroupMbid: string): string {
  return `https://coverartarchive.org/release-group/${releaseGroupMbid}/front-250`
}

// Up to four distinct album covers per playlist for a 2x2 collage, in
// playlist order: first one album per artist, then (if the playlist leans
// on fewer than four artists) further albums by artists already used. A
// track whose album folder doesn't match a library album falls back to any
// owned album by that artist, so a mix still gets art even when folder
// names and library titles disagree.
export async function getPlaylistCollages(
  db: Database,
  userId: number,
  playlistIds: number[],
): Promise<Map<number, string[]>> {
  const result = new Map<number, string[]>()
  if (playlistIds.length === 0) return result

  const tracks = await db
    .select({
      playlistId: playlistTracks.playlistId,
      artistName: playlistTracks.artistName,
      localPath: playlistTracks.localPath,
    })
    .from(playlistTracks)
    .where(inArray(playlistTracks.playlistId, playlistIds))
    .orderBy(asc(playlistTracks.playlistId), asc(playlistTracks.position))
  if (tracks.length === 0) return result

  const artistKeys = [...new Set(tracks.map((t) => normalizeArtistName(t.artistName)))].filter(
    Boolean,
  )
  if (artistKeys.length === 0) return result

  // Lidarr-synced library rows are shared (userId null); Plex rows are per user.
  const albums = await db
    .select({
      artist: libraryArtists.nameNormalized,
      title: libraryAlbums.titleNormalized,
      mbid: libraryAlbums.albumMbid,
    })
    .from(libraryAlbums)
    .innerJoin(
      libraryArtists,
      and(
        eq(libraryArtists.source, libraryAlbums.source),
        eq(libraryArtists.sourceArtistId, libraryAlbums.sourceArtistId),
      ),
    )
    .where(
      and(
        isNotNull(libraryAlbums.albumMbid),
        inArray(libraryArtists.nameNormalized, artistKeys),
        or(eq(libraryAlbums.userId, userId), isNull(libraryAlbums.userId)),
        or(eq(libraryArtists.userId, userId), isNull(libraryArtists.userId)),
      ),
    )

  const byArtistAndTitle = new Map<string, string>()
  const anyByArtist = new Map<string, string>()
  for (const album of albums) {
    if (!album.mbid) continue
    byArtistAndTitle.set(`${album.artist}|${album.title}`, album.mbid)
    if (!anyByArtist.has(album.artist)) anyByArtist.set(album.artist, album.mbid)
  }

  const candidatesByPlaylist = new Map<number, Array<{ artist: string; mbid: string }>>()
  for (const track of tracks) {
    const artist = normalizeArtistName(track.artistName)
    const title = albumTitleFromPath(track.localPath)
    const mbid =
      (title && byArtistAndTitle.get(`${artist}|${normalizeAlbumTitle(title)}`)) ??
      anyByArtist.get(artist)
    if (!mbid) continue
    const list = candidatesByPlaylist.get(track.playlistId) ?? []
    list.push({ artist, mbid })
    candidatesByPlaylist.set(track.playlistId, list)
  }

  for (const [playlistId, candidates] of candidatesByPlaylist) {
    const picked: string[] = []
    const usedArtists = new Set<string>()
    for (const c of candidates) {
      if (picked.length >= COLLAGE_SIZE) break
      if (usedArtists.has(c.artist) || picked.includes(c.mbid)) continue
      usedArtists.add(c.artist)
      picked.push(c.mbid)
    }
    for (const c of candidates) {
      if (picked.length >= COLLAGE_SIZE) break
      if (!picked.includes(c.mbid)) picked.push(c.mbid)
    }
    result.set(playlistId, picked.map(coverArtUrl))
  }
  return result
}
