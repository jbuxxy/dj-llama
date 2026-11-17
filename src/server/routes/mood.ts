import { Hono } from 'hono'
import { envConfig } from '@/config/env'
import { getSharedLidarrClient, type LidarrClient } from '@/core/clients/lidarr'
import { normalizeAlbumTitle, normalizeArtistName } from '@/core/library/normalize'
import { buildMoodPrompt } from '@/core/providers/prompt'
import type { AiProviderRegistry } from '@/core/providers/registry'
import type { RecommendationProvider } from '@/core/providers/types'
import type { AiRecommendation, TasteProfile } from '@/core/types'
import { errMsg } from '@/core/validation'
import type { Database } from '@/db'
import { getLidarrAlbumTitlesByArtist } from '@/db/queries/lidarr-cache'
import { apiError } from '@/server/helpers/problem'
import { moodDiscoverSchema } from '@/server/schemas/mood'
import { zJson } from '@/server/schemas/validator'
import type { HonoEnv } from '@/server/types'
import { rankSearchResults, resolveImageUrl, tokenize } from './requests'

export type MoodDeps = {
  db: Database
  getSettings: () => Promise<Record<string, unknown> | null>
  providerRegistry: AiProviderRegistry
}

type EnrichedResult = AiRecommendation & { coverUrl?: string; alreadyOwned: boolean }

/** NDJSON events for the streamed variant (Accept: application/x-ndjson). */
export type MoodStreamEvent =
  | { type: 'result'; result: EnrichedResult }
  | { type: 'cover'; artistName: string; coverUrl: string }
  | { type: 'done'; count: number }
  | { type: 'error'; error: string }

type Enricher = {
  owned: (rec: AiRecommendation) => Promise<boolean>
  cover: (rec: AiRecommendation) => Promise<string | undefined>
}

const NO_ENRICHMENT: Enricher = {
  owned: async () => false,
  cover: async () => undefined,
}

function buildEnricher(db: Database, settings: Record<string, unknown>): Enricher {
  const { lidarrUrl, lidarrApiKey, skipTlsVerify, preferences } = settings
  if (!lidarrUrl || !lidarrApiKey) return NO_ENRICHMENT
  const lidarr: LidarrClient = getSharedLidarrClient(
    lidarrUrl as string,
    lidarrApiKey as string,
    (skipTlsVerify as boolean) ?? false,
  )
  // Lidarr's lookup responses carry cover art as paths relative to
  // Lidarr's own origin -- same public/internal split getLidarrClient
  // (requests.ts) uses.
  const imageBaseUrl = (
    (preferences as { lidarrPublicUrl?: string } | null)?.lidarrPublicUrl || (lidarrUrl as string)
  ).replace(/\/+$/, '')

  return {
    // "Already have it" is checked at the album level, not the artist
    // level -- an artist you own three albums by can still surface a
    // fourth one you don't. Only the specific suggestedAlbum matching an
    // album already in Lidarr for that artist counts; a result with no
    // suggestedAlbum (or an artist not in Lidarr at all) can't be checked
    // this way and is left unmarked rather than guessed at. Read from the
    // synced library snapshot rather than pulling Lidarr's entire artist
    // list (and each artist's albums) live per search.
    owned: async (r) => {
      if (!r.suggestedAlbum) return false
      try {
        const artist = normalizeArtistName(r.artistName)
        const titles = await getLidarrAlbumTitlesByArtist(db, [artist])
        return titles.get(artist)?.has(normalizeAlbumTitle(r.suggestedAlbum)) ?? false
      } catch (err) {
        console.warn('[mood] ownership check failed:', errMsg(err))
        return false
      }
    },
    // Cover art: search Lidarr's own metadata-server-backed lookup (works
    // for anything resolvable in MusicBrainz, not just what's already in
    // this Lidarr) and rank hits by how much of "artist + album" each one
    // actually accounts for -- same scoring the live album/artist search in
    // requests.ts uses, so a same-titled result by an unrelated artist
    // doesn't win.
    cover: async (r) => {
      try {
        if (r.suggestedAlbum) {
          const hits = await lidarr.lookupAlbum(r.suggestedAlbum)
          const queryTokens = tokenize(`${r.artistName} ${r.suggestedAlbum}`)
          const ranked = rankSearchResults(
            hits.filter((a) => a.artist?.foreignArtistId),
            queryTokens,
            (a) => ({
              tokens: [...tokenize(a.title), ...tokenize(a.artist?.artistName ?? '')],
            }),
          )
          const best = ranked[0]
          return resolveImageUrl(
            best?.images.find((img) => img.coverType === 'cover')?.url ?? best?.images[0]?.url,
            imageBaseUrl,
          )
        }
        const hits = await lidarr.lookupArtist(r.artistName)
        const queryTokens = tokenize(r.artistName)
        const ranked = rankSearchResults(hits, queryTokens, (a) => ({
          tokens: tokenize(a.artistName),
        }))
        const best = ranked[0]
        return resolveImageUrl(
          best?.images?.find((img) => img.coverType === 'poster')?.url ?? best?.images?.[0]?.url,
          imageBaseUrl,
        )
      } catch (err) {
        console.warn(`[mood] cover art lookup failed for "${r.artistName}":`, errMsg(err))
        return undefined
      }
    },
  }
}

function moodProfile(query: string): TasteProfile {
  return {
    topArtists: [],
    topGenres: [],
    listeningPatterns: { totalListens: 0, recentTrend: 'stable' },
    _rawPrompt: buildMoodPrompt(query),
  }
}

/**
 * Streams recommendations as the model writes them, falling back to the
 * one-shot call when the provider can't stream or the stream fails before
 * producing anything. Emits each recommendation exactly once.
 */
async function streamWithFallback(
  provider: RecommendationProvider,
  profile: TasteProfile,
  onRecommendation: (rec: AiRecommendation) => void,
): Promise<void> {
  const seen = new Set<string>()
  const emit = (rec: AiRecommendation) => {
    const key = `${rec.artistName.toLowerCase()}|${(rec.suggestedAlbum ?? '').toLowerCase()}`
    if (seen.has(key)) return
    seen.add(key)
    onRecommendation(rec)
  }
  if (provider.streamRecommendations) {
    try {
      const final = await provider.streamRecommendations(profile, emit)
      // Anything the incremental parser couldn't surface early (e.g. a
      // fenced/odd format) still arrives from the authoritative final list.
      for (const rec of final) emit(rec)
      return
    } catch (err) {
      if (seen.size > 0) throw err
      console.warn('[mood] streaming failed, retrying without streaming:', errMsg(err))
    }
  }
  for (const rec of await provider.getRecommendations(profile)) emit(rec)
}

export function moodRoutes(deps: MoodDeps) {
  const router = new Hono<HonoEnv>()

  router.post('/api/v1/mood/discover', zJson(moodDiscoverSchema), async (c) => {
    const { query } = c.req.valid('json')
    const trimmedQuery = query.trim()

    if (!trimmedQuery) {
      return apiError(c, 400, 'query is required')
    }

    const settings = await deps.getSettings()
    if (!settings) {
      return apiError(c, 400, 'Settings not configured')
    }

    const { aiProvider, aiModel, aiApiKey, aiBaseUrl } = settings as Record<string, string | null>
    if (!aiProvider || !aiModel) {
      return apiError(c, 400, 'AI provider not configured')
    }

    const provider = await deps.providerRegistry.create(aiProvider, {
      apiKey: aiApiKey ?? null,
      model: aiModel,
      baseUrl: aiBaseUrl ?? null,
      timeoutSeconds: envConfig.aiTimeoutSeconds ?? null,
    })
    const profile = moodProfile(trimmedQuery)
    const enricher = buildEnricher(deps.db, settings)
    const failureMessage = (err: unknown) =>
      `AI provider request failed (${aiProvider}/${aiModel}): ${errMsg(err)}`

    // Streamed: each card goes out the moment the model finishes writing it
    // (ownership is a quick DB read, sent with the card); cover art follows
    // as its own event so a slow Lidarr lookup never holds a card back.
    if ((c.req.header('Accept') ?? '').includes('application/x-ndjson')) {
      const encoder = new TextEncoder()
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          let open = true
          const send = (event: MoodStreamEvent) => {
            if (!open) return
            try {
              controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
            } catch {
              open = false
            }
          }
          const pending: Promise<void>[] = []
          let count = 0
          try {
            await streamWithFallback(provider, profile, (rec) => {
              count++
              pending.push(
                (async () => {
                  const alreadyOwned = await enricher.owned(rec)
                  send({ type: 'result', result: { ...rec, alreadyOwned } })
                  const coverUrl = await enricher.cover(rec)
                  if (coverUrl) send({ type: 'cover', artistName: rec.artistName, coverUrl })
                })(),
              )
            })
            await Promise.all(pending)
            send({ type: 'done', count })
          } catch (err) {
            console.error(`[mood] ${aiProvider} request failed:`, errMsg(err))
            await Promise.allSettled(pending)
            send({ type: 'error', error: failureMessage(err) })
          } finally {
            open = false
            controller.close()
          }
        },
      })
      return new Response(body, {
        headers: {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Cache-Control': 'no-cache',
          // Ask reverse proxies (nginx) not to buffer the stream.
          'X-Accel-Buffering': 'no',
        },
      })
    }

    let recs: AiRecommendation[]
    try {
      recs = await provider.getRecommendations(profile)
    } catch (err) {
      console.error(`[mood] ${aiProvider} request failed:`, errMsg(err))
      return apiError(c, 502, failureMessage(err))
    }

    const results: EnrichedResult[] = await Promise.all(
      recs.map(async (r) => {
        const [alreadyOwned, coverUrl] = await Promise.all([enricher.owned(r), enricher.cover(r)])
        return { ...r, alreadyOwned, coverUrl }
      }),
    )
    return c.json({ results })
  })

  return router
}
