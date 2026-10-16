import type { GenreSource, ServiceTestResult } from '@/core/types'

export type TopArtistEntry = {
  name: string
  mbid?: string
  playCount: number
  source: string
  genres?: string[]
  genreSource?: GenreSource
}

export type SimilarArtistEntry = {
  name: string
  mbid?: string
  similarityScore: number
  source: string
}

export type ListeningActivityEntry = {
  listen_count: number
  from_ts: number
  to_ts: number
}

export type GenreArtistEntry = {
  name: string
  mbid?: string
  listeners: number
  source: string
}

// A track the user has explicitly signaled they like: liked/saved (Spotify),
// rated highly (Plex), or sitting in a favorites-style playlist (Plex).
// Higher-confidence signal than raw play history -- see track-taste.ts for
// how it's weighted.
export type LikedTrackEntry = {
  trackName: string
  artistName: string
  albumTitle?: string
  // Recording MBID, when the source can provide one directly rather than
  // needing a fuzzy artist+title match later.
  mbid?: string
  addedAt?: Date
  source: string
}

// An album newly added to the library -- distinct from LikedTrackEntry
// (explicit like/favorite signal) and recent plays (listening signal): this
// is "just showed up," no listening or rating involved yet.
export type RecentlyAddedEntry = {
  albumTitle: string
  artistName: string
  addedAt: Date
}

export type SourceCapability =
  | 'topArtists'
  | 'similarArtists'
  | 'genreArtists'
  | 'recentListening'
  | 'listeningActivity'
  | 'likedTracks'
  | 'recentlyAdded'

export interface DiscoverySource {
  id: string
  name: string
  capabilities: SourceCapability[]
  getTopArtists(limit?: number): Promise<TopArtistEntry[]>
  getSimilarArtists(artistName: string, mbid?: string): Promise<SimilarArtistEntry[]>
  testConnection(): Promise<ServiceTestResult>
  getListeningActivity?(): Promise<ListeningActivityEntry[]>
  getGenreArtists?(genre: string, options?: { limit?: number }): Promise<GenreArtistEntry[]>
  getArtistGenres?(artistName: string, mbid?: string): Promise<string[]>
  getRecentListening?(limit?: number): Promise<{ name: string; track?: string; playedAt: Date }[]>
  // Optional: sources with no reliable liked/favorite-track concept (Deezer
  // while its OAuth app is disabled) simply never implement this -- callers
  // must treat it as "no signal," never as an error.
  getLikedTracks?(limit?: number): Promise<LikedTrackEntry[]>
  getRecentlyAdded?(limit?: number): Promise<RecentlyAddedEntry[]>
}
