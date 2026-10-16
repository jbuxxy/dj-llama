import { Hono } from 'hono'
import { createPlexClient } from '@/core/clients/plex'
import { normalizeArtistName } from '@/core/library/normalize'
import type { LibrarySyncStore } from '@/core/library/store'
import { createArtistImageClients } from '@/core/pipeline/image-clients'
import { fetchArtistImage } from '@/core/pipeline/resolve'
import type { StoreDb } from '@/core/pipeline/store'
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
    const mbidByArtist = new Map<string, string>()
    const checked = new Set<string>()
    for (const entry of entries) {
      if (entry.mbid) {
        mbidByArtist.set(entry.artist, entry.mbid)
        continue
      }
      if (checked.has(entry.artist)) continue
      checked.add(entry.artist)
      const nameNormalized = normalizeArtistName(entry.artist)
      if (!nameNormalized) continue
      const matches = await deps.librarySyncStore.findReconciledByNormalizedName(
        deps.userId,
        nameNormalized,
      )
      if (matches[0]) mbidByArtist.set(entry.artist, matches[0].mbid)
    }
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

  if (!entries.some((e) => !e.imageUrl)) return

  // Live fallback for artists the scheduled backfill job (see
  // core/pipeline/artist-image-backfill.ts) hasn't reached yet -- same
  // AudioDB -> Lidarr -> fanart.tv -> musicinfo.pro chain the rest of the app
  // uses, via fetchArtistImage. Unlike the old Lidarr-only version, every
  // outcome (hit or cacheable miss) is written back to the shared artists
  // cache, so a given artist only ever triggers one live lookup total, not
  // one per page load.
  const preferences = mergePreferences(deps.settings.preferences)
  const { audiodbClient, lidarrClient, fanartClient, musicinfoClient } = createArtistImageClients({
    settings: deps.settings,
    preferences,
    tryConsumeRateLimit: deps.tryConsumeRateLimit,
  })
  if (!audiodbClient && !lidarrClient && !fanartClient && !musicinfoClient) return

  const seen = new Set<string>()
  const imageCache = new Map<string, string>()

  for (const entry of entries) {
    // No reconciled MBID yet -- fetchArtistImage's providers are all
    // MBID-keyed, so there's nothing useful to look up until the next
    // library sync reconciles this artist.
    if (entry.imageUrl || !entry.mbid || seen.has(entry.artist)) continue
    seen.add(entry.artist)
    try {
      const image = await fetchArtistImage(
        entry.mbid,
        entry.artist,
        audiodbClient,
        lidarrClient,
        fanartClient,
        musicinfoClient,
      )
      if (image.url) {
        imageCache.set(entry.artist, image.url)
        await upsertArtist(deps.db, {
          mbid: entry.mbid,
          name: entry.artist,
          imageUrl: image.url,
          logoUrl: image.logoUrl,
        })
      } else if (image.failed) {
        await upsertArtist(deps.db, { mbid: entry.mbid, name: entry.artist, imageFailed: true })
      }
    } catch (err) {
      console.warn(`[listening] image lookup failed for ${entry.artist}:`, err)
    }
  }

  for (const entry of entries) {
    if (!entry.imageUrl && imageCache.has(entry.artist)) {
      entry.imageUrl = imageCache.get(entry.artist)
    }
  }
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
          const recent = await client.getRecentlyPlayedSince(cutoff)
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
          const windowed = await client.getRecentlyPlayedSince(cutoff)
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
