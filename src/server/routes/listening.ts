import { Hono } from 'hono'
import { TtlCache } from '@/core/cache/ttl-cache'
import { createPlexClient } from '@/core/clients/plex'
import { normalizeArtistName } from '@/core/library/normalize'
import type { LibrarySyncStore } from '@/core/library/store'
import { createArtistImageClients } from '@/core/pipeline/image-clients'
import { fetchArtistImage } from '@/core/pipeline/resolve'
import type { StoreDb } from '@/core/pipeline/store'
import { realtimeBroker } from '@/core/realtime/broker'
import type { Database } from '@/db'
import { getArtistImageCacheByMbids, upsertArtist } from '@/db/queries/artists'
import type { SettingsRow } from '@/db/queries/settings'
import { getUserConnections, type UserConnections } from '@/db/queries/users'
import { mergePreferences } from '@/db/schema'
import type { AppDependencies } from '@/server'
import { parseIntClamp } from '@/server/helpers/parse-int-clamp'
import type { HonoEnv } from '@/server/types'

type TopArtistEntry = {
  artist: string
  track: string
  source: string
  imageUrl?: string
  mbid?: string
}

type RecentTrackEntry = {
  artist: string
  track: string
  source: string
  imageUrl?: string
  playedAt?: string
  nowPlaying?: boolean
  mbid?: string
}

const TOP_RANGES = ['this_week', 'this_month', 'this_year', 'all_time'] as const
type TopRange = (typeof TOP_RANGES)[number]

function parseTopRange(raw: string | undefined): TopRange {
  if (!raw) return 'this_month'
  if ((TOP_RANGES as readonly string[]).includes(raw)) return raw as TopRange
  // back-compat for the previous (misleading) range values
  if (raw === 'week') return 'this_week'
  if (raw === 'month') return 'this_month'
  if (raw === 'year') return 'this_year'
  return 'this_month'
}

function rangeLabel(range: TopRange): string {
  if (range === 'this_week') return 'this week'
  if (range === 'this_year') return 'this year'
  if (range === 'all_time') return 'all time'
  return 'this month'
}

function hasPlex(conns: UserConnections | null): boolean {
  return Boolean(conns?.plexUrl && conns?.plexToken)
}

// Days of history to aggregate for a ranged Plex/Spotify query; null means
// "no cutoff", i.e. use the service's native lifetime/all-time ranking.
function daysForRange(range: TopRange): number | null {
  if (range === 'this_week') return 7
  if (range === 'this_month') return 30
  if (range === 'this_year') return 365
  return null
}

async function enrichImages(
  entries: Array<{ artist: string; mbid?: string; imageUrl?: string }>,
  deps: {
    db: Database
    librarySyncStore: LibrarySyncStore
    userId: number | undefined
    settings: SettingsRow
    tryConsumeRateLimit: StoreDb['tryConsumeRateLimit']
  },
): Promise<void> {
  // Resolve each artist against the user's already-reconciled library
  // (Plex/Lidarr name -> MBID matches from library sync) and reuse whatever
  // image the resolution pipeline (AudioDB/fanart.tv/musicinfo) already
  // cached for that MBID. This is a plain DB read -- no live Lidarr call --
  // and also gives the Lidarr fallback below a real MBID to look up by
  // instead of a fuzzy name match.
  if (deps.userId != null) {
    const userId = deps.userId
    const mbidByArtist = new Map<string, string>()
    const toResolve = new Set<string>()
    for (const entry of entries) {
      if (entry.mbid) mbidByArtist.set(entry.artist, entry.mbid)
      else toResolve.add(entry.artist)
    }
    // Independent lookups -- run them together instead of one round-trip
    // per artist in sequence.
    await Promise.all(
      [...toResolve].map(async (artist) => {
        if (mbidByArtist.has(artist)) return
        const nameNormalized = normalizeArtistName(artist)
        if (!nameNormalized) return
        const matches = await deps.librarySyncStore.findReconciledByNormalizedName(
          userId,
          nameNormalized,
        )
        if (matches[0]) mbidByArtist.set(artist, matches[0].mbid)
      }),
    )
    for (const entry of entries) {
      if (!entry.mbid && mbidByArtist.has(entry.artist)) {
        entry.mbid = mbidByArtist.get(entry.artist)
      }
    }

    const mbids = [...new Set([...mbidByArtist.values()])]
    if (mbids.length > 0) {
      const cached = await getArtistImageCacheByMbids(deps.db, mbids)
      const imageByMbid = new Map(
        cached.filter((c) => c.imageUrl).map((c) => [c.mbid, c.imageUrl as string]),
      )
      for (const entry of entries) {
        if (!entry.imageUrl && entry.mbid && imageByMbid.has(entry.mbid)) {
          entry.imageUrl = imageByMbid.get(entry.mbid)
        }
      }
    }
  }

  const missing = entries.filter((e) => !e.imageUrl && e.mbid)
  if (missing.length === 0) return

  // Live fallback for artists the scheduled backfill job (see
  // core/pipeline/artist-image-backfill.ts) hasn't reached yet. Deliberately
  // NOT awaited: the AudioDB -> Lidarr -> fanart.tv chain can take seconds
  // per artist, and the dashboard shouldn't wait on it. Results land in the
  // shared artists cache and a listening-updated push makes open tabs
  // refetch and pick the new images up.
  void backfillListeningImages(missing, deps).catch((err) =>
    console.warn('[listening] background image backfill failed:', err),
  )
}

// Artists with a live lookup already running, so the two dashboard panels
// (and rapid re-renders) don't start duplicate fetches for the same artist.
const imageLookupsInFlight = new Set<string>()

async function backfillListeningImages(
  entries: Array<{ artist: string; mbid?: string }>,
  deps: {
    db: Database
    userId: number | undefined
    settings: SettingsRow
    tryConsumeRateLimit: StoreDb['tryConsumeRateLimit']
  },
): Promise<void> {
  const preferences = mergePreferences(deps.settings.preferences)
  const { audiodbClient, lidarrClient, fanartClient, musicinfoClient } = createArtistImageClients({
    settings: deps.settings,
    preferences,
    tryConsumeRateLimit: deps.tryConsumeRateLimit,
  })
  if (!audiodbClient && !lidarrClient && !fanartClient && !musicinfoClient) return

  let found = 0
  for (const entry of entries) {
    const mbid = entry.mbid
    if (!mbid || imageLookupsInFlight.has(mbid)) continue
    imageLookupsInFlight.add(mbid)
    try {
      const image = await fetchArtistImage(
        mbid,
        entry.artist,
        audiodbClient,
        lidarrClient,
        fanartClient,
        musicinfoClient,
      )
      if (image.url) {
        found++
        await upsertArtist(deps.db, {
          mbid,
          name: entry.artist,
          imageUrl: image.url,
          logoUrl: image.logoUrl,
        })
      } else if (image.failed) {
        await upsertArtist(deps.db, { mbid, name: entry.artist, imageFailed: true })
      }
    } catch (err) {
      console.warn(`[listening] image lookup failed for ${entry.artist}:`, err)
    } finally {
      imageLookupsInFlight.delete(mbid)
    }
  }
  if (found > 0 && deps.userId != null) {
    realtimeBroker.publish(deps.userId, { type: 'listening-updated' })
  }
}

// Windowed Plex history ("this year" can be 25 sequential pages of 200) is
// shared by both dashboard panels and every page of each -- fetch it once per
// user+range for a couple of minutes instead of on every request. A Plex
// scrobble webhook clears it (see clearListeningCache) so new plays show up.
type RecentPlays = Awaited<
  ReturnType<ReturnType<typeof createPlexClient>['getRecentlyPlayedSince']>
>
const recentPlaysCache = new TtlCache<RecentPlays>(2 * 60 * 1000, 200)

function cachedRecentlyPlayed(
  userId: number | undefined,
  days: number,
  load: () => Promise<RecentPlays>,
): Promise<RecentPlays> {
  if (userId == null) return load()
  return recentPlaysCache.get(`${userId}:${days}`, load)
}

export function clearListeningCache(userId: number): void {
  for (const days of [7, 30, 365]) recentPlaysCache.delete(`${userId}:${days}`)
}

export function listeningRoutes(deps: AppDependencies) {
  const router = new Hono<HonoEnv>()

  router.get('/api/v1/listening/top-artists', async (c) => {
    const settings = await deps.getSettings()
    if (!settings) {
      return c.json({ tracks: [], total: 0, offset: 0, limit: 5, hasSource: false, source: null })
    }

    const range = parseTopRange(c.req.query('range'))
    const limit = parseIntClamp(c.req.query('limit'), {
      name: 'limit',
      min: 1,
      max: 50,
      default: 5,
    })
    const offset = parseIntClamp(c.req.query('offset'), {
      name: 'offset',
      min: 0,
      max: 10_000,
      default: 0,
    })

    const userId = c.get('userId')
    const userConns = userId ? await getUserConnections(deps.db, userId) : null
    // Distinct from `source` below, which stays null even when Plex is
    // connected but this specific range/page turned up zero plays --
    // hasSource is what the frontend uses to tell "not connected" apart
    // from "connected, just quiet this week" (see recent-tracks below,
    // which already had this distinction).
    const hasSource = hasPlex(userConns)

    let tracks: TopArtistEntry[] = []
    let total = 0
    let source: 'plex' | null = null
    const label = rangeLabel(range)

    // Plex is the only top-artists source. Spotify has no anonymous
    // equivalent for this (see core/clients/spotify.ts); Deezer is
    // deliberately skipped here too -- see orchestrator.ts, its OAuth app
    // can't be provisioned yet.
    if (hasPlex(userConns)) {
      try {
        const client = createPlexClient(userConns?.plexUrl ?? '', userConns?.plexToken ?? '', {
          sectionId: userConns?.plexSectionId,
          historyToken: settings.plexAdminToken,
          username: userConns?.username,
        })
        const days = daysForRange(range)
        if (days == null) {
          const artists = await client.getTopArtists(offset + limit + 1)
          total = offset + artists.length
          tracks = artists.slice(offset, offset + limit).map((a) => ({
            artist: a.name,
            track: `${a.viewCount} plays ${label}`,
            source: 'plex',
          }))
        } else {
          const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
          const recent = await cachedRecentlyPlayed(userId, days, () =>
            client.getRecentlyPlayedSince(cutoff),
          )
          const counts = new Map<string, number>()
          for (const t of recent) {
            if (t.viewedAt < cutoff) continue
            counts.set(t.artistName, (counts.get(t.artistName) ?? 0) + 1)
          }
          const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1])
          total = ranked.length
          tracks = ranked.slice(offset, offset + limit).map(([artist, count]) => ({
            artist,
            track: `${count} plays ${label}`,
            source: 'plex',
          }))
        }
        if (tracks.length > 0) source = 'plex'
      } catch (err: unknown) {
        console.warn('[listening] Plex top-artists fetch failed:', err)
      }
    }

    // Spotify has no anonymous top-artists equivalent (see
    // core/clients/spotify.ts) -- that fallback is gone.

    await enrichImages(tracks, {
      db: deps.db,
      librarySyncStore: deps.librarySyncStore,
      userId,
      settings,
      tryConsumeRateLimit: deps.storeDb.tryConsumeRateLimit,
    })

    return c.json({ tracks, total, offset, limit, hasSource, source })
  })

  router.get('/api/v1/listening/recent-tracks', async (c) => {
    const settings = await deps.getSettings()
    // Shared with top-artists so both dashboard panels page through the same
    // window -- see the dashboard's single listenRange state.
    const range = parseTopRange(c.req.query('range'))
    const limit = parseIntClamp(c.req.query('limit'), {
      name: 'limit',
      min: 1,
      max: 50,
      default: 5,
    })
    const offset = parseIntClamp(c.req.query('offset'), {
      name: 'offset',
      min: 0,
      max: 10_000,
      default: 0,
    })

    const userId = c.get('userId')
    const userConns = userId ? await getUserConnections(deps.db, userId) : null
    const hasSource = hasPlex(userConns)

    if (!settings || !hasSource) {
      return c.json({ tracks: [], total: 0, offset, limit, hasSource, source: null })
    }

    let tracks: RecentTrackEntry[] = []
    let total = 0
    let source: 'plex' | null = null

    // Plex is the only recent-tracks source. Spotify has no anonymous
    // equivalent; Deezer skipped -- see top-artists above.
    if (hasPlex(userConns)) {
      try {
        const client = createPlexClient(userConns?.plexUrl ?? '', userConns?.plexToken ?? '', {
          sectionId: userConns?.plexSectionId,
          historyToken: settings.plexAdminToken,
          username: userConns?.username,
        })
        const days = daysForRange(range)
        if (days == null) {
          // All time: Plex's native container pagination over the entire
          // history, same as before ranges existed here.
          const recent = await client.getRecentlyPlayed(limit, offset)
          total = recent.total
          tracks = recent.tracks.map((t) => ({
            artist: t.artistName,
            track: t.trackName,
            source: 'plex',
            playedAt: new Date(t.viewedAt).toISOString(),
          }))
        } else {
          // Windowed range: same cutoff-paginated fetch top-artists uses,
          // then paginate the (already newest-first) in-memory result.
          const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
          const windowed = (
            await cachedRecentlyPlayed(userId, days, () => client.getRecentlyPlayedSince(cutoff))
          ).filter((t) => t.viewedAt >= cutoff)
          total = windowed.length
          tracks = windowed.slice(offset, offset + limit).map((t) => ({
            artist: t.artistName,
            track: t.trackName,
            source: 'plex',
            playedAt: new Date(t.viewedAt).toISOString(),
          }))
        }
        if (tracks.length > 0) source = 'plex'
      } catch (err: unknown) {
        console.warn('[listening] Plex recent-tracks fetch failed:', err)
      }
    }

    // Spotify has no anonymous recently-played equivalent (see
    // core/clients/spotify.ts) -- that fallback is gone.

    await enrichImages(tracks, {
      db: deps.db,
      librarySyncStore: deps.librarySyncStore,
      userId,
      settings,
      tryConsumeRateLimit: deps.storeDb.tryConsumeRateLimit,
    })

    return c.json({ tracks, total, offset, limit, hasSource, source })
  })

  return router
}
