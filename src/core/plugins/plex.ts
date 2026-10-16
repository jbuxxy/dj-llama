import { createPlexClient } from '@/core/clients/plex'
import type { DiscoverySource } from './types'

const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const ACTIVITY_WEEKS = 8

export function createPlexSource(
  url: string,
  token: string,
  sectionId?: string | null,
  history?: { adminToken?: string | null; username?: string | null },
): DiscoverySource {
  const client = createPlexClient(url, token, {
    sectionId,
    historyToken: history?.adminToken,
    username: history?.username,
  })

  return {
    id: 'plex',
    name: 'Plex',
    capabilities: [
      'topArtists',
      'recentListening',
      'listeningActivity',
      'likedTracks',
      'recentlyAdded',
    ],

    async getTopArtists(limit) {
      const artists = await client.getTopArtists(limit)
      return artists.map((a) => ({
        name: a.name,
        playCount: a.viewCount,
        source: 'plex',
        ...((a.genres ?? []).length > 0
          ? { genres: a.genres, genreSource: 'native' as const }
          : {}),
      }))
    },

    async getSimilarArtists() {
      return []
    },

    async testConnection() {
      return client.testConnection()
    },

    async getRecentListening(limit) {
      const { tracks } = await client.getRecentlyPlayed(limit)
      return tracks.map((t) => ({
        name: t.artistName,
        track: t.trackName,
        playedAt: new Date(t.viewedAt),
      }))
    },

    // Plex's history endpoint has no built-in weekly bucketing -- fetch a
    // wider page of raw plays and bucket them into weeks ourselves so
    // analyze()'s trend detection has something to compare.
    async getListeningActivity() {
      const cutoff = Date.now() - ACTIVITY_WEEKS * WEEK_MS
      const tracks = await client.getRecentlyPlayedSince(cutoff)
      if (tracks.length === 0) return []
      const now = Date.now()
      const counts = new Map<number, number>()
      for (const t of tracks) {
        const weeksAgo = Math.floor((now - t.viewedAt) / WEEK_MS)
        if (weeksAgo < 0 || weeksAgo >= ACTIVITY_WEEKS) continue
        counts.set(weeksAgo, (counts.get(weeksAgo) ?? 0) + 1)
      }
      return [...counts.entries()].map(([weeksAgo, listen_count]) => ({
        listen_count,
        from_ts: Math.floor((now - (weeksAgo + 1) * WEEK_MS) / 1000),
        to_ts: Math.floor((now - weeksAgo * WEEK_MS) / 1000),
      }))
    },

    async getLikedTracks(limit) {
      try {
        const tracks = await client.getFavoriteTracks(limit)
        return tracks.map((t) => ({
          trackName: t.trackName,
          artistName: t.artistName,
          albumTitle: t.albumTitle,
          addedAt: t.addedAt ? new Date(t.addedAt) : undefined,
          source: 'plex',
        }))
      } catch {
        return []
      }
    },

    async getRecentlyAdded(limit) {
      try {
        const albums = await client.getRecentlyAddedAlbums(limit)
        return albums.map((a) => ({
          albumTitle: a.albumTitle,
          artistName: a.artistName,
          addedAt: new Date(a.addedAt),
        }))
      } catch {
        return []
      }
    },
  }
}
