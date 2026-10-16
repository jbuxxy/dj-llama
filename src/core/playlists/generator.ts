import type { PlaylistStrategy } from '@/db/schema'
import {
  generateDailyMixTitle,
  generateMixDescription,
  generateMixTitle,
  pickDominantGenre,
} from './mix-title'
import { shuffled } from './random'
import {
  generateSeasonalTracks,
  type SeasonalCandidate,
  type SeasonalTrackRef,
} from './seasonal-generator'
import { fetchOnlineSeasonalSongs } from './seasonal-online'
import { getSeasonalPreset } from './seasonal-presets'
import { aiPromptStrategy } from './strategies/ai-prompt'
import { dailyMixStrategy, HOLIDAY_TITLE_KEYWORDS } from './strategies/daily-mix'
import { genreFocusStrategy } from './strategies/genre-focus'
import { moodMixStrategy } from './strategies/mood-mix'
import { rediscoverStrategy } from './strategies/rediscover'
import { seasonalStrategy } from './strategies/seasonal'
import type { PlaylistStrategyImpl, StrategyDeps } from './strategies/types'
import { weeklyDigestStrategy } from './strategies/weekly-digest'
import { resolvePlaylistTracks } from './track-resolver'
import type { ResolvedTrack, TrackResolverConfig, TrackResolverDeps } from './types'

export type GenerationResult = {
  tracks: ResolvedTrack[]
  artistCount: number
  strategy: string
  // Evocative generated title, ai_prompt (Mediasage) and daily_mix only --
  // e.g. "Golden Hour Groove - Jul 2026" for Mediasage, "Daily Mix 1: Golden
  // Hour Indie Rock" for Daily Mix -- instead of a name the user typed.
  mixTitle?: string
  // One-sentence blurb accompanying mixTitle, woven from whatever
  // genre/decade filters were picked (see mix-title.ts's generateMixDescription).
  mixDescription?: string
  // Seasonal only: the rest of the eligible seasonal candidates (best
  // first), stored on the playlist for instant replacement suggestions.
  seasonalCandidates?: SeasonalCandidate[]
}

export function getStrategy(strategy: PlaylistStrategy): PlaylistStrategyImpl {
  switch (strategy) {
    case 'weekly_digest':
      return weeklyDigestStrategy
    case 'genre_focus':
      return genreFocusStrategy
    case 'mood_mix':
      return moodMixStrategy
    case 'rediscover':
      return rediscoverStrategy
    case 'seasonal':
      return seasonalStrategy
    case 'ai_prompt':
      return aiPromptStrategy
    case 'daily_mix':
      return dailyMixStrategy
    case 'import':
      // Import mirrors an exact external playlist track-by-track and has no
      // artist-selection step at all -- executePlaylistGeneration (index.ts)
      // branches on strategy === 'import' before ever calling
      // generatePlaylist(), so this case only exists to satisfy the
      // exhaustiveness check below.
      throw new Error("'import' strategy is handled directly, not via generatePlaylist()")
    default: {
      // TypeScript exhaustiveness check - if PlaylistStrategy ever gains a new
      // variant and getStrategy isn't updated, this throws at runtime.
      const _exhaustive: never = strategy
      throw new Error(`Unknown playlist strategy: ${_exhaustive}`)
    }
  }
}

export async function generatePlaylist(
  strategy: PlaylistStrategy,
  config: {
    size: number
    genre?: string
    mood?: string
    presetKey?: string
    prompt?: string
    useListeningHistory?: boolean
    genreFilters?: string[]
    decadeFilters?: number[]
    excludeLiveVersions?: boolean
    trackSourcePriority: ('local' | 'spotify' | 'deezer')[]
    mixIndex?: number
    // Seasonal only: user edits that survive regeneration.
    excludedTracks?: SeasonalTrackRef[]
    pinnedTracks?: SeasonalTrackRef[]
  },
  strategyDeps: StrategyDeps,
  resolverDeps: TrackResolverDeps,
): Promise<GenerationResult> {
  // Seasonal playlists are built song-first from the library (see
  // seasonal-generator.ts) whenever Plex is connected; the artist-first
  // strategy below is only the no-library fallback.
  const preset = strategy === 'seasonal' ? getSeasonalPreset(config.presetKey) : undefined
  if (preset && resolverDeps.plexSearch) {
    const plexSearch = resolverDeps.plexSearch
    const result = await generateSeasonalTracks(
      {
        getArtistTracks: plexSearch,
        searchByTitle: resolverDeps.plexTitleSearch,
        getLibraryArtistKeys: strategyDeps.getLibraryArtistKeys,
        getTasteArtists: strategyDeps.getTrackTasteWeightedArtists
          ? () =>
              // biome-ignore lint/style/noNonNullAssertion: checked just above
              strategyDeps.getTrackTasteWeightedArtists!({
                limit: 400,
                includeLibraryFiller: true,
              })
          : undefined,
        fetchOnlineSongs: (p) => fetchOnlineSeasonalSongs(p),
      },
      {
        preset,
        size: config.size,
        excluded: config.excludedTracks,
        pinned: config.pinnedTracks,
      },
    )
    return {
      tracks: result.tracks,
      artistCount: new Set(result.tracks.map((t) => t.artistName)).size,
      strategy,
      seasonalCandidates: result.candidates,
    }
  }

  const impl = getStrategy(strategy)

  const artists = await impl.selectArtists(strategyDeps, {
    size: config.size,
    genre: config.genre,
    mood: config.mood,
    presetKey: config.presetKey,
    prompt: config.prompt,
    useListeningHistory: config.useListeningHistory,
    genreFilters: config.genreFilters,
    mixIndex: config.mixIndex,
    decadeFilters: config.decadeFilters,
    excludeLiveVersions: config.excludeLiveVersions,
  })

  const seasonalPreset = strategy === 'seasonal' ? getSeasonalPreset(config.presetKey) : undefined

  const resolverConfig: TrackResolverConfig = {
    tracksPerArtist: 3,
    sourcePriority: config.trackSourcePriority,
    excludeTitleKeywords: strategy === 'daily_mix' ? HOLIDAY_TITLE_KEYWORDS : undefined,
    // No per-track genre data exists (see TrackResolverConfig), so a
    // mainstream artist's one seasonal single/cover is only findable by
    // title text -- being selected as one of the playlist's artists only
    // gets them in the room; this is what actually gets their Halloween/
    // Christmas song picked over the rest of their catalog.
    includeTitleKeywords: seasonalPreset?.titleKeywords,
  }

  const hasResolverDeps = Object.keys(resolverDeps).length > 0

  let tracks: ResolvedTrack[]

  if (hasResolverDeps) {
    const allTracks = await resolvePlaylistTracks(artists, resolverDeps, resolverConfig)
    // Track resolution is grouped by artist (all of artist A's picks, then
    // all of artist B's, ...) -- interleave before trimming to size so the
    // final playlist doesn't play as a run of one artist's songs at a time.
    tracks = shuffled(allTracks).slice(0, config.size)
  } else {
    // No track resolver deps configured - create artist-level entries
    // so playlists still show the selected artists
    tracks = artists.slice(0, config.size).map((a) => ({
      artistName: a.name,
      trackName: `Top tracks by ${a.name}`,
      mbid: a.mbid,
      source: 'musicbrainz' as const,
    }))
  }

  const isMediasage = strategy === 'ai_prompt'
  const isDailyMix = strategy === 'daily_mix'

  return {
    tracks,
    artistCount: artists.length,
    strategy,
    // Only the strategies the user never names get a generated title:
    // Mediasage (ai_prompt) gets a fully evocative one, and Daily Mix keeps
    // its fixed "Daily Mix N" identity paired with a genre-aware subtitle
    // drawn from this bucket's actual artists (e.g. "Daily Mix 1: Golden
    // Hour Indie Rock"). Curated playlists (Weekly Digest, Genre Focus, Mood
    // Mix, Rediscover) are named by the user and keep that name.
    mixTitle: isMediasage
      ? generateMixTitle()
      : isDailyMix
        ? generateDailyMixTitle(config.mixIndex ?? 0, pickDominantGenre(artists))
        : undefined,
    mixDescription: isMediasage
      ? generateMixDescription({ genres: config.genreFilters, decades: config.decadeFilters })
      : undefined,
  }
}
