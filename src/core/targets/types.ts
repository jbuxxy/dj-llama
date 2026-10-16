import type { ServiceTestResult } from '@/core/types'

export type TargetCapability = 'addArtist' | 'addAlbum' | 'createPlaylist' | 'deletePlaylist'

export const TARGET_TYPES = ['lidarr', 'plex-playlist', 'export'] as const
export type TargetType = (typeof TARGET_TYPES)[number]

export type TargetAddOptions = {
  monitorOption?: 'all' | 'new' | 'none' | 'selected'
  selectedAlbumIds?: string[]
  qualityProfileId?: number
  metadataProfileId?: number
  rootFolderId?: number
  userId?: number
  recommendationId?: number
  lidarrArtistId?: number
}

export type TargetResult = {
  success: boolean
  targetType: string
  targetId: number
  externalId?: number | string
  error?: string
  /** Non-fatal partial-failure note (e.g. artist added but album monitoring did not complete). */
  warning?: string
}

export type PlaylistItem = {
  artistName: string
  artistMbid: string
  trackName?: string
  trackMbid?: string
}

export type UnmatchedPlaylistItem = PlaylistItem & {
  /** 'not_found' = no matching track in the library; 'search_error' = the lookup itself failed/timed out. */
  reason?: 'not_found' | 'search_error'
}

export type PlaylistResult = {
  success: boolean
  targetType: string
  targetId: number
  playlistId?: string
  playlistName?: string
  itemsAdded?: number
  error?: string
  /** Items that could not be matched/added, so callers can react (e.g. flag as a missing-album recommendation). */
  unmatchedItems?: UnmatchedPlaylistItem[]
}

export interface DestinationTarget {
  id: string
  name: string
  type: TargetType
  capabilities: TargetCapability[]

  addArtist?(
    artist: { mbid: string; name: string },
    options?: TargetAddOptions,
  ): Promise<TargetResult>

  addAlbum?(
    album: { artistMbid: string; artistName: string; releaseGroupMbid: string },
    options?: TargetAddOptions,
  ): Promise<TargetResult>

  /** Cancel a whole-discography request: removes the artist entirely (keeps files by default). */
  removeArtist?(
    externalId: number | string,
    options?: { deleteFiles?: boolean },
  ): Promise<TargetResult>

  /** Cancel a single-album request: stops Lidarr searching for it without touching the artist. */
  unmonitorAlbum?(externalId: number | string): Promise<TargetResult>

  createPlaylist?(
    name: string,
    items: PlaylistItem[],
    options?: {
      description?: string
      public?: boolean
      replace?: boolean
      /** Resolve matched/unmatched items without touching the actual Plex playlist. */
      dryRun?: boolean
    },
  ): Promise<PlaylistResult>

  /** Looked up by name (playlist IDs aren't persisted anywhere) -- a no-op success if nothing matches. */
  deletePlaylist?(name: string): Promise<PlaylistResult>

  testConnection(): Promise<ServiceTestResult>
}

export type ExportableRecommendation = {
  artistName: string
  artistMbid: string
  genres: string[]
  score: number
  status: string
  aiReasoning?: string
  imageUrl?: string
  streamingUrls: Record<string, string>
  createdAt: string
  suggestedAlbum?: string
}

/** Resolve the best streaming URL for a recommendation, falling back to MusicBrainz. */
export function getStreamingUrl(rec: ExportableRecommendation): string {
  return (
    rec.streamingUrls.spotify ??
    rec.streamingUrls.youtube ??
    rec.streamingUrls.deezer ??
    `https://musicbrainz.org/artist/${rec.artistMbid}`
  )
}
