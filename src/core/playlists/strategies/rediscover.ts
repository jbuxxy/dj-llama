import type { PlaylistStrategyImpl, StrategyArtist, StrategyDeps } from './types'
import { TRACKS_PER_ARTIST } from './types'

const OLDER_THAN_DAYS = 30

export const rediscoverStrategy: PlaylistStrategyImpl = {
  async selectArtists(
    deps: StrategyDeps,
    config: { size: number; genre?: string; mood?: string },
  ): Promise<StrategyArtist[]> {
    const olderThan = new Date()
    olderThan.setDate(olderThan.getDate() - OLDER_THAN_DAYS)

    const artistLimit = Math.ceil(config.size / TRACKS_PER_ARTIST)

    // Prefer real listening history (liked/previously played, nothing recent)
    // over the approved-recommendations pool -- "haven't played in 30+ days"
    // should mean exactly that, not "hasn't been reviewed in the discovery
    // queue in 30+ days."
    if (deps.getDormantTasteArtists) {
      const dormant = await deps.getDormantTasteArtists({ olderThan, limit: artistLimit })
      if (dormant.length > 0) return dormant
    }

    const artists = await deps.getOlderApprovedArtists({ olderThan, limit: artistLimit })

    return artists.sort((a, b) => b.score - a.score).slice(0, artistLimit)
  },
}
