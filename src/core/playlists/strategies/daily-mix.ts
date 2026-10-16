import { clusterIntoMixes } from '../daily-mix'
import { weightedSample } from '../random'
import type { PlaylistStrategyImpl, StrategyArtist, StrategyDeps } from './types'
import { TRACKS_PER_ARTIST } from './types'

export const DAILY_MIX_COUNT = 3

// Wide enough that clustering has real genre buckets to work with even for
// a user with a modest amount of listening signal, bounded so it never grows
// unreasonably for a very active library.
const CANDIDATE_POOL_MULTIPLIER = 20

// Holiday-only artists (Christmas standards, etc.) tend to dominate a
// user's plays for a few weeks a year -- left in, they'd crowd out the rest
// of the taste profile the other eleven months and show up in an "everyday"
// mix in July.
const HOLIDAY_GENRE_KEYWORDS = ['christmas', 'holiday', 'xmas']

// Same keyword set, applied to individual track titles during track
// resolution (see generator.ts/track-resolver.ts) -- the artist-genre filter
// below only catches dedicated holiday artists; a mainstream artist's one
// Christmas single/cover survives it and needs to be caught at the track
// level instead.
export const HOLIDAY_TITLE_KEYWORDS = HOLIDAY_GENRE_KEYWORDS

function isHolidayArtist(artist: StrategyArtist): boolean {
  return (artist.genres ?? []).some((genre) =>
    HOLIDAY_GENRE_KEYWORDS.some((keyword) => genre.toLowerCase().includes(keyword)),
  )
}

export const dailyMixStrategy: PlaylistStrategyImpl = {
  async selectArtists(
    deps: StrategyDeps,
    config: { size: number; mixIndex?: number },
  ): Promise<StrategyArtist[]> {
    if (!deps.getTrackTasteWeightedArtists) return []

    const artistLimit = Math.ceil(config.size / TRACKS_PER_ARTIST)
    const rawPool = await deps.getTrackTasteWeightedArtists({
      limit: artistLimit * CANDIDATE_POOL_MULTIPLIER,
      includeLibraryFiller: true,
    })
    const pool = rawPool.filter((artist) => !isHolidayArtist(artist))
    if (pool.length === 0) return []

    const buckets = clusterIntoMixes(pool, DAILY_MIX_COUNT)
    const bucket = buckets[config.mixIndex ?? 0]
    if (!bucket) return []

    // sqrt-dampened rather than raw score: keeps top-taste artists favored
    // (Daily Mix should still reflect what you actually listen to) without
    // letting them dominate the weighted draw so heavily that the same
    // handful of artists get picked on nearly every regeneration -- see
    // strategy-deps.ts's includeLibraryFiller for the matching widen-the-pool
    // half of this fix.
    return weightedSample(bucket.artists, artistLimit, (a) => Math.sqrt(a.score))
  },
}
