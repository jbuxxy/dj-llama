import { inArray } from 'drizzle-orm'
import type { Database } from '@/db'
import { trackAlbumResolutionCache } from '@/db/schema'

export type CachedTrackAlbumResolution = typeof trackAlbumResolutionCache.$inferSelect

function normalize(value: string): string {
  return value.trim().toLowerCase()
}

export function trackAlbumCacheKey(artistName: string, trackName: string): string {
  return `${normalize(artistName)}::${normalize(trackName)}`
}

/**
 * Batch lookup keyed by trackAlbumCacheKey(artistName, trackName) -- fetches
 * every candidate row for the involved artists in one query (cheap: a
 * playlist resync's missing-track count is at most dozens), then the caller
 * does the exact-pair match locally rather than needing a portable
 * multi-column IN across pglite/postgres.
 */
export async function getCachedTrackAlbumResolutions(
  db: Database,
  tracks: Array<{ artistName: string; trackName: string }>,
): Promise<Map<string, CachedTrackAlbumResolution>> {
  if (tracks.length === 0) return new Map()
  const artistNames = [...new Set(tracks.map((t) => normalize(t.artistName)))]
  const rows = await db
    .select()
    .from(trackAlbumResolutionCache)
    .where(inArray(trackAlbumResolutionCache.artistName, artistNames))
  const byKey = new Map<string, CachedTrackAlbumResolution>()
  for (const row of rows) {
    byKey.set(trackAlbumCacheKey(row.artistName, row.trackName), row)
  }
  return byKey
}

/**
 * Upserts (not insert-or-ignore) so a re-resolve after a logic change
 * replaces a stale cached answer instead of being stuck behind it forever --
 * unlike recording_artist_cache, this cache's value can legitimately change
 * as pickBestReleaseGroup's own logic evolves, not just as new data appears.
 * releaseGroupMbid/albumTitle null means "resolved, but MusicBrainz has no
 * usable original release for this track" -- a deliberate negative cache,
 * not a missing value.
 */
export async function setCachedTrackAlbumResolution(
  db: Database,
  entry: {
    artistName: string
    trackName: string
    releaseGroupMbid: string | null
    artistMbid: string | null
    albumTitle: string | null
  },
): Promise<void> {
  await db
    .insert(trackAlbumResolutionCache)
    .values({
      artistName: normalize(entry.artistName),
      trackName: normalize(entry.trackName),
      releaseGroupMbid: entry.releaseGroupMbid,
      artistMbid: entry.artistMbid,
      albumTitle: entry.albumTitle,
    })
    .onConflictDoUpdate({
      target: [trackAlbumResolutionCache.artistName, trackAlbumResolutionCache.trackName],
      set: {
        releaseGroupMbid: entry.releaseGroupMbid,
        artistMbid: entry.artistMbid,
        albumTitle: entry.albumTitle,
        cachedAt: new Date(),
      },
    })
}
