import { and, desc, eq, gte, inArray, isNull, lt, or } from 'drizzle-orm'
import { envConfig } from '@/config/env'
import { createLidarrClient } from '@/core/clients/lidarr'
import { normalizeArtistName } from '@/core/library/normalize'
import { analyze } from '@/core/pipeline/analyze'
import { collectLikedTracks, collectRecentPlays } from '@/core/pipeline/collect-tracks'
import { buildTrackTasteProfile, type RequestHistoryEntry } from '@/core/pipeline/track-taste'
import { createPlexSource } from '@/core/plugins/plex'
import { SourceRegistry } from '@/core/plugins/registry'
import {
  buildAlbumSelectionPrompt,
  buildPlaylistSelectionPrompt,
  buildRecommendationUserTurn,
  type PlaylistAlbumCandidate,
  type PlaylistCandidateArtist,
} from '@/core/providers/prompt'
import type { AiProviderRegistry } from '@/core/providers/registry'
import type { Database } from '@/db'
import { getPopularityMap } from '@/db/queries/artist-metadata'
import { getRecentPlexScrobbles } from '@/db/queries/plex-scrobbles'
import { listRequestsForUser, toRequestHistoryEntries } from '@/db/queries/requests'
import { getSettings } from '@/db/queries/settings'
import { getUserConnections } from '@/db/queries/users'
import { artists, libraryArtists, recommendations } from '@/db/schema'
import { extractDecadeFromText, extractGenreFromText, filterLibraryAlbums } from './library-filter'
import {
  type StrategyAlbum,
  type StrategyArtist,
  type StrategyDeps,
  TRACKS_PER_ARTIST,
} from './strategies/types'

const APPROVED_STATUSES = ['approved', 'added_to_lidarr']

// Candidate pool sent to the model is capped so the prompt stays bounded
// regardless of how large a user's Lidarr library or recommendation history
// gets.
const MAX_CANDIDATE_POOL = 150

export function buildStrategyDeps(
  db: Database,
  userId: number | null,
  providerRegistry?: AiProviderRegistry,
): StrategyDeps {
  async function getApprovedArtistsPool(limit: number): Promise<StrategyArtist[]> {
    const rows = await db
      .select({
        name: artists.name,
        mbid: artists.mbid,
        score: recommendations.score,
        genres: artists.genres,
      })
      .from(recommendations)
      .innerJoin(artists, eq(artists.id, recommendations.artistId))
      .where(
        and(
          inArray(recommendations.status, APPROVED_STATUSES),
          userId != null ? eq(recommendations.userId, userId) : undefined,
        ),
      )
      .orderBy(desc(recommendations.score))
      .limit(limit)

    return rows.map((r) => ({ name: r.name, mbid: r.mbid, score: r.score, genres: r.genres ?? [] }))
  }

  async function buildCandidatePool(): Promise<StrategyArtist[]> {
    const approved = await getApprovedArtistsPool(MAX_CANDIDATE_POOL)
    const settings = await getSettings(db)

    const byName = new Map<string, StrategyArtist>()
    for (const a of approved) byName.set(a.name.toLowerCase(), a)

    if (settings?.lidarrUrl && settings?.lidarrApiKey) {
      try {
        const lidarr = createLidarrClient(
          settings.lidarrUrl,
          settings.lidarrApiKey,
          settings.skipTlsVerify ?? false,
        )
        const libraryArtists = await lidarr.getArtists()
        // Shuffle before truncating -- a library can run into the
        // thousands, and Lidarr always returns them in the same order, so a
        // plain slice would show the AI (and every generation) the exact
        // same few hundred artists and silently ignore the rest.
        for (let i = libraryArtists.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1))
          const tmp = libraryArtists[i]
          const swap = libraryArtists[j]
          if (tmp === undefined || swap === undefined) continue
          libraryArtists[i] = swap
          libraryArtists[j] = tmp
        }
        for (const a of libraryArtists) {
          if (byName.size >= MAX_CANDIDATE_POOL) break
          const key = a.artistName.toLowerCase()
          if (!byName.has(key)) {
            byName.set(key, {
              name: a.artistName,
              mbid: a.foreignArtistId,
              score: 0,
              genres: a.genres ?? [],
            })
          }
        }
      } catch {
        // Lidarr unavailable - fall back to whatever approved artists we have
      }
    }

    return [...byName.values()].slice(0, MAX_CANDIDATE_POOL)
  }

  async function getTrackTasteWeightedArtists(opts: {
    limit?: number
    genreKeywords?: string[]
    includeLibraryFiller?: boolean
  }): Promise<StrategyArtist[]> {
    if (userId == null) return []

    const [userConnections, settings] = await Promise.all([
      getUserConnections(db, userId),
      getSettings(db),
    ])
    if (!userConnections) return []

    const registry = new SourceRegistry()
    // Spotify has no listening-history signal anymore -- no per-user
    // connection exists at all (see core/clients/spotify.ts).
    if (userConnections.plexUrl && userConnections.plexToken) {
      registry.register(
        createPlexSource(
          userConnections.plexUrl,
          userConnections.plexToken,
          userConnections.plexSectionId,
          {
            adminToken: settings?.plexAdminToken,
            username: userConnections.username,
          },
        ),
      )
    }

    const sources = registry.all()
    if (sources.length === 0) return []

    const { tracks: liked } = await collectLikedTracks(sources)
    const plexWebhookPlays = await getRecentPlexScrobbles(db, userId, 100)
    const recentPlays = await collectRecentPlays(sources, 100, plexWebhookPlays)

    const { items: requestRows } = await listRequestsForUser(db, userId, { limit: 50 })
    const requestHistory: RequestHistoryEntry[] = toRequestHistoryEntries(requestRows)

    const popularityMap = await getPopularityMap(db)
    const profile = buildTrackTasteProfile(
      liked,
      recentPlays,
      requestHistory,
      new Date(),
      undefined,
      popularityMap,
    )

    const byArtist = new Map<string, { name: string; mbid?: string; score: number }>()
    for (const signal of profile.signals) {
      const key = signal.artistName.trim().toLowerCase()
      const existing = byArtist.get(key)
      if (existing) {
        existing.score += signal.weight
        if (!existing.mbid && signal.mbid) existing.mbid = signal.mbid
      } else {
        byArtist.set(key, { name: signal.artistName, mbid: signal.mbid, score: signal.weight })
      }
    }

    const genreRows = await db
      .select({ name: libraryArtists.name, genres: libraryArtists.genres })
      .from(libraryArtists)
      .where(eq(libraryArtists.userId, userId))
    const genresByName = new Map(
      genreRows.map((r) => [r.name.trim().toLowerCase(), r.genres ?? []]),
    )

    let ranked: StrategyArtist[] = [...byArtist.values()]
      .sort((a, b) => b.score - a.score)
      .map((a) => ({
        name: a.name,
        mbid: a.mbid,
        score: a.score,
        genres: genresByName.get(a.name.trim().toLowerCase()) ?? [],
      }))

    // Widen the pool with the rest of the tagged library at a low baseline
    // score. Without this, the pool is capped at whatever the user has
    // recently played/liked/requested -- for a niche genre that can be just
    // a handful of artists, which forces clusterIntoMixes/weightedSample to
    // reuse the same tiny set every regeneration. Baseline score stays well
    // below any real signal so taste still drives ranking; it only exists to
    // give low-signal buckets more raw material to vary across.
    if (opts.includeLibraryFiller) {
      const rankedNames = new Set(ranked.map((a) => a.name.trim().toLowerCase()))
      const minScore = ranked.length > 0 ? Math.min(...ranked.map((a) => a.score)) : 1
      const baselineScore = Math.max(minScore * 0.25, 0.05)
      for (const row of genreRows) {
        const key = row.name.trim().toLowerCase()
        if (rankedNames.has(key)) continue
        rankedNames.add(key)
        ranked.push({ name: row.name, score: baselineScore, genres: row.genres ?? [] })
      }
    }

    if (opts.genreKeywords && opts.genreKeywords.length > 0) {
      const keywords = opts.genreKeywords.map((k) => k.toLowerCase())
      ranked = ranked.filter((a) =>
        a.genres?.some((g) => keywords.some((k) => g.toLowerCase().includes(k))),
      )
    }

    return opts.limit ? ranked.slice(0, opts.limit) : ranked
  }

  // Rediscover-only: real "liked or previously played, nothing recent"
  // artists -- distinct from getTrackTasteWeightedArtists above because that
  // rolls everything up into one blended score with no per-artist last-played
  // date, so it can't tell "liked ages ago" apart from "played yesterday."
  async function getDormantTasteArtists(opts: {
    olderThan: Date
    limit?: number
  }): Promise<StrategyArtist[]> {
    if (userId == null) return []

    const userConnections = await getUserConnections(db, userId)
    if (!userConnections) return []

    const registry = new SourceRegistry()
    if (userConnections.plexUrl && userConnections.plexToken) {
      const settings = await getSettings(db)
      registry.register(
        createPlexSource(
          userConnections.plexUrl,
          userConnections.plexToken,
          userConnections.plexSectionId,
          {
            adminToken: settings?.plexAdminToken,
            username: userConnections.username,
          },
        ),
      )
    }

    const sources = registry.all()
    if (sources.length === 0) return []

    const { tracks: liked } = await collectLikedTracks(sources)
    const plexWebhookPlays = await getRecentPlexScrobbles(db, userId, 300)
    const recentPlays = await collectRecentPlays(sources, 300, plexWebhookPlays)

    // Anything played inside the dormant window is, by definition, not
    // dormant -- exclude it entirely rather than just ranking it lower.
    const activeArtists = new Set(
      recentPlays
        .filter((p) => p.playedAt >= opts.olderThan)
        .map((p) => p.artistName.trim().toLowerCase()),
    )

    const EPOCH = new Date(0)
    const byArtist = new Map<string, { name: string; mbid?: string; lastSignal: Date }>()

    // Liked-but-not-recently-played is the strongest "worth rediscovering"
    // signal -- no addedAt means it's been sitting there indefinitely, so
    // treat it as maximally dormant (sorts first).
    for (const t of liked) {
      const key = t.artistName?.trim().toLowerCase()
      if (!key || activeArtists.has(key)) continue
      const existing = byArtist.get(key)
      if (!existing) {
        byArtist.set(key, { name: t.artistName, mbid: t.mbid, lastSignal: t.addedAt ?? EPOCH })
      }
    }

    // Older (excluded-from-active) plays fill in the rest, ranked by how
    // long ago they were last actually played.
    for (const p of recentPlays) {
      const key = p.artistName?.trim().toLowerCase()
      if (!key || activeArtists.has(key)) continue
      const existing = byArtist.get(key)
      if (!existing || p.playedAt > existing.lastSignal) {
        byArtist.set(key, { name: p.artistName, mbid: existing?.mbid, lastSignal: p.playedAt })
      }
    }

    const genreRows = await db
      .select({ name: libraryArtists.name, genres: libraryArtists.genres })
      .from(libraryArtists)
      .where(eq(libraryArtists.userId, userId))
    const genresByName = new Map(
      genreRows.map((r) => [r.name.trim().toLowerCase(), r.genres ?? []]),
    )

    const ranked: StrategyArtist[] = [...byArtist.values()]
      .sort((a, b) => a.lastSignal.getTime() - b.lastSignal.getTime())
      .map((a) => ({
        name: a.name,
        mbid: a.mbid,
        score: 1,
        genres: genresByName.get(a.name.trim().toLowerCase()) ?? [],
      }))

    return opts.limit ? ranked.slice(0, opts.limit) : ranked
  }

  return {
    getTrackTasteWeightedArtists,
    getDormantTasteArtists,

    async getLibraryArtistKeys(): Promise<Set<string>> {
      const rows = await db
        .select({ name: libraryArtists.name })
        .from(libraryArtists)
        .where(
          userId != null
            ? or(eq(libraryArtists.userId, userId), isNull(libraryArtists.userId))
            : undefined,
        )
      return new Set(rows.map((r) => normalizeArtistName(r.name)).filter(Boolean))
    },

    async getApprovedArtists(opts): Promise<StrategyArtist[]> {
      const rows = await db
        .select({
          name: artists.name,
          mbid: artists.mbid,
          score: recommendations.score,
          genres: artists.genres,
        })
        .from(recommendations)
        .innerJoin(artists, eq(artists.id, recommendations.artistId))
        .where(
          and(
            inArray(recommendations.status, APPROVED_STATUSES),
            opts.since ? gte(recommendations.actedOnAt, opts.since) : undefined,
            userId != null ? eq(recommendations.userId, userId) : undefined,
          ),
        )
        .orderBy(desc(recommendations.score))
        .limit(opts.limit ?? 200)

      let result: StrategyArtist[] = rows.map((r) => ({
        name: r.name,
        mbid: r.mbid,
        score: r.score,
        genres: r.genres ?? [],
      }))

      if (opts.genre) {
        const g = opts.genre.toLowerCase()
        result = result.filter((a) => a.genres?.some((genre) => genre.toLowerCase().includes(g)))
      }

      return result
    },

    async getOlderApprovedArtists(opts): Promise<StrategyArtist[]> {
      const rows = await db
        .select({
          name: artists.name,
          mbid: artists.mbid,
          score: recommendations.score,
          genres: artists.genres,
        })
        .from(recommendations)
        .innerJoin(artists, eq(artists.id, recommendations.artistId))
        .where(
          and(
            inArray(recommendations.status, APPROVED_STATUSES),
            lt(recommendations.actedOnAt, opts.olderThan),
            userId != null ? eq(recommendations.userId, userId) : undefined,
          ),
        )
        .orderBy(desc(recommendations.score))
        .limit(opts.limit)

      return rows.map((r) => ({
        name: r.name,
        mbid: r.mbid,
        score: r.score,
        genres: r.genres ?? [],
      }))
    },

    ...(providerRegistry
      ? {
          async selectArtistsWithAi(opts): Promise<StrategyArtist[]> {
            const settings = await getSettings(db)
            if (!settings?.aiProvider || !settings?.aiModel) return []

            const candidates = await buildCandidatePool()
            if (candidates.length === 0) return []

            const provider = await providerRegistry.create(settings.aiProvider, {
              apiKey: settings.aiApiKey ?? null,
              model: settings.aiModel,
              baseUrl: settings.aiBaseUrl ?? null,
              timeoutSeconds: envConfig.aiTimeoutSeconds ?? null,
            })

            const promptCandidates: PlaylistCandidateArtist[] = candidates.map((c) => ({
              name: c.name,
              genres: c.genres,
            }))
            const prompt = buildPlaylistSelectionPrompt(opts.prompt, promptCandidates)

            const recs = await provider.getRecommendations({
              topArtists: [],
              topGenres: [],
              listeningPatterns: { totalListens: 0, recentTrend: 'stable' },
              _rawPrompt: prompt,
            })

            // Defense in depth: only keep picks that exactly match a real
            // candidate (case-insensitive) even though the prompt already
            // instructs verbatim copying -- a model can still ignore
            // instructions, and this is the boundary that actually prevents
            // a hallucinated artist from reaching track resolution.
            const candidateByName = new Map(candidates.map((c) => [c.name.toLowerCase(), c]))
            const matched: StrategyArtist[] = []
            for (const rec of recs) {
              const candidate = candidateByName.get(rec.artistName.toLowerCase())
              if (candidate) matched.push(candidate)
            }

            const artistLimit = Math.ceil(opts.size / TRACKS_PER_ARTIST)
            return matched.slice(0, artistLimit)
          },

          async selectAlbumsWithAi(opts): Promise<StrategyAlbum[]> {
            const settings = await getSettings(db)
            if (!settings?.aiProvider || !settings?.aiModel) return []

            // Stage 1 (deterministic, no AI call): pull real filters out of
            // the free-text request and scope the candidate pool to the
            // listener's actual library before the model ever sees it.
            const genreRows = await db
              .select({ genres: libraryArtists.genres })
              .from(libraryArtists)
              .where(userId != null ? eq(libraryArtists.userId, userId) : undefined)
            const knownGenres = [...new Set(genreRows.flatMap((r) => r.genres ?? []))]

            // Explicit UI filters (genreFilters/decadeFilters/excludeLiveVersions)
            // take priority when set; otherwise fall back to auto-extracting
            // a single decade from the free-text prompt, same as before.
            const hasExplicitDecades = opts.decadeFilters && opts.decadeFilters.length > 0
            const decade = hasExplicitDecades ? undefined : extractDecadeFromText(opts.prompt)
            const genre =
              !opts.genreFilters || opts.genreFilters.length === 0
                ? extractGenreFromText(opts.prompt, knownGenres)
                : undefined

            const candidates = await filterLibraryAlbums(db, {
              userId,
              genre,
              genres: opts.genreFilters,
              decades: opts.decadeFilters,
              decade,
              excludeLive: opts.excludeLiveVersions,
            })
            if (candidates.length === 0) return []

            let historySummary: string | undefined
            if (opts.useListeningHistory && userId != null) {
              try {
                const userConnections = await getUserConnections(db, userId)
                if (userConnections?.plexUrl && userConnections?.plexToken) {
                  const plexSource = createPlexSource(
                    userConnections.plexUrl,
                    userConnections.plexToken,
                    userConnections.plexSectionId,
                    {
                      adminToken: settings.plexAdminToken,
                      username: userConnections.username,
                    },
                  )
                  const profile = await analyze([plexSource])
                  historySummary = buildRecommendationUserTurn(profile)
                }
              } catch {
                // Best-effort -- continue without history context
              }
            }

            const provider = await providerRegistry.create(settings.aiProvider, {
              apiKey: settings.aiApiKey ?? null,
              model: settings.aiModel,
              baseUrl: settings.aiBaseUrl ?? null,
              timeoutSeconds: envConfig.aiTimeoutSeconds ?? null,
            })

            const promptCandidates: PlaylistAlbumCandidate[] = candidates.map((c) => ({
              artistName: c.artistName,
              albumTitle: c.albumTitle,
              genres: c.genres,
            }))
            const prompt = buildAlbumSelectionPrompt(opts.prompt, promptCandidates, historySummary)

            const recs = await provider.getRecommendations({
              topArtists: [],
              topGenres: [],
              listeningPatterns: { totalListens: 0, recentTrend: 'stable' },
              _rawPrompt: prompt,
            })

            // Defense in depth: only keep picks that exactly match a real
            // (artist, album) candidate pair even though the prompt already
            // instructs verbatim copying -- a model can still ignore
            // instructions, and this is the boundary that actually prevents
            // a hallucinated album from reaching track resolution.
            const candidateByKey = new Map(
              candidates.map((c) => [
                `${c.artistName.toLowerCase()}::${c.albumTitle.toLowerCase()}`,
                c,
              ]),
            )
            const matched: StrategyAlbum[] = []
            for (const rec of recs) {
              if (!rec.suggestedAlbum) continue
              const key = `${rec.artistName.toLowerCase()}::${rec.suggestedAlbum.toLowerCase()}`
              const candidate = candidateByKey.get(key)
              if (candidate) {
                matched.push({
                  name: candidate.artistName,
                  mbid: candidate.artistMbid,
                  score: rec.confidence,
                  genres: candidate.genres,
                  albumTitle: candidate.albumTitle,
                  albumMbid: candidate.albumMbid,
                })
              }
            }

            const artistLimit = Math.ceil(opts.size / TRACKS_PER_ARTIST)
            return matched.slice(0, artistLimit)
          },
        }
      : {}),
  }
}
