import { Hono } from 'hono'
import { envConfig } from '@/config/env'
import { createLastFmClient } from '@/core/clients/lastfm'
import { createLidarrClient } from '@/core/clients/lidarr'
import { createMusicBrainzClient } from '@/core/clients/musicbrainz'
import { recordFailureSafely } from '@/core/jobs/record-failure-safely'
import { artistPicksToTracks } from '@/core/pipeline/discover-tracks'
import { filter } from '@/core/pipeline/filter'
import { createArtistImageClients } from '@/core/pipeline/image-clients'
import { fetchArtistImage, resolve, resolveTrackToAlbum } from '@/core/pipeline/resolve'
import { score } from '@/core/pipeline/score'
import { store } from '@/core/pipeline/store'
import type { DiscoveredArtist } from '@/core/types'
import { errMsg } from '@/core/validation'
import { upsertArtist } from '@/db/queries/artists'
import { mergePreferences } from '@/db/schema'
import type { AppDependencies } from '@/server'
import { buildPipelineRun } from '@/server/helpers/pipeline-run'
import { resolveUserPreferences } from '@/server/helpers/preferences'
import { problem } from '@/server/helpers/problem'
import { adminGuard } from '@/server/middleware/admin-guard'
import { quickDiscoverSchema } from '@/server/schemas/pipeline'
import { zJson } from '@/server/schemas/validator'
import { createPipelineSSEStream } from '@/server/sse'
import type { HonoEnv } from '@/server/types'

let rescanRunning = false

export function pipelineRoutes(deps: AppDependencies) {
  const router = new Hono<HonoEnv>()

  // Intentionally NOT admin-gated: "Run Scan" is a core regular-user action,
  // reachable from the dashboard (TodaysPick) and discover surfaces. Any
  // authenticated user may start a run; single-flight is preserved by the
  // orchestrator, so the blast radius is one in-flight pipeline regardless of
  // caller. A run requested while one is in progress is queued, not rejected.
  router.post('/api/v1/pipeline/run', async (c) => {
    const settings = await deps.getSettings()
    if (!settings) {
      return c.json({ error: 'Settings not found' }, 400)
    }
    if (!settings.aiProvider || !settings.aiModel) {
      return problem(
        c,
        'ai-required',
        'AI provider required',
        400,
        'Recommendations need an AI provider configured. Set one up in Settings.',
        undefined,
        'ai_required',
      )
    }

    const run = await buildPipelineRun(deps, c.get('userId'), 'manual')
    if (!run) return c.json({ error: 'Settings not found' }, 400)
    // Start now, or queue behind the in-flight run (single-flight preserved).
    const enqueued = deps.orchestrator.enqueue(run)

    // Surface the real enqueue outcome. A same-user re-submit during an
    // in-flight run is a no-op 'duplicate' and must not masquerade as a fresh
    // 'queued' run at position 0.
    const message =
      enqueued.status === 'started'
        ? 'Pipeline started'
        : enqueued.status === 'duplicate'
          ? 'Pipeline already running'
          : 'Pipeline queued'
    return c.json(
      {
        message,
        status: enqueued.status,
        queued: enqueued.status === 'queued',
        position: enqueued.position,
      },
      202,
    )
  })

  router.get('/api/v1/pipeline/status', async (c) => {
    const lastBatch = await deps.getLastBatch()
    const userId = c.get('userId')
    return c.json({
      running: deps.orchestrator.isRunning,
      stage: deps.orchestrator.stage,
      message: deps.orchestrator.stageMessage,
      queueLength: deps.orchestrator.queueLength,
      queuePosition: userId ? deps.orchestrator.queuePositionFor(userId) : 0,
      lastRun: lastBatch
        ? {
            batchId: lastBatch.id,
            completedAt: lastBatch.createdAt,
            status: lastBatch.status,
          }
        : undefined,
    })
  })

  router.get('/api/v1/pipeline/events', (_c) => {
    const stream = createPipelineSSEStream(deps.orchestrator)
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    })
  })

  // Quick discover: find similar artists to a specific artist
  router.post('/api/v1/pipeline/quick-discover', zJson(quickDiscoverSchema), async (c) => {
    // Note: this does NOT run through deps.orchestrator (no shared mutable
    // state, its own scoped AI calls below) -- it must not be gated
    // on a full pipeline run being in progress, or a normal background scan
    // makes every mood-discover "Request" click fail with a false 409.
    const { artistName, suggestedAlbum, reasoning } = c.req.valid('json')
    const trimmedArtistName = artistName

    const settings = await deps.getSettings()
    if (!settings) {
      return c.json({ error: 'Settings not found' }, 400)
    }

    const quickDiscoverUserId = c.get('userId')
    const quickDiscoverUser = quickDiscoverUserId
      ? await deps.getUserById(quickDiscoverUserId)
      : null

    // Fire-and-forget a focused pipeline run with just this artist as seed
    ;(async () => {
      const jobRecorder = deps.jobRecorder
      let jobId: number | null = null
      if (jobRecorder) {
        try {
          jobId = await jobRecorder.start({
            type: 'quick_discover',
            userId: quickDiscoverUserId,
            metadata: { seedArtist: trimmedArtistName },
          })
        } catch (err) {
          console.error('[quick-discover] Failed to record job start:', err)
        }
      }
      try {
        const lidarrUrl = settings.lidarrUrl as string | null
        const lidarrApiKey = settings.lidarrApiKey as string | null
        const lidarr =
          lidarrUrl && lidarrApiKey
            ? createLidarrClient(
                lidarrUrl,
                lidarrApiKey,
                (settings.skipTlsVerify as boolean) ?? false,
              )
            : null
        const mb = createMusicBrainzClient()

        // Add the seed artist directly (bypasses dedup, no Lidarr dependency)
        try {
          const existingMbids =
            await deps.storeDb.getExistingRecommendationMbids(quickDiscoverUserId)
          const seedDiscovered = [
            {
              name: trimmedArtistName,
              similarityScore: 1.0,
              aiReasoning: reasoning ?? 'Directly added from mood discovery.',
              suggestedAlbum,
              source: 'mood',
            },
          ]
          // Resolve via MB only (no Lidarr image lookup - avoids SkyHook
          // dependency). promoteSuggestedAlbums=true so this resolves to the
          // AI's suggested album (or, absent one, the artist's most recent
          // Album/EP) instead of surfacing as a bare artist-kind rec --
          // recommendations are album-focused end to end (see orchestrator.ts).
          const seedResolved = await resolve(
            seedDiscovered,
            mb,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            true,
          )
          const newSeeds = seedResolved.filter(
            (s) => s.kind === 'album' && s.releaseGroupMbid && !existingMbids.has(s.mbid),
          )
          if (newSeeds.length > 0) {
            const seedScored = score(
              newSeeds,
              [],
              {
                consensus: 0,
                similarity: 0,
                genreOverlap: 0,
                aiConfidence: 0,
                feedbackBoost: 0,
                popularity: 0,
              },
              new Map(),
            )
            for (const s of seedScored) s.score = 1.0
            await store(seedScored, deps.storeDb, { userId: quickDiscoverUserId })
          }
        } catch (err: unknown) {
          console.warn('Seed artist store failed:', errMsg(err))
        }

        // Get library MBIDs. Quick-discover prioritizes speed over freshness:
        // we read from the cache without triggering a sync. The background scheduler
        // keeps the cache fresh; an empty cache means no dedup (matches the old behavior).
        let libraryMbids: Set<string>
        if (typeof deps.storeDb.getLibraryArtistsForUser === 'function' && quickDiscoverUserId) {
          const cached = await deps.storeDb.getLibraryArtistsForUser(quickDiscoverUserId, {
            onlyReconciled: true,
          })
          libraryMbids = new Set(cached.map((a) => a.mbid).filter((m): m is string => m !== null))
        } else {
          libraryMbids = lidarr
            ? new Set((await lidarr.getArtists()).map((a) => a.foreignArtistId))
            : new Set<string>()
        }

        // Find similar artists via AI
        const discovered: DiscoveredArtist[] = []

        // Get AI recommendations focused on this artist
        let aiUsage: unknown = null
        if (settings.aiProvider && settings.aiModel) {
          try {
            const provider = await deps.providerRegistry.create(settings.aiProvider as string, {
              apiKey: (settings.aiApiKey as string) ?? null,
              model: settings.aiModel as string,
              baseUrl: (settings.aiBaseUrl as string) ?? null,
              timeoutSeconds: envConfig.aiTimeoutSeconds ?? null,
            })
            const aiRecs = await provider.getRecommendations({
              topArtists: [{ name: trimmedArtistName, playCount: 100, source: 'seed' as const }],
              topGenres: [],
              listeningPatterns: { totalListens: 0, recentTrend: 'stable' as const },
            })
            aiUsage = provider.lastUsage ?? null
            for (const rec of aiRecs) {
              discovered.push({
                name: rec.artistName,
                similarityScore: rec.confidence,
                aiReasoning: rec.reasoning,
                trackName: rec.trackName,
                source: 'ai' as const,
              })
            }
          } catch (err: unknown) {
            console.warn('AI recommendation failed:', errMsg(err))
          }
        }

        if (discovered.length === 0) {
          if (jobId != null && jobRecorder) {
            await jobRecorder.complete(jobId, {
              metadata: {
                seedArtist: trimmedArtistName,
                artistsDiscovered: 0,
                artistsStored: 0,
                ...(aiUsage ? { aiUsage } : {}),
              },
            })
          }
          return
        }

        // Read per-user preferences for quick-discover, fallback to global
        const qdPreferences = await resolveUserPreferences(
          async () => quickDiscoverUser,
          settings.preferences,
          quickDiscoverUserId,
        )
        const prefs = mergePreferences(qdPreferences)

        // Same as the main pipeline: each similar artist's album is the one
        // holding the song the AI named for them (or their top Last.fm track),
        // never just an album picked by artist.
        const lastfmKey = settings.lastfmApiKey as string | null | undefined
        const lastfm = lastfmKey ? createLastFmClient(lastfmKey) : null
        const tracks = await artistPicksToTracks(
          discovered,
          lastfm ? (name, mbid) => lastfm.getTopTracks(name, mbid, 3) : null,
        )
        const resolved = (
          await Promise.all(tracks.map((t) => resolveTrackToAlbum(t, mb, undefined, lidarr)))
        ).filter((a): a is NonNullable<typeof a> => a !== null)
        const rejectedMbids = await deps.storeDb.getRejectedMbids(prefs.rejectionCooldownDays)
        const blockedMbids = quickDiscoverUserId
          ? await deps.storeDb.getBlockedMbids(quickDiscoverUserId)
          : new Set<string>()
        const feedbackHistory = quickDiscoverUserId
          ? await deps.storeDb.getFeedbackHistory(quickDiscoverUserId)
          : await deps.storeDb.getFeedbackHistory()
        const scored = score(resolved, [], prefs.scoringWeights, feedbackHistory)
        const existingMbids = await deps.storeDb.getExistingRecommendationMbids(quickDiscoverUserId)
        for (const mbid of existingMbids) libraryMbids.add(mbid)

        const filtered = filter(
          scored,
          libraryMbids,
          rejectedMbids,
          blockedMbids,
          prefs.rejectionCooldownDays,
          prefs.scoreThreshold,
        )

        if (filtered.length > 0) {
          await store(filtered, deps.storeDb, { userId: quickDiscoverUserId })
        }

        if (jobId != null && jobRecorder) {
          await jobRecorder.complete(jobId, {
            metadata: {
              seedArtist: trimmedArtistName,
              artistsDiscovered: discovered.length,
              artistsStored: filtered.length,
              ...(aiUsage ? { aiUsage } : {}),
            },
          })
        }
      } catch (err: unknown) {
        if (jobId != null && jobRecorder) {
          await recordFailureSafely(jobRecorder, jobId, errMsg(err))
        }
        console.error('Quick discover failed:', err)
      }
    })()

    return c.json({
      message: `Finding artists similar to ${trimmedArtistName}...`,
    })
  })

  router.post('/api/v1/pipeline/rescan', adminGuard(deps.getUserById), async (c) => {
    if (rescanRunning) {
      return problem(c, 'pipeline-rescan-running', 'Artist metadata rescan already running', 409)
    }
    rescanRunning = true

    try {
      const settings = await deps.getSettings()
      if (!settings) {
        return c.json({ error: 'Settings not found' }, 400)
      }

      const userId = c.get('userId')
      const preferences = mergePreferences(
        await resolveUserPreferences(deps.getUserById, settings.preferences, userId),
      )
      const {
        audiodbClient: audiodb,
        lidarrClient: lidarr,
        fanartClient: fanart,
        musicinfoClient: musicinfo,
      } = createArtistImageClients({
        settings,
        preferences,
        tryConsumeRateLimit: deps.storeDb.tryConsumeRateLimit,
      })

      if (!audiodb && !lidarr && !fanart && !musicinfo) {
        return c.json({ error: 'No artist image sources configured' }, 400)
      }
      const hasUserScopedImageSources = Boolean(fanart || musicinfo)

      const mb = createMusicBrainzClient()

      const NEGATIVE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

      // Get this user's artists missing images, respecting the negative cache TTL
      const allRecs = await deps.listRecommendations({ limit: 200, userId })
      const artistsToUpdate = new Map<string, Record<string, unknown>>()
      for (const rec of allRecs.items) {
        const r = rec as Record<string, unknown>
        const artist = r.artist as Record<string, unknown> | undefined
        if (!artist) continue
        const mbid = artist.mbid as string | undefined
        if (!mbid || artist.imageUrl || artistsToUpdate.has(mbid)) continue
        const failedAt = artist.imageFailedAt as string | null | undefined
        if (
          !hasUserScopedImageSources &&
          failedAt &&
          Date.now() - new Date(failedAt).getTime() <= NEGATIVE_CACHE_TTL_MS
        ) {
          continue
        }
        artistsToUpdate.set(mbid, artist)
      }

      let attempted = 0
      let updated = 0
      let failed = 0
      for (const [mbid, artist] of artistsToUpdate) {
        attempted++
        const name = artist.name as string
        const [imageOutcome, metadataOutcome] = await Promise.allSettled([
          fetchArtistImage(mbid, name, audiodb, lidarr, fanart, musicinfo),
          artist.disambiguation ? Promise.resolve(null) : mb.lookupArtist(mbid),
        ])

        if (metadataOutcome.status === 'rejected') {
          console.warn('MusicBrainz disambiguation lookup failed:', errMsg(metadataOutcome.reason))
        }
        if (imageOutcome.status === 'rejected') {
          console.warn('Rescan image lookup failed for artist:', errMsg(imageOutcome.reason))
        }

        const image = imageOutcome.status === 'fulfilled' ? imageOutcome.value : null
        const mbArtist = metadataOutcome.status === 'fulfilled' ? metadataOutcome.value : null
        const disambiguation = mbArtist?.disambiguation || undefined

        try {
          if (image?.url) {
            await upsertArtist(deps.db, {
              mbid,
              name,
              imageUrl: image.url,
              logoUrl: image.logoUrl,
              disambiguation,
            })
            updated++
            continue
          }

          failed++
          const cacheableImageFailure = image?.failed ?? false
          if (cacheableImageFailure || disambiguation) {
            await upsertArtist(deps.db, {
              mbid,
              name,
              disambiguation,
              imageFailed: cacheableImageFailure || undefined,
            })
          }
        } catch (err: unknown) {
          if (image?.url) failed++
          console.warn('Rescan update failed for artist:', errMsg(err))
        }
      }

      return c.json({ attempted, updated, failed, total: attempted })
    } finally {
      rescanRunning = false
    }
  })

  return router
}
