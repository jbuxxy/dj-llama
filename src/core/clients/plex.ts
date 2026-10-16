import PQueue from 'p-queue'
import type { ServiceTestResult } from '@/core/types'
import { errMsg } from '@/core/validation'
import { createHttpClient } from './http'

export type PlexTopArtist = {
  name: string
  viewCount: number
  ratingKey: string
  genres: string[]
}

export type PlexRecentTrack = {
  artistName: string
  trackName: string
  viewedAt: number
}

export type PlexFavoriteTrack = {
  trackName: string
  artistName: string
  albumTitle?: string
  addedAt?: number
}

export type PlexRecentlyAddedAlbum = {
  albumTitle: string
  artistName: string
  addedAt: number
}

type PlexSectionsResponse = {
  MediaContainer: {
    Directory: Array<{ key: string; type: string; title: string }>
  }
}

type PlexArtistsResponse = {
  MediaContainer: {
    Metadata: Array<{
      title: string
      viewCount?: number
      ratingKey: string
      Genre?: Array<{ tag: string }>
    }>
  }
}

type PlexHistoryResponse = {
  MediaContainer: {
    totalSize?: number
    Metadata?: Array<{
      type: string
      grandparentTitle: string
      title: string
      viewedAt: number
    }>
  }
}

// The server's own list of linked accounts -- `id` here is a small,
// server-local number (e.g. 1 for the owner), NOT the same id space as
// Plex's global plex.tv account id. This is the id the history endpoint's
// accountID filter actually expects.
type PlexAccountsResponse = {
  MediaContainer: {
    Account?: Array<{ id: number; name: string }>
  }
}

// Plex's server root -- the one place the human-assigned server name
// ("friendlyName", set in Plex's own server settings) lives; nothing else in
// the API surfaces it.
type PlexServerInfoResponse = {
  MediaContainer: { friendlyName?: string }
}

type PlexAllArtistsResponse = {
  MediaContainer: {
    totalSize?: number
    Metadata?: Array<{
      ratingKey: string
      title: string
      Genre?: Array<{ tag: string }>
    }>
  }
}

export type PlexLibraryArtist = {
  ratingKey: string
  name: string
  genres: string[]
}

export type PlexLibraryAlbum = {
  ratingKey: string
  artistRatingKey: string
  title: string
  releaseYear?: number
  primaryType?: 'Album'
}

export type PlexOwnedTrack = {
  name: string
  artist: string
  path: string
  // Plex's 0-10 personal rating (8+ = 4+ stars, "loved") and this user's
  // own play count -- used to bias track selection toward liked/hit songs.
  userRating?: number
  viewCount?: number
}

export type PlexMusicSection = {
  key: string
  title: string
}

export type PlexClient = {
  getMusicSectionId: () => Promise<string>
  getMusicSections: () => Promise<PlexMusicSection[]>
  getTopArtists: (limit?: number) => Promise<PlexTopArtist[]>
  getAllArtists: (options?: { pageSize?: number }) => Promise<PlexLibraryArtist[]>
  getAlbumsForArtist: (artistRatingKey: string) => Promise<PlexLibraryAlbum[]>
  getTracksForArtist: (artistName: string) => Promise<PlexOwnedTrack[]>
  searchTracksByTitle: (query: string, limit?: number) => Promise<PlexOwnedTrack[]>
  getRecentlyPlayed: (
    limit?: number,
    offset?: number,
  ) => Promise<{ tracks: PlexRecentTrack[]; total: number }>
  getRecentlyPlayedSince: (cutoffMs: number) => Promise<PlexRecentTrack[]>
  getRecentlyAddedAlbums: (limit?: number) => Promise<PlexRecentlyAddedAlbum[]>
  getFavoriteTracks: (limit?: number) => Promise<PlexFavoriteTrack[]>
  getServerName: () => Promise<string | null>
  testConnection: () => Promise<ServiceTestResult>
}

export function createPlexClient(
  url: string,
  token: string,
  options?: {
    baseUrl?: string
    sectionId?: string | null
    // Plex only exposes a managed/shared user's watch history through the
    // server owner's own token (filtered by accountID) -- a shared user's
    // own token can browse the library fine but sees no history at all.
    // When omitted, history falls back to the regular token/no filter.
    historyToken?: string | null
    // This user's Plex username, used to resolve the server-local account id
    // (via getServerAccounts()) for the history endpoint's accountID filter.
    // Not the numeric id itself -- Plex's global plex.tv account id and the
    // local per-server account id are different id spaces; passing the
    // global id directly here would silently match zero history rows.
    username?: string | null
  },
): PlexClient {
  const baseUrl = options?.baseUrl ?? url.replace(/\/+$/, '')
  const configuredSectionId = options?.sectionId?.trim() || null
  const username = options?.username ?? null

  const http = createHttpClient({
    baseUrl,
    headers: {
      'X-Plex-Token': token,
      Accept: 'application/json',
    },
  })

  const queue = new PQueue({ concurrency: 3, interval: 1000, intervalCap: 10 })

  function get<T>(path: string): Promise<T> {
    return queue.add(() => http.get<T>(path)) as Promise<T>
  }

  const historyToken = options?.historyToken || token
  const historyHttp =
    historyToken === token
      ? http
      : createHttpClient({
          baseUrl,
          headers: { 'X-Plex-Token': historyToken, Accept: 'application/json' },
        })

  function getHistory<T>(path: string): Promise<T> {
    return queue.add(() => historyHttp.get<T>(path)) as Promise<T>
  }

  // Resolved lazily and cached: undefined = not yet attempted, null = attempted
  // but no matching account found (fail open -- unscoped history beats none).
  let resolvedLocalAccountId: number | null | undefined

  async function resolveLocalAccountId(): Promise<number | null> {
    if (resolvedLocalAccountId !== undefined) return resolvedLocalAccountId
    if (!username) {
      resolvedLocalAccountId = null
      return null
    }
    try {
      const res = await getHistory<PlexAccountsResponse>('/accounts')
      const match = (res.MediaContainer.Account ?? []).find((a) => a.name === username)
      resolvedLocalAccountId = match?.id ?? null
    } catch {
      resolvedLocalAccountId = null
    }
    return resolvedLocalAccountId
  }

  // Plex uses type 'artist' for every music-shaped library, so a server with
  // both a music and an audiobook library exposes two 'artist' sections.
  async function getMusicSections(): Promise<PlexMusicSection[]> {
    const res = await get<PlexSectionsResponse>('/library/sections')
    return res.MediaContainer.Directory.filter((d) => d.type === 'artist').map((d) => ({
      key: d.key,
      title: d.title,
    }))
  }

  async function getMusicSectionId(): Promise<string> {
    if (configuredSectionId) return configuredSectionId
    const sections = await getMusicSections()
    const section = sections[0]
    if (!section) {
      throw new Error('No music library section found in Plex')
    }
    return section.key
  }

  async function getTopArtists(limit = 50): Promise<PlexTopArtist[]> {
    const sectionId = await getMusicSectionId()
    const res = await get<PlexArtistsResponse>(
      `/library/sections/${sectionId}/all?type=8&sort=viewCount:desc&X-Plex-Container-Start=0&X-Plex-Container-Size=${limit}`,
    )
    const metadata = res.MediaContainer.Metadata ?? []
    return metadata.map((m) => ({
      name: m.title,
      viewCount: m.viewCount ?? 0,
      ratingKey: m.ratingKey,
      genres: (m.Genre ?? []).map((genre) => genre.tag),
    }))
  }

  // Album-granularity (type=9), not track-level -- matches how "recently
  // added" reads in a music library/Lidarr context, and keeps this to one
  // request instead of paginating every individual track.
  async function getRecentlyAddedAlbums(limit = 50): Promise<PlexRecentlyAddedAlbum[]> {
    const sectionId = await getMusicSectionId()
    const params = new URLSearchParams({
      type: '9',
      sort: 'addedAt:desc',
      'X-Plex-Container-Start': '0',
      'X-Plex-Container-Size': String(limit),
    })
    const res = await get<{
      MediaContainer: {
        Metadata?: Array<{ title: string; parentTitle: string; addedAt?: number }>
      }
    }>(`/library/sections/${sectionId}/all?${params}`)
    const metadata = res.MediaContainer.Metadata ?? []
    return metadata.map((m) => ({
      albumTitle: m.title,
      artistName: m.parentTitle,
      addedAt: (m.addedAt ?? 0) * 1000,
    }))
  }

  async function fetchHistoryPage(
    start: number,
    size: number,
  ): Promise<{ tracks: PlexRecentTrack[]; total: number }> {
    const params = new URLSearchParams({
      sort: 'viewedAt:desc',
      'X-Plex-Container-Start': String(start),
      'X-Plex-Container-Size': String(size),
    })
    const localAccountId = await resolveLocalAccountId()
    if (localAccountId != null) params.set('accountID', String(localAccountId))
    // Without this, history is server-wide -- it includes plays from every
    // library (audiobooks, movies, etc.), not just the configured Music
    // section, and those leak into the recommendation taste profile.
    if (configuredSectionId) params.set('librarySectionID', configuredSectionId)
    const res = await getHistory<PlexHistoryResponse>(`/status/sessions/history/all?${params}`)
    const metadata = res.MediaContainer.Metadata ?? []
    const tracks = metadata
      .filter((m) => m.type === 'track')
      .map((m) => ({
        artistName: m.grandparentTitle,
        trackName: m.title,
        viewedAt: m.viewedAt * 1000,
      }))
    return { tracks, total: res.MediaContainer.totalSize ?? tracks.length }
  }

  async function getRecentlyPlayed(
    limit = 50,
    offset = 0,
  ): Promise<{ tracks: PlexRecentTrack[]; total: number }> {
    return fetchHistoryPage(offset, limit)
  }

  const HISTORY_PAGE_SIZE = 200
  // Caps total pages fetched so a distant cutoff (e.g. "this year" for a
  // daily listener) can't page indefinitely; 25 pages = 5000 plays.
  const MAX_HISTORY_PAGES = 25

  /**
   * Paginates through play history (newest first) until an entry older than
   * `cutoffMs` is seen or history is exhausted. A single fixed-size fetch
   * (like getRecentlyPlayed) silently under-covers wide date ranges for an
   * active listener -- e.g. 500 tracks might only span two weeks, making
   * "this month" and "this year" look identical since neither ever reaches
   * back far enough to differ.
   */
  async function getRecentlyPlayedSince(cutoffMs: number): Promise<PlexRecentTrack[]> {
    const all: PlexRecentTrack[] = []
    for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
      const { tracks: batch } = await fetchHistoryPage(page * HISTORY_PAGE_SIZE, HISTORY_PAGE_SIZE)
      if (batch.length === 0) break
      let reachedCutoff = false
      for (const track of batch) {
        if (track.viewedAt < cutoffMs) {
          reachedCutoff = true
          break
        }
        all.push(track)
      }
      if (reachedCutoff || batch.length < HISTORY_PAGE_SIZE) break
    }
    return all
  }

  /**
   * Return every artist in the music library, paginated. Default page size 200
   * so a 5000-artist library is 25 requests at PQueue concurrency 3.
   *
   * Genres come from Plex's Genre tags. The default Plex Music agent does
   * not provide MBIDs, so the reconciler must look them up.
   */
  async function getAllArtists(options?: { pageSize?: number }): Promise<PlexLibraryArtist[]> {
    const sectionId = await getMusicSectionId()
    const pageSize = options?.pageSize ?? 200

    const all: PlexLibraryArtist[] = []
    let start = 0
    let total = Number.POSITIVE_INFINITY

    while (start < total) {
      const params = new URLSearchParams({
        type: '8',
        sort: 'titleSort',
        'X-Plex-Container-Start': String(start),
        'X-Plex-Container-Size': String(pageSize),
      })
      const res = await get<PlexAllArtistsResponse>(`/library/sections/${sectionId}/all?${params}`)
      const metadata = res.MediaContainer.Metadata ?? []
      total = res.MediaContainer.totalSize ?? metadata.length
      for (const m of metadata) {
        all.push({
          ratingKey: m.ratingKey,
          name: m.title,
          genres: (m.Genre ?? []).map((g) => g.tag),
        })
      }
      if (metadata.length === 0) break
      start += metadata.length
    }

    return all
  }

  async function getAlbumsForArtist(artistRatingKey: string): Promise<PlexLibraryAlbum[]> {
    const pageSize = 200
    const all: PlexLibraryAlbum[] = []
    let start = 0
    let total: number | undefined

    while (start < (total ?? Number.POSITIVE_INFINITY)) {
      const params = new URLSearchParams({
        type: '9',
        'X-Plex-Container-Start': String(start),
        'X-Plex-Container-Size': String(pageSize),
      })
      const res = await get<{
        MediaContainer: {
          totalSize?: number
          Metadata?: Array<{
            ratingKey: string
            parentRatingKey: string
            title: string
            year?: number
          }>
        }
      }>(`/library/metadata/${artistRatingKey}/children?${params}`)

      const metadata = res.MediaContainer.Metadata ?? []
      if (res.MediaContainer.totalSize != null) {
        total = res.MediaContainer.totalSize
      }
      for (const item of metadata) {
        all.push({
          ratingKey: item.ratingKey,
          artistRatingKey: item.parentRatingKey,
          title: item.title,
          releaseYear: item.year,
          primaryType: 'Album',
        })
      }
      if (metadata.length === 0) break
      start += metadata.length
      if (total == null && metadata.length < pageSize) break
    }

    return all
  }

  // Playlist generation needs "does the user actually own tracks by this
  // artist" resolved directly against their own Plex library, not a public
  // catalog search -- this is the local/owned-track path track-resolver.ts
  // expects via `plexSearch`. Two-step: find the artist's ratingKey by an
  // exact (case-insensitive) title match, then flatten every track under it.
  async function findArtistRatingKeyByName(artistName: string): Promise<string | null> {
    const sectionId = await getMusicSectionId()
    const params = new URLSearchParams({ type: '8', title: artistName })
    const res = await get<PlexAllArtistsResponse>(`/library/sections/${sectionId}/all?${params}`)
    const metadata = res.MediaContainer.Metadata ?? []
    const normalized = artistName.trim().toLowerCase()
    const exact = metadata.find((m) => m.title.trim().toLowerCase() === normalized)
    return (exact ?? metadata[0])?.ratingKey ?? null
  }

  async function getTracksForArtist(artistName: string): Promise<PlexOwnedTrack[]> {
    const ratingKey = await findArtistRatingKeyByName(artistName)
    if (!ratingKey) return []

    const res = await get<{
      MediaContainer: {
        Metadata?: Array<{
          title: string
          grandparentTitle?: string
          Media?: Array<{ Part?: Array<{ file?: string }> }>
          userRating?: number
          viewCount?: number
        }>
      }
    }>(`/library/metadata/${ratingKey}/allLeaves`)

    const metadata = res.MediaContainer.Metadata ?? []
    return metadata
      .map((m) => ({
        name: m.title,
        artist: m.grandparentTitle ?? artistName,
        path: m.Media?.[0]?.Part?.[0]?.file ?? '',
        userRating: m.userRating,
        viewCount: m.viewCount,
      }))
      .filter((t) => t.path !== '')
  }

  // Library-wide track search by title -- Plex's `title` filter on a track
  // (type=10) listing is a case-insensitive substring match, so "ghost"
  // also returns "Ghost Town" and "Ghostbusters". Callers do their own
  // exact/word-boundary filtering on top. The track artist prefers
  // originalTitle (the per-track artist on compilations/soundtracks) over
  // the album artist.
  async function searchTracksByTitle(query: string, limit = 100): Promise<PlexOwnedTrack[]> {
    const sectionId = await getMusicSectionId()
    const params = new URLSearchParams({
      type: '10',
      title: query,
      'X-Plex-Container-Start': '0',
      'X-Plex-Container-Size': String(limit),
    })
    const res = await get<{
      MediaContainer: {
        Metadata?: Array<{
          title: string
          grandparentTitle?: string
          originalTitle?: string
          parentTitle?: string
          Media?: Array<{ Part?: Array<{ file?: string }> }>
          userRating?: number
          viewCount?: number
        }>
      }
    }>(`/library/sections/${sectionId}/all?${params}`)

    return (res.MediaContainer.Metadata ?? [])
      .map((m) => ({
        name: m.title,
        artist: m.originalTitle || m.grandparentTitle || '',
        path: m.Media?.[0]?.Part?.[0]?.file ?? '',
        userRating: m.userRating,
        viewCount: m.viewCount,
      }))
      .filter((t) => t.path !== '' && t.artist !== '')
  }

  // Plex has no single canonical "liked tracks" concept the way Spotify does.
  // Prefer a playlist the user clearly curated for this purpose; fall back to
  // Plex's own per-user track rating (0-10 scale, 8+ = 4+ stars) when no such
  // playlist exists. Never throws -- an empty result just means no signal.
  async function findFavoritesPlaylistRatingKey(): Promise<string | null> {
    const res = await get<{
      MediaContainer: { Metadata?: Array<{ ratingKey: string; title: string }> }
    }>('/playlists?playlistType=audio')
    const match = (res.MediaContainer.Metadata ?? []).find((p) =>
      /favorite|favourite|loved/i.test(p.title),
    )
    return match?.ratingKey ?? null
  }

  async function getFavoriteTracks(limit = 200): Promise<PlexFavoriteTrack[]> {
    type TrackItemsResponse = {
      MediaContainer: {
        Metadata?: Array<{
          title: string
          grandparentTitle?: string
          parentTitle?: string
          addedAt?: number
        }>
      }
    }
    try {
      const ratingKey = await findFavoritesPlaylistRatingKey()
      if (ratingKey) {
        const res = await get<TrackItemsResponse>(
          `/playlists/${ratingKey}/items?X-Plex-Container-Size=${limit}`,
        )
        const metadata = res.MediaContainer.Metadata ?? []
        if (metadata.length > 0) {
          return metadata.map((m) => ({
            trackName: m.title,
            artistName: m.grandparentTitle ?? '',
            albumTitle: m.parentTitle,
            addedAt: m.addedAt ? m.addedAt * 1000 : undefined,
          }))
        }
      }
    } catch {
      // fall through to the rating-based fallback below
    }

    try {
      const sectionId = await getMusicSectionId()
      const res = await get<TrackItemsResponse>(
        `/library/sections/${sectionId}/all?type=10&userRating>=8&sort=userRating:desc&X-Plex-Container-Size=${limit}`,
      )
      const metadata = res.MediaContainer.Metadata ?? []
      return metadata.map((m) => ({
        trackName: m.title,
        artistName: m.grandparentTitle ?? '',
        albumTitle: m.parentTitle,
        addedAt: m.addedAt ? m.addedAt * 1000 : undefined,
      }))
    } catch {
      return []
    }
  }

  async function getServerName(): Promise<string | null> {
    try {
      const res = await get<PlexServerInfoResponse>('/')
      return res.MediaContainer.friendlyName?.trim() || null
    } catch {
      return null
    }
  }

  async function testConnection(): Promise<ServiceTestResult> {
    try {
      const sections = await getMusicSections()
      if (sections.length === 0) {
        return { success: false, message: 'No music library section found in Plex' }
      }
      const selected = configuredSectionId
        ? sections.find((s) => s.key === configuredSectionId)
        : sections[0]
      if (!selected) {
        return {
          success: false,
          message: `Configured Plex library section ${configuredSectionId} not found - available: ${sections
            .map((s) => `${s.title} (${s.key})`)
            .join(', ')}`,
        }
      }
      return {
        success: true,
        message: `Connected to Plex - using library "${selected.title}" (section ${selected.key})`,
        details: { sectionId: selected.key, sections },
      }
    } catch (err: unknown) {
      return { success: false, message: errMsg(err) }
    }
  }

  return {
    getMusicSectionId,
    getMusicSections,
    getTopArtists,
    getAllArtists,
    getAlbumsForArtist,
    getTracksForArtist,
    searchTracksByTitle,
    getRecentlyPlayed,
    getRecentlyPlayedSince,
    getRecentlyAddedAlbums,
    getFavoriteTracks,
    getServerName,
    testConnection,
  }
}
