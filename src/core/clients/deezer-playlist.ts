const BASE_URL = 'https://api.deezer.com'

/** Extract the bare playlist ID from a URL, app URI, or raw ID. */
export function extractDeezerPlaylistId(raw: string): string {
  // deezer://playlist/ID
  const uriMatch = raw.match(/deezer:\/\/playlist\/(\d+)/)
  if (uriMatch?.[1]) return uriMatch[1]

  // https://www.deezer.com/en/playlist/ID or deezer.com/playlist/ID
  const urlMatch = raw.match(/\/playlist\/(\d+)/)
  if (urlMatch?.[1]) return urlMatch[1]

  // bare ID
  return raw.trim()
}

type DeezerTracksResponse = {
  data?: Array<{
    id: number
    title: string
    artist: { id: number; name: string }
    album?: { id: number; title: string; cover_medium?: string }
  }>
  error?: { message: string }
}

type DeezerPlaylistInfoResponse = {
  title?: string
  picture_big?: string
  error?: { message: string }
}

export type DeezerPlaylistTrackEntry = {
  artistName: string
  trackName: string
  albumTitle?: string
  coverUrl?: string
}

async function fetchJson<T>(url: string): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  let res: Response
  try {
    res = await fetch(url, { signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) {
    throw new Error(`Deezer request failed: ${res.status} ${res.statusText}`)
  }
  return (await res.json()) as T
}

/**
 * Full per-track list for a public Deezer playlist (artist + track + album,
 * one entry per song), plus the playlist's own title -- fetched separately
 * since /playlist/{id}/tracks doesn't include it. No app registration or
 * OAuth connection required; only works for playlists that are public
 * (Deezer's default).
 */
export async function fetchDeezerPlaylistTracks(
  rawPlaylistId: string,
  baseUrl = BASE_URL,
): Promise<{
  playlistId: string
  name: string | null
  imageUrl: string | null
  tracks: DeezerPlaylistTrackEntry[]
}> {
  const playlistId = extractDeezerPlaylistId(rawPlaylistId)

  const [data, info] = await Promise.all([
    fetchJson<DeezerTracksResponse>(`${baseUrl}/playlist/${playlistId}/tracks?limit=500`),
    // Best-effort -- a title lookup failure shouldn't fail the whole import.
    fetchJson<DeezerPlaylistInfoResponse>(`${baseUrl}/playlist/${playlistId}`).catch(
      () => ({}) as DeezerPlaylistInfoResponse,
    ),
  ])

  if (data.error) {
    throw new Error(`Deezer playlist fetch failed: ${data.error.message}`)
  }

  const tracks = (data.data ?? []).map((track) => ({
    artistName: track.artist.name,
    trackName: track.title,
    albumTitle: track.album?.title,
    coverUrl: track.album?.cover_medium,
  }))

  return { playlistId, name: info.title ?? null, imageUrl: info.picture_big ?? null, tracks }
}

export type DeezerPlaylistSearchResult = {
  id: string
  title: string
  trackCount: number
  ownerName: string
}

type DeezerPlaylistSearchResponse = {
  data?: Array<{ id: number; title: string; nb_tracks?: number; user?: { name?: string } }>
  error?: { message: string }
}

/** Public playlist search -- no app registration or OAuth needed. */
export async function searchDeezerPlaylists(
  query: string,
  limit = 10,
  baseUrl = BASE_URL,
): Promise<DeezerPlaylistSearchResult[]> {
  const params = new URLSearchParams({ q: query, limit: String(limit) })
  const data = await fetchJson<DeezerPlaylistSearchResponse>(`${baseUrl}/search/playlist?${params}`)
  if (data.error) throw new Error(`Deezer playlist search failed: ${data.error.message}`)
  return (data.data ?? []).map((p) => ({
    id: String(p.id),
    title: p.title,
    trackCount: p.nb_tracks ?? 0,
    ownerName: p.user?.name ?? '',
  }))
}
