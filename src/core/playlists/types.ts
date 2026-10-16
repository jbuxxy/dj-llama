export type ResolvedTrack = {
  artistName: string
  trackName: string
  mbid?: string
  spotifyUri?: string
  deezerId?: string
  localPath?: string
  source: 'local' | 'spotify' | 'deezer' | 'musicbrainz'
}

export type SpotifySearchResult = {
  name: string
  artists: string[]
  uri: string
  popularity: number
}

export type DeezerTrackSearchResult = {
  id: string
  name: string
  artists: string[]
  rank: number
}

export type LocalTrack = {
  name: string
  artist: string
  path: string
  duration?: number
  userRating?: number
  viewCount?: number
}

export type MBRecording = {
  id: string
  title: string
  isrcs?: string[]
}

export type TrackResolverDeps = {
  spotifySearch?: (query: string, limit?: number) => Promise<SpotifySearchResult[]>
  deezerSearch?: (query: string, limit?: number) => Promise<DeezerTrackSearchResult[]>
  plexSearch?: (artist: string) => Promise<LocalTrack[]>
  // Library-wide title search (seasonal playlists): substring match on the
  // track title across every artist, not just one artist's catalog.
  plexTitleSearch?: (query: string) => Promise<LocalTrack[]>
  musicbrainzRecordings?: (artistMbid: string) => Promise<MBRecording[]>
}

export type TrackResolverConfig = {
  tracksPerArtist: number
  sourcePriority: ('local' | 'spotify' | 'deezer')[]
  // Daily Mix only: drop candidate tracks whose title contains one of these
  // (e.g. "christmas") before weighting/sampling. The artist-genre holiday
  // filter upstream (strategies/daily-mix.ts) only catches dedicated holiday
  // artists; this catches a mainstream artist's one holiday single/cover,
  // which is the only place that data is visible (no album/track genre data
  // exists in the schema, so title text is the only signal available).
  excludeTitleKeywords?: string[]
  // Seasonal only: the inverse of excludeTitleKeywords -- when an artist's
  // fetched candidate tracks include one whose title matches (e.g.
  // "christmas"), prefer it over the rest of their catalog instead of
  // whatever's generally most popular/played. Same reasoning as above (title
  // text is the only per-track signal available): this is what actually
  // surfaces a mainstream artist's one holiday single -- being selected as
  // one of the playlist's artists at all only gets you in the room, it
  // doesn't get the right song picked once you're there.
  includeTitleKeywords?: string[]
}
