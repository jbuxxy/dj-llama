import type { PlaylistStrategyImpl, StrategyArtist, StrategyDeps } from './types'
import { TRACKS_PER_ARTIST } from './types'

export const weeklyDigestStrategy: PlaylistStrategyImpl = {
  async selectArtists(
    deps: StrategyDeps,
    config: { size: number; genre?: string; mood?: string },
  ): Promise<StrategyArtist[]> {
    const artistLimit = Math.ceil(config.size / TRACKS_PER_ARTIST)

    // Prefer the track-level taste profile (liked tracks/recent plays/past
    // requests, weighted -- see track-taste.ts) when it's available and
    // actually produced something -- heavier emphasis on what the listener
    // has been into *recently* than the flat approved-recommendations pool
    // below. Falls back for users with no connected listening source.
    if (deps.getTrackTasteWeightedArtists) {
      const tasteWeighted = await deps.getTrackTasteWeightedArtists({ limit: artistLimit })
      if (tasteWeighted.length > 0) return tasteWeighted
    }

    const since = new Date()
    since.setDate(since.getDate() - 7)

    const artists = await deps.getApprovedArtists({ since, limit: artistLimit })

    return artists.sort((a, b) => b.score - a.score).slice(0, artistLimit)
  },
}
