import { createPlexPlaylistTarget } from '@/core/targets/plex-playlist'

export type ExternalTrack = {
  artistName: string
  trackName: string
  albumTitle?: string
  coverUrl?: string
}

export type ExternalImportResult = {
  playlistId?: string
  playlistName: string
  tracksTotal: number
  tracksMatched: number
  missingCount: number
}

export type MissingTracksDb = {
  reconcileMissingTracks: (
    playlistId: number,
    tracks: Array<{
      artistName: string
      trackName: string
      albumTitle?: string
      coverUrl?: string
      reason?: 'not_found' | 'search_error'
    }>,
  ) => Promise<void>
}

/**
 * Mirrors an exact external playlist (Spotify/Deezer) into a real Plex
 * playlist, track by track -- not the artist-level "seed recommendations"
 * behavior of the subscriptions system. Plex's own track search silently
 * skips songs it can't find (see targets/plex-playlist.ts); every skipped
 * track is reconciled into playlist_missing_tracks (db/queries/playlist-missing-tracks.ts)
 * instead of being flagged as a fresh recommendation on every re-sync --
 * that used to stack an unbounded number of duplicate recommendation rows
 * for anything that stayed missing across syncs.
 */
export async function importExternalPlaylistToPlex(opts: {
  name: string
  tracks: ExternalTrack[]
  plex: { url: string; token: string }
  targetId: number
  playlistId: number
  // Whether this sync should actually push the mirrored tracks to Plex, or
  // just resolve/report what's missing without touching the Plex playlist
  // (see playlists.autoPushToPlex).
  pushToPlex: boolean
  missingTracksDb: MissingTracksDb
}): Promise<ExternalImportResult> {
  const target = createPlexPlaylistTarget(opts.targetId, opts.plex)

  const items = opts.tracks.map((t) => ({
    artistName: t.artistName,
    artistMbid: '',
    trackName: t.trackName,
  }))

  const result = await target.createPlaylist?.(opts.name, items, { dryRun: !opts.pushToPlex })
  if (!result?.success) {
    throw new Error(result?.error ?? 'Failed to create Plex playlist')
  }

  // Dedupe unmatched tracks down to one entry per (artist, track).
  const missingByKey = new Map<
    string,
    {
      artistName: string
      trackName: string
      albumTitle?: string
      coverUrl?: string
      reason?: 'not_found' | 'search_error'
    }
  >()
  for (const item of result.unmatchedItems ?? []) {
    if (!item.trackName) continue
    const original = opts.tracks.find(
      (t) => t.artistName === item.artistName && t.trackName === item.trackName,
    )
    const key = `${item.artistName.toLowerCase()}::${item.trackName.toLowerCase()}`
    if (!missingByKey.has(key)) {
      missingByKey.set(key, {
        artistName: item.artistName,
        trackName: item.trackName,
        albumTitle: original?.albumTitle,
        coverUrl: original?.coverUrl,
        reason: item.reason,
      })
    }
  }

  const missingTracks = [...missingByKey.values()]
  await opts.missingTracksDb.reconcileMissingTracks(opts.playlistId, missingTracks)

  return {
    playlistId: result.playlistId,
    playlistName: result.playlistName ?? opts.name,
    tracksTotal: opts.tracks.length,
    tracksMatched: result.itemsAdded ?? 0,
    missingCount: missingTracks.length,
  }
}
