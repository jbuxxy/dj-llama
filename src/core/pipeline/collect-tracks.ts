import type { DiscoverySource, LikedTrackEntry, RecentlyAddedEntry } from '@/core/plugins/types'
import type { RecentPlayEntry } from './track-taste'

export type CollectLikedTracksResult = {
  tracks: LikedTrackEntry[]
  perSourceCounts: Record<string, number>
}

/**
 * Fetches liked/favorited tracks from every connected source that implements
 * `getLikedTracks`. One failing or unsupported source must not affect the
 * others -- mirrors analyze()'s Promise.allSettled pattern exactly.
 */
export async function collectLikedTracks(
  sources: DiscoverySource[],
  limit?: number,
): Promise<CollectLikedTracksResult> {
  const withLikedTracks = sources.filter((s) => typeof s.getLikedTracks === 'function')

  const results = await Promise.allSettled(
    withLikedTracks.map(async (source) => ({
      id: source.id,
      tracks: await source.getLikedTracks?.(limit),
    })),
  )

  const tracks: LikedTrackEntry[] = []
  const perSourceCounts: Record<string, number> = {}

  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    const sourceId = withLikedTracks[i]?.id ?? 'unknown'
    if (r?.status !== 'fulfilled') {
      const reason = r && r.status === 'rejected' ? r.reason : 'unknown'
      const msg = reason instanceof Error ? reason.message : String(reason)
      console.warn(`[collect-tracks] source ${sourceId} failed: ${msg}`)
      continue
    }
    const sourceTracks = r.value.tracks ?? []
    perSourceCounts[sourceId] = sourceTracks.length
    for (const t of sourceTracks) tracks.push(t)
  }

  return { tracks, perSourceCounts }
}

/**
 * Recent-play counterpart to collectLikedTracks -- gathers getRecentListening
 * results (already implemented by Plex/Spotify) across every source that has
 * it, same Promise.allSettled/skip-on-failure shape.
 *
 * `plexWebhookPlays`, when provided and non-empty, replaces polling Plex's
 * own getRecentListening() -- these come from Plex's native webhook feature
 * (push, real-time) rather than a poll, so they're strictly fresher. Every
 * other connected source still polls normally; only Plex has a push option.
 */
export async function collectRecentPlays(
  sources: DiscoverySource[],
  limit?: number,
  plexWebhookPlays?: RecentPlayEntry[],
): Promise<RecentPlayEntry[]> {
  const useWebhook = !!plexWebhookPlays && plexWebhookPlays.length > 0
  const pollSources = (useWebhook ? sources.filter((s) => s.id !== 'plex') : sources).filter(
    (s) => typeof s.getRecentListening === 'function',
  )

  const results = await Promise.allSettled(
    pollSources.map((source) => source.getRecentListening?.(limit)),
  )

  const plays: RecentPlayEntry[] = useWebhook ? [...(plexWebhookPlays ?? [])] : []
  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    const sourceId = pollSources[i]?.id ?? 'unknown'
    if (r?.status !== 'fulfilled') {
      const reason = r && r.status === 'rejected' ? r.reason : 'unknown'
      const msg = reason instanceof Error ? reason.message : String(reason)
      console.warn(`[collect-tracks] source ${sourceId} getRecentListening failed: ${msg}`)
      continue
    }
    for (const entry of r.value ?? []) {
      plays.push({ artistName: entry.name, trackName: entry.track, playedAt: entry.playedAt })
    }
  }

  return plays
}

/**
 * Recently-added-albums counterpart to collectLikedTracks/collectRecentPlays
 * -- same Promise.allSettled/skip-on-failure shape, gathers getRecentlyAdded
 * across every source that implements it.
 */
export async function collectRecentlyAdded(
  sources: DiscoverySource[],
  limit?: number,
): Promise<RecentlyAddedEntry[]> {
  const withRecentlyAdded = sources.filter((s) => typeof s.getRecentlyAdded === 'function')

  const results = await Promise.allSettled(
    withRecentlyAdded.map((source) => source.getRecentlyAdded?.(limit)),
  )

  const albums: RecentlyAddedEntry[] = []
  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    const sourceId = withRecentlyAdded[i]?.id ?? 'unknown'
    if (r?.status !== 'fulfilled') {
      const reason = r && r.status === 'rejected' ? r.reason : 'unknown'
      const msg = reason instanceof Error ? reason.message : String(reason)
      console.warn(`[collect-tracks] source ${sourceId} getRecentlyAdded failed: ${msg}`)
      continue
    }
    for (const entry of r.value ?? []) albums.push(entry)
  }

  return albums
}
