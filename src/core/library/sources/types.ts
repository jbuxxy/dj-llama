import type { ServiceTestResult } from '@/core/types'

export type LibrarySourceCapability = 'listArtists' | 'listAlbums'

export type LibraryArtist = {
  sourceArtistId: string
  name: string
  mbid?: string
  genres?: string[]
  knownAlbumTitles?: string[]
}

export type LibraryAlbum = {
  sourceAlbumId: string
  sourceArtistId: string
  title: string
  mbid?: string
  releaseYear?: number
  primaryType?: 'Album' | 'EP' | 'Single' | 'Compilation' | 'Live' | 'Other'
}

/**
 * Drives sync ordering. High-quality sources sync first so their MBIDs anchor
 * name matches from low-quality sources.
 *
 * | Source   | mbidQuality |
 * | -------- | ----------- |
 * | Lidarr   | high        |
 * | Plex     | low         |
 */
export type MbidQuality = 'high' | 'low'

export interface LibrarySource {
  id: string
  name: string
  capabilities: LibrarySourceCapability[]
  userId: number | null
  mbidQuality: MbidQuality
  listArtists(): Promise<LibraryArtist[]>
  listAlbums?(sourceArtistId: string): Promise<LibraryAlbum[]>
  testConnection(): Promise<ServiceTestResult>
}
