import { Hono } from 'hono'
import { envConfig } from '@/config/env'
import { createLidarrClient, type LidarrAlbum } from '@/core/clients/lidarr'
import { buildMoodPrompt } from '@/core/providers/prompt'
import type { AiProviderRegistry } from '@/core/providers/registry'
import { errMsg } from '@/core/validation'
import { moodDiscoverSchema } from '@/server/schemas/mood'
import { zJson } from '@/server/schemas/validator'
import type { HonoEnv } from '@/server/types'
import { rankSearchResults, resolveImageUrl, tokenize } from './requests'

export type MoodDeps = {
  getSettings: () => Promise<Record<string, unknown> | null>
  providerRegistry: AiProviderRegistry
}

export function moodRoutes(deps: MoodDeps) {
  const router = new Hono<HonoEnv>()

  router.post('/api/v1/mood/discover', zJson(moodDiscoverSchema), async (c) => {
    const { query } = c.req.valid('json')
    const trimmedQuery = query.trim()

    if (!trimmedQuery) {
      return c.json({ error: 'query is required' }, 400)
    }

    const settings = await deps.getSettings()
    if (!settings) {
      return c.json({ error: 'Settings not configured' }, 400)
    }

    const { aiProvider, aiModel, aiApiKey, aiBaseUrl } = settings as Record<string, string | null>
    if (!aiProvider || !aiModel) {
      return c.json({ error: 'AI provider not configured' }, 400)
    }

    const provider = await deps.providerRegistry.create(aiProvider, {
      apiKey: aiApiKey ?? null,
      model: aiModel,
      baseUrl: aiBaseUrl ?? null,
      timeoutSeconds: envConfig.aiTimeoutSeconds ?? null,
    })

    const prompt = buildMoodPrompt(trimmedQuery)
    let recs: Awaited<ReturnType<typeof provider.getRecommendations>>
    try {
      recs = await provider.getRecommendations({
        topArtists: [],
        topGenres: [],
        listeningPatterns: { totalListens: 0, recentTrend: 'stable' },
        _rawPrompt: prompt,
      })
    } catch (err) {
      const detail = errMsg(err)
      console.error(`[mood] ${aiProvider} request failed:`, detail)
      return c.json(
        { error: `AI provider request failed (${aiProvider}/${aiModel}): ${detail}` },
        502,
      )
    }

    type EnrichedResult = (typeof recs)[number] & { coverUrl?: string; alreadyOwned: boolean }
    let results: EnrichedResult[] = recs.map((r) => ({ ...r, alreadyOwned: false }))

    const { lidarrUrl, lidarrApiKey, skipTlsVerify, preferences } = settings as Record<
      string,
      unknown
    >
    if (lidarrUrl && lidarrApiKey) {
      try {
        const lidarr = createLidarrClient(
          lidarrUrl as string,
          lidarrApiKey as string,
          (skipTlsVerify as boolean) ?? false,
        )
        // Lidarr's lookup responses carry cover art as paths relative to
        // Lidarr's own origin -- same public/internal split getLidarrClient
        // (requests.ts) uses.
        const imageBaseUrl = (
          (preferences as { lidarrPublicUrl?: string } | null)?.lidarrPublicUrl ||
          (lidarrUrl as string)
        ).replace(/\/+$/, '')

        // "Already have it" is checked at the album level, not the artist
        // level -- an artist you own three albums by can still surface a
        // fourth one you don't. Only the specific suggestedAlbum matching an
        // album already in Lidarr for that artist counts; a result with no
        // suggestedAlbum (or an artist not in Lidarr at all) can't be
        // checked this way and is left unmarked rather than guessed at.
        const artists = await lidarr.getArtists()
        const artistByNameLower = new Map(artists.map((a) => [a.artistName.toLowerCase(), a]))
        const albumsByArtistId = new Map<number, LidarrAlbum[]>()

        results = await Promise.all(
          recs.map(async (r) => {
            let alreadyOwned = false
            const artist = artistByNameLower.get(r.artistName.toLowerCase())
            if (r.suggestedAlbum && artist) {
              let albums = albumsByArtistId.get(artist.id)
              if (!albums) {
                try {
                  albums = await lidarr.getAlbums(artist.id)
                } catch {
                  albums = []
                }
                albumsByArtistId.set(artist.id, albums)
              }
              const suggestedTitle = r.suggestedAlbum.trim().toLowerCase()
              alreadyOwned = albums.some(
                (album) => album.title.trim().toLowerCase() === suggestedTitle,
              )
            }

            // Cover art: search Lidarr's own metadata-server-backed lookup
            // (works for anything resolvable in MusicBrainz, not just what's
            // already in this Lidarr) and rank hits by how much of
            // "artist + album" each one actually accounts for -- same
            // scoring the live album/artist search in requests.ts uses, so
            // a same-titled result by an unrelated artist doesn't win.
            let coverUrl: string | undefined
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
                coverUrl = resolveImageUrl(
                  best?.images.find((img) => img.coverType === 'cover')?.url ??
                    best?.images[0]?.url,
                  imageBaseUrl,
                )
              } else {
                const hits = await lidarr.lookupArtist(r.artistName)
                const queryTokens = tokenize(r.artistName)
                const ranked = rankSearchResults(hits, queryTokens, (a) => ({
                  tokens: tokenize(a.artistName),
                }))
                const best = ranked[0]
                coverUrl = resolveImageUrl(
                  best?.images?.find((img) => img.coverType === 'poster')?.url ??
                    best?.images?.[0]?.url,
                  imageBaseUrl,
                )
              }
            } catch (err) {
              console.warn(`[mood] cover art lookup failed for "${r.artistName}":`, errMsg(err))
            }

            return { ...r, alreadyOwned, coverUrl }
          }),
        )
      } catch (err) {
        console.warn('[mood] Lidarr enrichment failed:', errMsg(err))
      }
    }

    return c.json({ results })
  })

  return router
}
