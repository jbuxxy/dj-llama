import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import type { Database } from '@/db'
import { playlistMissingTracks } from '@/db/schema'

export type MissingTrackRow = typeof playlistMissingTracks.$inferSelect

export type MissingTrackWithResolution = MissingTrackRow & {
  // The album DJ Llama actually resolved and is requesting from Lidarr for
  // this track (MusicBrainz or AI, whichever won -- see
  // track_album_resolution_cache), distinct from albumTitle above, which is
  // just the *source playlist's* own tag (Spotify/Apple Music/etc.) and is
  // frequently a deluxe reissue, compilation, or otherwise-wrong bundle --
  // confirmed a real point of confusion live (2026-08): a user reading
  // "Missing track from The Very Best of Kool & The Gang" assumed that
  // compilation was what DJ Llama was searching Lidarr for, when the actual
  // (correct) target was "Emergency", the real original album. Null when
  // nothing has resolved yet (negative-cached or never attempted).
  resolvedAlbumTitle: string | null
}

export type MissingTrackInput = {
  artistName: string
  trackName: string
  albumTitle?: string
  coverUrl?: string
  reason?: 'not_found' | 'search_error'
}

// Upserts the current run's unmatched tracks and drops any previously-missing
// row that isn't in this run's set anymore (resolved -- either the track
// showed up in the library, or the source playlist dropped it). Keeps this
// list a live reflection of "what's missing right now" instead of an
// ever-growing history.
export async function reconcilePlaylistMissingTracks(
  db: Database,
  playlistId: number,
  current: MissingTrackInput[],
): Promise<void> {
  await db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(playlistMissingTracks)
      .where(eq(playlistMissingTracks.playlistId, playlistId))

    const keyOf = (artistName: string, trackName: string) =>
      `${artistName.toLowerCase()}::${trackName.toLowerCase()}`
    const existingByKey = new Map(
      existing.map((row) => [keyOf(row.artistName, row.trackName), row]),
    )
    // One row per (artist, track): a source playlist can list the same song
    // twice, and stripping "- Live"/"- Remastered" qualifiers before matching
    // collapses variants into one name. Inserting both tripped the natural-key
    // unique index and failed the whole playlist run.
    const deduped = new Map<string, MissingTrackInput>()
    for (const t of current) {
      const key = keyOf(t.artistName, t.trackName)
      if (!deduped.has(key)) deduped.set(key, t)
    }
    const currentKeys = new Set(deduped.keys())

    const staleIds = existing
      .filter((row) => !currentKeys.has(keyOf(row.artistName, row.trackName)))
      .map((row) => row.id)
    if (staleIds.length > 0) {
      await tx.delete(playlistMissingTracks).where(inArray(playlistMissingTracks.id, staleIds))
    }

    for (const t of deduped.values()) {
      const existingRow = existingByKey.get(keyOf(t.artistName, t.trackName))
      if (existingRow) {
        await tx
          .update(playlistMissingTracks)
          .set({
            lastSeenAt: new Date(),
            albumTitle: t.albumTitle ?? existingRow.albumTitle,
            coverUrl: t.coverUrl ?? existingRow.coverUrl,
            reason: t.reason ?? existingRow.reason,
          })
          .where(eq(playlistMissingTracks.id, existingRow.id))
      } else {
        await tx.insert(playlistMissingTracks).values({
          playlistId,
          artistName: t.artistName,
          trackName: t.trackName,
          albumTitle: t.albumTitle ?? null,
          coverUrl: t.coverUrl ?? null,
          reason: t.reason ?? null,
        })
      }
    }
  })
}

// Sets album art on this playlist's missing-track rows that don't have any
// yet, matched by (artist, track) the same case-insensitive way
// reconcilePlaylistMissingTracks keys rows.
export async function fillMissingTrackCovers(
  db: Database,
  playlistId: number,
  tracks: Array<{ artistName: string; trackName: string; coverUrl?: string }>,
): Promise<void> {
  const keyOf = (artistName: string, trackName: string) =>
    `${artistName.toLowerCase()}::${trackName.toLowerCase()}`
  const coverByKey = new Map(
    tracks.filter((t) => t.coverUrl).map((t) => [keyOf(t.artistName, t.trackName), t.coverUrl]),
  )
  const rows = await db
    .select()
    .from(playlistMissingTracks)
    .where(
      and(eq(playlistMissingTracks.playlistId, playlistId), isNull(playlistMissingTracks.coverUrl)),
    )
  for (const row of rows) {
    const coverUrl = coverByKey.get(keyOf(row.artistName, row.trackName))
    if (!coverUrl) continue
    await db
      .update(playlistMissingTracks)
      .set({ coverUrl })
      .where(eq(playlistMissingTracks.id, row.id))
  }
}

export async function listPlaylistMissingTracks(
  db: Database,
  playlistId: number,
): Promise<MissingTrackRow[]> {
  return db
    .select()
    .from(playlistMissingTracks)
    .where(eq(playlistMissingTracks.playlistId, playlistId))
    .orderBy(desc(playlistMissingTracks.lastSeenAt))
}

export async function deletePlaylistMissingTrack(
  db: Database,
  playlistId: number,
  id: number,
): Promise<void> {
  await db
    .delete(playlistMissingTracks)
    .where(and(eq(playlistMissingTracks.id, id), eq(playlistMissingTracks.playlistId, playlistId)))
}
