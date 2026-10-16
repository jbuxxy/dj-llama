import type { PlaylistStrategyImpl, StrategyArtist, StrategyDeps } from './types'
import { TRACKS_PER_ARTIST } from './types'

export const genreFocusStrategy: PlaylistStrategyImpl = {
  async selectArtists(
    deps: StrategyDeps,
    config: { size: number; genre?: string; mood?: string },
  ): Promise<StrategyArtist[]> {
    const artistLimit = Math.ceil(config.size / TRACKS_PER_ARTIST)

    // Prefer the listener's own taste (liked tracks/recent plays/past
    // requests, scoped to this genre) over the flat approved-recommendations
    // pool -- same fallback pattern weekly_digest established. Library filler
    // widens a niche genre beyond just what's already been played/liked.
    if (deps.getTrackTasteWeightedArtists) {
      const tasteWeighted = await deps.getTrackTasteWeightedArtists({
        limit: artistLimit,
        genreKeywords: config.genre ? [config.genre] : undefined,
        includeLibraryFiller: true,
      })
      if (tasteWeighted.length > 0) return tasteWeighted
    }

    const artists = await deps.getApprovedArtists({ genre: config.genre, limit: artistLimit })

    return artists.sort((a, b) => b.score - a.score).slice(0, artistLimit)
  },
}
