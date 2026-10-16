import { getSeasonalPreset } from '../seasonal-presets'
import type { PlaylistStrategyImpl, StrategyArtist, StrategyDeps } from './types'
import { TRACKS_PER_ARTIST } from './types'

// Same normalize+substring approach mood-mix.ts uses for MOOD_ALIASES, just
// against a preset's own fixed keyword list instead of a free-text mood.
function normalize(value: string): string {
  return value
    .toLowerCase()
    .replaceAll('&', ' and ')
    .replaceAll(/[^a-z0-9]+/g, ' ')
    .trim()
}

function artistMatchesKeywords(artist: StrategyArtist, keywords: string[]): boolean {
  if (!artist.genres || artist.genres.length === 0) return false
  const normalizedKeywords = keywords.map(normalize)
  return artist.genres.some((genre) => {
    const normalizedGenre = normalize(genre)
    return normalizedKeywords.some((keyword) => normalizedGenre.includes(keyword))
  })
}

// A genre-tag match is a boost, never a hard filter -- same lesson learned
// from daily_mix's variety bug: an artist-genre-only filter over a narrow
// "explicitly approved" pool structurally can't surface a mainstream artist
// who isn't genre-tagged for the occasion (Mariah Carey has no "christmas"
// genre tag, but has the most famous Christmas song there is). The pool
// itself (below) is now the same broad taste+library one daily_mix uses,
// and which *track* actually gets picked for a selected artist is handled
// separately, by title-keyword matching during resolution (see
// generator.ts's includeTitleKeywords / track-resolver.ts's
// prioritizeByTitle) -- getting selected as an artist here only gets you in
// the room.
const ICONIC_KEYWORD_MATCH_BOOST = 4
const BLEND_KEYWORD_MATCH_BOOST = 1.5

export const seasonalStrategy: PlaylistStrategyImpl = {
  async selectArtists(
    deps: StrategyDeps,
    config: { size: number; presetKey?: string },
  ): Promise<StrategyArtist[]> {
    const artistLimit = Math.ceil(config.size / TRACKS_PER_ARTIST)
    const poolLimit = artistLimit * 5

    const preset = getSeasonalPreset(config.presetKey)

    // Same broad pool daily_mix uses (taste-weighted plays/likes, padded
    // with the rest of the tagged library as filler) rather than the
    // approved-recommendations-only pool -- that pool is inherently small
    // and excludes most of what's actually in the user's library/taste
    // unless they happened to previously approve a recommendation for it.
    const pool = deps.getTrackTasteWeightedArtists
      ? await deps.getTrackTasteWeightedArtists({ limit: poolLimit, includeLibraryFiller: true })
      : await deps.getApprovedArtists({ limit: poolLimit })

    if (!preset) {
      return pool.sort((a, b) => b.score - a.score).slice(0, artistLimit)
    }

    const boost = preset.blendWithTaste ? BLEND_KEYWORD_MATCH_BOOST : ICONIC_KEYWORD_MATCH_BOOST
    return pool
      .map((a) => ({
        ...a,
        score: artistMatchesKeywords(a, preset.genreKeywords) ? a.score * boost : a.score,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, artistLimit)
  },
}
