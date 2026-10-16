import { execFile } from 'node:child_process'
import PQueue from 'p-queue'
import { errMsg } from '@/core/validation'

// Spotify's Web API (OAuth and Client Credentials alike) is blocked entirely
// for this app's registered credentials since Feb 2026 unless the app owner
// personally has Premium -- confirmed live, not assumed: a Client Credentials
// token against this deployment's real SPOTIFY_CLIENT_ID/SECRET got the exact
// same 403 ("Active premium subscription required for the owner of the app")
// on /v1/users/{id}/playlists as OAuth's /me endpoints did. There is no
// official-API path left. Instead this shells out to the `spotifyscraper`
// PyPI package (deploy/docker/spotify_bridge.py), which bootstraps its own
// anonymous token from Spotify's public web-player infrastructure --
// independent of any app we register, so the Premium restriction doesn't
// apply. Confirmed live: search, single-playlist-by-id, artist, and
// discography all work with zero auth. Listing a user's playlists by
// username does NOT work anonymously (Spotify refuses the anonymous token
// for that one endpoint, confirmed both live and in the library's own
// source/docstrings) -- it requires a real sp_dc browser session cookie,
// which was considered and rejected as a worse security trade than the OAuth
// this replaces. So there is no "connect your Spotify account" feature
// anymore; playlist import is paste-a-link only (see playlists.tsx).

const PYTHON_PATH = process.env.SPOTIFY_SCRAPER_PYTHON ?? 'python3'
const SCRIPT_PATH = process.env.SPOTIFY_BRIDGE_SCRIPT ?? '/app/spotify_bridge.py'

// Each call spawns a fresh Python process, so the library's own internal
// rate-limiting doesn't carry over between invocations -- bound total
// concurrency here instead, same reasoning as musicbrainz.ts's shared queue.
const queue = new PQueue({ concurrency: 3 })

export type SpotifySearchTrack = {
  name: string
  artists: string[]
  uri: string
  /**
   * Raw stream-count proxy from the scraper's public track data, not a 0-100
   * popularity score -- the official API's `popularity` field doesn't exist
   * for anonymous access. Still useful for relative ranking (higher = more
   * popular), just a different scale.
   */
  popularity: number
}

export type SpotifyArtistMatch = {
  name: string
  id: string
}

export type SpotifyPopularAlbum = {
  id: string
  title: string
  releaseDate?: string
  /** Always 0 -- no popularity/ranking signal survives for albums via the
   * scraper (see getPopularAlbumsForArtist). Kept for shape-compatibility
   * with PopularAlbumCandidate. */
  popularity: number
}

export type SpotifyPlaylistTrackEntry = {
  artistName: string
  trackName: string
  albumTitle?: string
  coverUrl?: string
}

export class SpotifyNotFoundError extends Error {}

type BridgeSearchResponse = {
  tracks: Array<{ name: string; artists: string[]; uri: string; playCount: number | null }>
  artists: Array<{ name: string; id: string }>
}

type BridgePlaylistResponse = {
  name: string
  imageUrl?: string | null
  tracks: Array<{
    artistName: string
    trackName: string
    albumTitle: string | null
    coverUrl?: string | null
  }>
}

type BridgeDiscographyResponse = {
  releases: Array<{ id: string; title: string }>
}

export type BridgeRunner = (
  args: string[],
) => Promise<{ stdout: string; stderr: string; exitCode: number }>

const defaultRunner: BridgeRunner = (args) =>
  new Promise((resolve) => {
    execFile(PYTHON_PATH, [SCRIPT_PATH, ...args], { timeout: 30_000 }, (error, stdout, stderr) => {
      const exitCode =
        error && typeof (error as NodeJS.ErrnoException).code === 'number'
          ? ((error as NodeJS.ErrnoException).code as unknown as number)
          : error
            ? 1
            : 0
      resolve({ stdout, stderr, exitCode })
    })
  })

async function runBridge<T>(args: string[], runner: BridgeRunner = defaultRunner): Promise<T> {
  return queue.add(async () => {
    const { stdout, stderr, exitCode } = await runner(args)

    if (exitCode !== 0) {
      let message = stderr.trim() || `spotify_bridge exited with code ${exitCode}`
      try {
        const parsed = JSON.parse(stderr) as { error?: string }
        if (parsed.error) message = parsed.error
      } catch {
        // stderr wasn't JSON -- use it as-is
      }
      if (exitCode === 2) throw new SpotifyNotFoundError(message)
      throw new Error(message)
    }

    try {
      return JSON.parse(stdout) as T
    } catch (err) {
      throw new Error(`spotify_bridge returned invalid JSON: ${errMsg(err)}`)
    }
  }) as Promise<T>
}

export async function searchTracks(
  query: string,
  limit = 10,
  runner?: BridgeRunner,
): Promise<SpotifySearchTrack[]> {
  const res = await runBridge<BridgeSearchResponse>(
    ['search', query, '--types', 'track', '--limit', String(limit)],
    runner,
  )
  return res.tracks.map((t) => ({
    name: t.name,
    artists: t.artists,
    uri: t.uri,
    popularity: t.playCount ?? 0,
  }))
}

/** Exact (case-insensitive) name match against Spotify's artist search -- null if zero or multiple matches. */
export async function findExactArtistByName(
  name: string,
  runner?: BridgeRunner,
): Promise<SpotifyArtistMatch | null> {
  const res = await runBridge<BridgeSearchResponse>(
    ['search', name, '--types', 'artist', '--limit', '10'],
    runner,
  )
  const exactMatches = res.artists.filter((a) => a.name.toLowerCase() === name.toLowerCase())
  if (exactMatches.length !== 1 || !exactMatches[0]) return null
  return exactMatches[0]
}

/**
 * Best-effort "popular albums" for an artist. The scraper's discography data
 * has no release_date/album_type/popularity fields at all (unlike the old
 * official-API version), so this can no longer filter to full-lengths only
 * or rank by true popularity -- it just takes the first `limit` entries in
 * whatever order Spotify's own discography page returns them (typically
 * albums before singles/compilations, roughly recent-first).
 */
export async function getPopularAlbumsForArtist(
  artistId: string,
  limit = 3,
  runner?: BridgeRunner,
): Promise<SpotifyPopularAlbum[]> {
  const res = await runBridge<BridgeDiscographyResponse>(
    ['discography', artistId, '--limit', String(limit)],
    runner,
  )
  return res.releases.map((r) => ({ id: r.id, title: r.title, popularity: 0 }))
}

export type SpotifyAlbumTopTrack = {
  name: string
  uri: string
  playCount: number | null
}

type BridgeAlbumTopTrackResponse = {
  tracks: Array<{ name: string; uri: string; playCount: number | null }>
}

/**
 * All tracks on a specific album, ranked by play count (highest first) --
 * resolved by album search (to find the album's id) followed by a full
 * album fetch (to get real per-track play counts; search results never
 * carry them, see spotify_bridge.py's cmd_album_top_track). Empty if no
 * album by that artist matches closely enough to trust.
 *
 * Callers wanting a single "best track" (e.g. the embedded player) should
 * use tracks[0] -- keeping every caller on this same ranked list is what
 * keeps a per-album top-tracks display and the embedded player agreeing on
 * which track is "the" top one.
 */
export async function getAlbumTracksRankedByPopularity(
  artistName: string,
  albumTitle: string,
  runner?: BridgeRunner,
): Promise<SpotifyAlbumTopTrack[]> {
  try {
    const res = await runBridge<BridgeAlbumTopTrackResponse>(
      ['album-top-track', artistName, albumTitle],
      runner,
    )
    return res.tracks
  } catch (err) {
    if (err instanceof SpotifyNotFoundError) return []
    throw err
  }
}

/** Full per-track list for a public playlist (artist + track + album), by URL or bare ID. */
export async function getPlaylistTracks(
  playlistIdOrUrl: string,
  limit = 500,
  runner?: BridgeRunner,
): Promise<{ name: string | null; imageUrl: string | null; tracks: SpotifyPlaylistTrackEntry[] }> {
  const res = await runBridge<BridgePlaylistResponse>(
    ['playlist', playlistIdOrUrl, '--max-tracks', String(limit)],
    runner,
  )
  return {
    name: res.name ?? null,
    imageUrl: res.imageUrl ?? null,
    tracks: res.tracks.map((t) => ({
      artistName: t.artistName,
      trackName: t.trackName,
      albumTitle: t.albumTitle ?? undefined,
      coverUrl: t.coverUrl ?? undefined,
    })),
  }
}
