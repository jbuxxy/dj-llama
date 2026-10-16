export type GenreSource = 'native' | 'library' | 'artist-cache'

export type GenreCoverage = {
  coveredArtists: number
  pendingArtists: number
  totalArtists: number
}

export type TasteProfile = {
  topArtists: Array<{
    name: string
    mbid?: string
    playCount: number
    source: string
    genres?: string[]
    genreSource?: GenreSource
  }>
  topGenres: Array<{ name: string; weight: number }>
  genreCoverage?: GenreCoverage
  listeningPatterns: {
    totalListens: number
    recentTrend: 'increasing' | 'stable' | 'decreasing'
  }
  _rawPrompt?: string
}

// Weighted, deduped view of a user's most-significant tracks across every
// connected source -- liked/favorited (highest confidence), recent plays,
// and past album requests (lowest confidence, still a real signal). See
// core/pipeline/track-taste.ts for how weight is computed.
export type TrackTasteSignal = {
  // Absent for 'request_history' signals -- a past request names an
  // artist/album, never a specific track, so there's nothing to seed a
  // track-similarity lookup from; Phase 2's discovery step should fall back
  // to artist/album-level weighting for signals with no trackName.
  trackName?: string
  artistName: string
  albumTitle?: string
  mbid?: string
  /** 0..1+, already decayed/normalized -- summed (not maxed) across signal types when a track recurs. */
  weight: number
  signalType: 'liked' | 'recent_play' | 'request_history' | 'popular' | 'recently_added'
  source: string
}

// Wraps rather than replaces TasteProfile: everything downstream that only
// ever wanted artist-level data (score.ts's genre overlap, the top-artist
// exclusion filter in orchestrator.ts) keeps working against `topArtists`/
// `topGenres`/`listeningPatterns` untouched. `signals` is the new part.
export type TrackTasteProfile = {
  signals: TrackTasteSignal[]
  topArtists: TasteProfile['topArtists']
  topGenres: TasteProfile['topGenres']
  listeningPatterns: TasteProfile['listeningPatterns']
}

export type AiRecommendation = {
  artistName: string
  reasoning: string
  confidence: number
  genres: string[]
  suggestedAlbum?: string
  // Populated only by the track-based discovery prompt (buildTrackRecommendationPrompt)
  // -- ordinary artist-similarity prompts never ask for this, so it stays
  // undefined there. Present here (rather than a parallel schema) so every AI
  // provider gets track support for free, no per-provider changes needed.
  trackName?: string
}

export type DiscoveredArtist = {
  name: string
  mbid?: string
  similarityScore: number
  aiReasoning?: string
  suggestedAlbum?: string
  /** The artist's song to start with (AI artist picks); its album is what gets recommended. */
  trackName?: string
  genres?: string[]
  source: string
  sourceUrl?: string
  /** Release-group MBID when this discovery is an album candidate (release-radar). */
  releaseGroupMbid?: string
  /** ISO release date (firstReleaseDate) for album candidates; feeds recency. */
  releaseDate?: string
}

export type ResolvedArtist = {
  mbid: string
  name: string
  disambiguation?: string
  tags: string[]
  genres: string[]
  imageUrl?: string
  logoUrl?: string
  imageFailed?: boolean
  streamingUrls: Record<string, string>
  suggestedAlbum?: { releaseGroupId?: string; title: string; type?: string }
  discoveries: DiscoveredArtist[]
  beginYear?: number
  endYear?: number
  /** 'album' when this resolves to a first-class album recommendation. */
  kind?: 'artist' | 'album'
  /** Release-group MBID for album-kind; feeds the filter-stage album dedup/block. */
  releaseGroupMbid?: string
  /** ISO release date for album-kind; feeds the recency signal. */
  releaseDate?: string
}

export type ScoredArtist = ResolvedArtist & {
  score: number
  sourceScores: Record<string, number>
  aiReasoning?: string
}

export type PipelineStage =
  | 'collect'
  | 'analyze'
  | 'discover'
  | 'resolve'
  | 'score'
  | 'filter'
  | 'store'
  | 'complete'

export type PipelineProgress = {
  stage: PipelineStage
  current?: number
  total?: number
  message?: string
}

export type ServiceTestResult = {
  success: boolean
  message: string
  details?: Record<string, unknown>
}
