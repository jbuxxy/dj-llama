export const TRACKS_PER_ARTIST = 3

export type StrategyArtist = {
  name: string
  mbid?: string
  score: number
  genres?: string[]
}

// A StrategyArtist plus which specific library album the AI selection landed
// on. Track resolution in v1 still works at the artist level (top-N tracks
// per artist -- see track-resolver.ts), so albumTitle/albumMbid ride along as
// extra context for now rather than driving per-album track resolution.
export type StrategyAlbum = StrategyArtist & {
  albumTitle: string
  albumMbid?: string
}

export type StrategyDeps = {
  getApprovedArtists: (opts: {
    since?: Date
    genre?: string
    limit?: number
  }) => Promise<StrategyArtist[]>
  getOlderApprovedArtists: (opts: { olderThan: Date; limit: number }) => Promise<StrategyArtist[]>
  // Only present when the ai_prompt strategy is selected and an AI provider
  // is configured -- picks artists for a free-text prompt from a bounded
  // candidate pool (library + approved recommendations) so the model can
  // only choose real artists, never invent one.
  selectArtistsWithAi?: (opts: { prompt: string; size: number }) => Promise<StrategyArtist[]>
  // Two-stage, filter-first album selection (mediasage-style): a free-text
  // request is scoped to the listener's real library by genre/decade/type
  // (core/playlists/library-filter.ts) before a single AI call ranks/picks
  // from that bounded, real candidate pool. Preferred over
  // selectArtistsWithAi when present; optionally blends in the listener's
  // Plex play history as additional context.
  selectAlbumsWithAi?: (opts: {
    prompt: string
    size: number
    useListeningHistory?: boolean
    genreFilters?: string[]
    decadeFilters?: number[]
    excludeLiveVersions?: boolean
  }) => Promise<StrategyAlbum[]>
  // Rolls a track-level taste profile (liked tracks > recent plays > past
  // requests, see core/pipeline/track-taste.ts) up to artist-level scores,
  // for strategies that want "heavy emphasis on most listened to
  // style/genre recently" without going through the approved-recommendations
  // pool. Optional: only present when at least one listening source is
  // connected for this playlist's owner; absent entirely for non-user-scoped
  // (global/admin) playlist generation.
  getTrackTasteWeightedArtists?: (opts: {
    limit?: number
    genreKeywords?: string[]
    // Daily Mix only: pad the taste-derived pool out with the rest of the
    // user's tagged library at a low baseline score, so a niche-genre bucket
    // isn't capped at whatever handful of artists the user happens to have
    // recently played/liked/requested (see strategy-deps.ts).
    includeLibraryFiller?: boolean
  }) => Promise<StrategyArtist[]>
  // Rediscover only: real listening-history artists (liked and/or previously
  // played) that have had no play in the last `olderThan` window -- ordered
  // most-dormant first. Distinct from getTrackTasteWeightedArtists because
  // that rolls up to a blended score with no per-artist last-played date, so
  // it can't tell "liked ages ago" apart from "played yesterday." Optional:
  // only present when at least one listening source is connected for this
  // playlist's owner.
  getDormantTasteArtists?: (opts: { olderThan: Date; limit?: number }) => Promise<StrategyArtist[]>
  // Seasonal only: normalized (normalizeArtistName) names of every artist in
  // this user's library, so seasonal song lookups skip artists they don't own.
  getLibraryArtistKeys?: () => Promise<Set<string>>
}

export interface PlaylistStrategyImpl {
  selectArtists(
    deps: StrategyDeps,
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
      mixIndex?: number
    },
  ): Promise<StrategyArtist[]>
}
