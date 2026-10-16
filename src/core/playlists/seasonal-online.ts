import { fetchDeezerPlaylistTracks, searchDeezerPlaylists } from '@/core/clients/deezer-playlist'
import type { SeasonalPreset } from './seasonal-presets'

export type OnlineSeasonalSong = {
  artist: string
  title: string
  // How many of the mined playlists include this song -- a rough
  // "how canonical is it for this season" signal.
  playlistCount: number
}

const PLAYLISTS_PER_QUERY = 3
const CACHE_TTL_MS = 24 * 60 * 60 * 1000
// Moods/backgrounds that share a season word but aren't party/hits
// playlists -- a "Halloween lofi" or "Christmas piano" list would flood the
// pool with instrumentals nobody owns.
const REJECT_TITLE =
  /\b(lo-?fi|sleep|study|relax|piano|instrumental|kids|karaoke|ambience|asmr|meditation|white noise)\b/i

const cache = new Map<string, { at: number; songs: OnlineSeasonalSong[] }>()

/**
 * Mines public Deezer playlists (editor-curated ones first) for a season's
 * songs, e.g. "Halloween Party" / "Vintage Halloween" / "Christmas Classics".
 * Best-effort: any failure just shrinks (or empties) the list, and the
 * generator still has the preset's built-in classics and title keywords.
 * Cached in memory for a day per preset.
 */
export async function fetchOnlineSeasonalSongs(
  preset: SeasonalPreset,
  deps: {
    searchPlaylists?: typeof searchDeezerPlaylists
    fetchPlaylistTracks?: typeof fetchDeezerPlaylistTracks
    now?: number
  } = {},
): Promise<OnlineSeasonalSong[]> {
  const now = deps.now ?? Date.now()
  const cached = cache.get(preset.key)
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.songs

  const search = deps.searchPlaylists ?? searchDeezerPlaylists
  const fetchTracks = deps.fetchPlaylistTracks ?? fetchDeezerPlaylistTracks
  const word = preset.onlineTitleWord.toLowerCase()

  const playlistIds = new Set<string>()
  for (const query of preset.onlineQueries) {
    try {
      const results = await search(query, 10)
      const usable = results
        .filter((p) => p.title.toLowerCase().includes(word) && !REJECT_TITLE.test(p.title))
        .filter((p) => p.trackCount >= 15)
        // Deezer's own editors ("Rudy - Deezer Moods Editor") first.
        .sort((a, b) => Number(/deezer/i.test(b.ownerName)) - Number(/deezer/i.test(a.ownerName)))
      for (const p of usable.slice(0, PLAYLISTS_PER_QUERY)) playlistIds.add(p.id)
    } catch (err) {
      console.warn(`[seasonal-online] Deezer search '${query}' failed:`, err)
    }
  }

  const byKey = new Map<string, OnlineSeasonalSong>()
  for (const id of playlistIds) {
    try {
      const { tracks } = await fetchTracks(id)
      const seenInThisPlaylist = new Set<string>()
      for (const t of tracks) {
        const key = `${t.artistName.toLowerCase()}|${t.trackName.toLowerCase()}`
        if (seenInThisPlaylist.has(key)) continue
        seenInThisPlaylist.add(key)
        const existing = byKey.get(key)
        if (existing) existing.playlistCount++
        else byKey.set(key, { artist: t.artistName, title: t.trackName, playlistCount: 1 })
      }
    } catch (err) {
      console.warn(`[seasonal-online] Deezer playlist ${id} failed:`, err)
    }
  }

  const songs = [...byKey.values()].sort((a, b) => b.playlistCount - a.playlistCount)
  if (songs.length > 0) cache.set(preset.key, { at: now, songs })
  return songs
}
