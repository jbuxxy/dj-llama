import { execFile } from 'node:child_process'
import PQueue from 'p-queue'
import { errMsg } from '@/core/validation'

// Same shape of problem as spotify.ts: no simple public REST endpoint like
// Deezer's exists for YouTube Music, and the official Data API has no
// playlist-by-arbitrary-URL read for a service account without the owner's
// OAuth consent. ytmusicapi can browse a playlist anonymously as long as
// it's marked Public, so this shells out to a small Python bridge
// (deploy/docker/youtube_music_bridge.py) the same way the Spotify client
// does, rather than hand-rolling the innertube protocol in TS.

const PYTHON_PATH = process.env.YOUTUBE_MUSIC_SCRAPER_PYTHON ?? 'python3'
const SCRIPT_PATH = process.env.YOUTUBE_MUSIC_BRIDGE_SCRIPT ?? '/app/youtube_music_bridge.py'

// Each call spawns a fresh Python process -- bound total concurrency here,
// same reasoning as spotify.ts's queue.
const queue = new PQueue({ concurrency: 3 })

export type YoutubeMusicPlaylistTrackEntry = {
  artistName: string
  trackName: string
  albumTitle?: string
  coverUrl?: string
}

type BridgePlaylistResponse = {
  name: string | null
  imageUrl?: string | null
  tracks: Array<{
    artistName: string
    trackName: string
    albumTitle: string | null
    coverUrl?: string | null
  }>
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
      let message = stderr.trim() || `youtube_music_bridge exited with code ${exitCode}`
      try {
        const parsed = JSON.parse(stderr) as { error?: string }
        if (parsed.error) message = parsed.error
      } catch {
        // stderr wasn't JSON -- use it as-is
      }
      throw new Error(message)
    }

    try {
      return JSON.parse(stdout) as T
    } catch (err) {
      throw new Error(`youtube_music_bridge returned invalid JSON: ${errMsg(err)}`)
    }
  }) as Promise<T>
}

/** Extract the bare playlist ID from a music.youtube.com/youtube.com URL, or pass a raw ID through. */
export function extractYoutubeMusicPlaylistId(raw: string): string {
  const trimmed = raw.trim()
  try {
    const url = new URL(trimmed)
    const listParam = url.searchParams.get('list')
    if (listParam) return listParam
  } catch {
    // Not a URL -- fall through to bare-ID handling below.
  }
  return trimmed
}

/** Full per-track list for a public YouTube Music playlist (artist + track + album), by URL or bare ID. */
export async function getPlaylistTracks(
  playlistIdOrUrl: string,
  limit = 500,
  runner?: BridgeRunner,
): Promise<{
  name: string | null
  imageUrl: string | null
  tracks: YoutubeMusicPlaylistTrackEntry[]
}> {
  const playlistId = extractYoutubeMusicPlaylistId(playlistIdOrUrl)
  const res = await runBridge<BridgePlaylistResponse>(
    ['playlist', playlistId, '--max-tracks', String(limit)],
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
