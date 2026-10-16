// Apple Music has no public unauthenticated playlist endpoint, and MusicKit
// (the officially supported path) requires a paid Apple Developer Program
// membership plus a signed private key just to read a *public* playlist --
// a much heavier ask than Spotify/Deezer/YouTube Music need. Instead this
// pulls the same anonymous "AMPWebPlay" bearer token music.apple.com's own
// web player embeds in its JS bundle and calls the same amp-api.music.apple.com
// catalog endpoints the web player itself uses. Same class of workaround as
// spotify.ts and youtube-music.ts, and just as liable to break if Apple
// reshapes their web player build -- confirmed live against a real public
// playlist (id extraction, token discovery, and paginated track fetch all
// verified against music.apple.com/amp-api directly).
//
// The token is scoped via its own `root_https_origin` claim to apple.com, so
// every catalog request below sends `Origin: https://music.apple.com` to
// satisfy that check. Observed validity is ~2 months (from the token's own
// `exp` claim), so it's cached in memory per-process and only refetched once
// close to expiring, rather than scraped on every import.

const ORIGIN = 'https://music.apple.com'
const CATALOG_BASE = 'https://amp-api.music.apple.com'

export type AppleMusicPlaylistTrackEntry = {
  artistName: string
  trackName: string
  albumTitle?: string
  coverUrl?: string
}

type CachedToken = { token: string; expiresAt: number }
let cachedToken: CachedToken | null = null

async function fetchText(url: string, timeoutMs = 15_000): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    })
    if (!res.ok) {
      throw new Error(`Apple Music page request failed: ${res.status} ${res.statusText}`)
    }
    return await res.text()
  } finally {
    clearTimeout(timer)
  }
}

function decodeJwtPayload(token: string): { iss?: string; exp?: number } {
  const part = token.split('.')[1]
  if (!part) throw new Error('not a JWT')
  const padded = part
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(part.length + ((4 - (part.length % 4)) % 4), '=')
  return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'))
}

/** Finds and caches the anonymous developer token the web player uses for public catalog reads. */
async function getDeveloperToken(): Promise<string> {
  const now = Date.now()
  if (cachedToken && cachedToken.expiresAt - 60_000 > now) return cachedToken.token

  const html = await fetchText(`${ORIGIN}/us/`)
  const bundleMatch = html.match(/<script[^>]+type="module"[^>]+src="(\/assets\/index[^"]+\.js)"/)
  if (!bundleMatch?.[1]) {
    throw new Error('Apple Music: could not locate web player bundle to extract a token from')
  }
  const bundleJs = await fetchText(`${ORIGIN}${bundleMatch[1]}`, 30_000)

  const candidates = bundleJs.match(/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g) ?? []
  for (const candidate of candidates) {
    try {
      const payload = decodeJwtPayload(candidate)
      if (payload.iss === 'AMPWebPlay' && payload.exp) {
        cachedToken = { token: candidate, expiresAt: payload.exp * 1000 }
        return candidate
      }
    } catch {
      // Not a real/decodable JWT -- skip.
    }
  }
  throw new Error('Apple Music: could not find a developer token in the web player bundle')
}

/** Extracts {storefront, id} from a music.apple.com playlist URL, or a bare "pl.xxxx" id (storefront defaults to "us"). */
export function extractAppleMusicPlaylist(raw: string): { storefront: string; id: string } {
  const trimmed = raw.trim()
  const urlMatch = trimmed.match(/music\.apple\.com\/([a-z]{2})\/playlist\/[^/?]+\/(pl\.[\w-]+)/i)
  if (urlMatch?.[1] && urlMatch[2]) {
    return { storefront: urlMatch[1].toLowerCase(), id: urlMatch[2] }
  }
  const idMatch = trimmed.match(/pl\.[\w-]+/)
  return { storefront: 'us', id: idMatch?.[0] ?? trimmed }
}

// Apple's artwork URLs are templates with literal {w}/{h} placeholders.
type AmpArtwork = { url?: string }
const artworkUrl = (artwork: AmpArtwork | undefined, size: number) =>
  artwork?.url?.replace('{w}', String(size)).replace('{h}', String(size))

type AmpTrackAttributes = {
  name: string
  artistName: string
  albumName?: string
  artwork?: AmpArtwork
}
type AmpTracksPage = { data?: Array<{ attributes?: AmpTrackAttributes }>; next?: string }
type AmpPlaylistResponse = {
  data?: Array<{
    attributes?: { name?: string; artwork?: AmpArtwork }
    relationships?: { tracks?: AmpTracksPage }
  }>
  errors?: Array<{ detail?: string; title?: string }>
}

async function fetchCatalog<T>(path: string, token: string): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)
  let res: Response
  try {
    res = await fetch(`${CATALOG_BASE}${path}`, {
      signal: controller.signal,
      headers: { Authorization: `Bearer ${token}`, Origin: ORIGIN },
    })
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) {
    throw new Error(`Apple Music catalog request failed: ${res.status} ${res.statusText}`)
  }
  return (await res.json()) as T
}

/** Full per-track list for a public Apple Music playlist (artist + track + album), by URL or bare "pl.xxxx" id. */
export async function getPlaylistTracks(
  playlistIdOrUrl: string,
  limit = 500,
): Promise<{
  name: string | null
  imageUrl: string | null
  tracks: AppleMusicPlaylistTrackEntry[]
}> {
  const { storefront, id } = extractAppleMusicPlaylist(playlistIdOrUrl)
  const token = await getDeveloperToken()

  const first = await fetchCatalog<AmpPlaylistResponse>(
    `/v1/catalog/${storefront}/playlists/${id}?include=tracks&limit%5Btracks%5D=100`,
    token,
  )
  const playlist = first.data?.[0]
  if (!playlist) {
    throw new Error(first.errors?.[0]?.detail ?? 'Apple Music playlist not found')
  }

  const tracks: AppleMusicPlaylistTrackEntry[] = []
  const pushPage = (page?: AmpTracksPage) => {
    for (const t of page?.data ?? []) {
      if (!t.attributes) continue
      tracks.push({
        artistName: t.attributes.artistName,
        trackName: t.attributes.name,
        albumTitle: t.attributes.albumName,
        coverUrl: artworkUrl(t.attributes.artwork, 300),
      })
    }
  }
  pushPage(playlist.relationships?.tracks)

  let next = playlist.relationships?.tracks?.next
  while (next && tracks.length < limit) {
    const page = await fetchCatalog<AmpTracksPage>(next, token)
    pushPage(page)
    next = page.next
  }

  return {
    name: playlist.attributes?.name ?? null,
    imageUrl: artworkUrl(playlist.attributes?.artwork, 600) ?? null,
    tracks: tracks.slice(0, limit),
  }
}
