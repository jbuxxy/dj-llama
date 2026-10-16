import { normalizeArtistName } from '@/core/library/normalize'
import { buildTrackRecommendationPrompt } from '@/core/providers/prompt'
import { redactSecrets } from '@/core/providers/retry'
import type { SimilarTrackProvider } from '@/core/similarity/providers'
import type {
  AiRecommendation,
  DiscoveredArtist,
  TrackTasteProfile,
  TrackTasteSignal,
} from '@/core/types'

// How many of the user's top-weighted track signals get used as AI
// track-recommendation seeds.
const SEED_TRACK_LIMIT = 15

export type DiscoveredTrack = {
  artistName: string
  /** Empty when only recordingMbid is known; resolveTrackToAlbum looks it up. */
  trackName: string
  recordingMbid?: string
  similarityScore: number
  aiReasoning?: string
  genres?: string[]
  source: string
}

interface AiTrackSource {
  getRecommendations: (profile: {
    topArtists: []
    topGenres: []
    listeningPatterns: { totalListens: number; recentTrend: 'stable' }
    _rawPrompt: string
  }) => Promise<AiRecommendation[]>
}

export type TrackDiscoverySources = {
  ai?: AiTrackSource | null
  /** Similar-track lookups (ListenBrainz, Last.fm) run against every seed track. */
  similar?: SimilarTrackProvider[]
}

export type TrackDiscoveryOptions = {
  /** Library artists with MBIDs: Plex seeds carry none, and ListenBrainz needs one. */
  libraryArtists?: Array<{ name: string; mbid: string }>
  onSourceFailure?: (sourceId: string, error: string) => void
  /** Similar tracks each provider returned, before capping. */
  onSourceResults?: (sourceId: string, count: number) => void
}

/** Similar-track candidates that go on to (MusicBrainz-bound, ~1 req/s) album resolution. */
export const SIMILAR_TRACK_CAP = 40

/**
 * Keep the strongest similar tracks. Strength sums (similarity x how much you
 * like the seed) across seeds and providers, so a track close to several of
 * your favourites -- or found by both providers -- ranks first. Every entry for
 * a kept track survives so scoring still sees which sources agreed.
 */
export function capSimilarTracks(tracks: DiscoveredTrack[], cap = SIMILAR_TRACK_CAP) {
  const keyOf = (t: DiscoveredTrack) =>
    t.recordingMbid ?? `${normalizeArtistName(t.artistName)}|${t.trackName.toLowerCase().trim()}`
  const strength = new Map<string, number>()
  for (const t of tracks) strength.set(keyOf(t), (strength.get(keyOf(t)) ?? 0) + t.similarityScore)
  const kept = new Set(
    [...strength.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, cap)
      .map(([k]) => k),
  )
  return tracks.filter((t) => kept.has(keyOf(t)))
}

function becauseYouLike(seed: TrackTasteSignal): string {
  const how =
    seed.signalType === 'liked'
      ? 'you liked'
      : seed.signalType === 'recent_play'
        ? "you've been playing"
        : 'you like'
  return `Similar to "${seed.trackName}" by ${seed.artistName}, which ${how}.`
}

function seedTracks(profile: TrackTasteProfile): TrackTasteSignal[] {
  return profile.signals.filter((s) => s.trackName).slice(0, SEED_TRACK_LIMIT)
}

/**
 * Track-level counterpart to discover()'s artist-similarity fan-out: asks the
 * AI for similar tracks grounded in the listener's top-weighted liked/recent
 * tracks. A missing/failing AI provider just means no track candidates this
 * run, never an aborted run (mirrors discover()'s onSourceFailure/try-catch
 * pattern).
 */
export async function discoverSimilarTracks(
  profile: TrackTasteProfile,
  sources: TrackDiscoverySources,
  options: TrackDiscoveryOptions = {},
): Promise<DiscoveredTrack[]> {
  const results: DiscoveredTrack[] = []
  const seeds = seedTracks(profile)

  const providers = sources.similar ?? []
  if (providers.length > 0 && seeds.length > 0) {
    const mbidByArtist = new Map(
      (options.libraryArtists ?? []).map((a) => [normalizeArtistName(a.name), a.mbid]),
    )
    const similar: DiscoveredTrack[] = []
    const failures = new Map<string, string>()
    // ListenBrainz answers per artist, so ask it once per seed artist (with
    // that artist's strongest seed track as the reason).
    const askedLbArtists = new Set<string>()
    await Promise.all(
      seeds.flatMap((seed) => {
        const trackName = seed.trackName as string
        // (seed.mbid is the track's recording MBID, not the artist's.)
        const artistMbid = mbidByArtist.get(normalizeArtistName(seed.artistName))
        return providers.map(async (provider) => {
          if (provider.requiresArtistMbid) {
            if (!artistMbid || askedLbArtists.has(artistMbid)) return
            askedLbArtists.add(artistMbid)
          }
          try {
            const found = await provider.getSimilarTracks({
              artistName: seed.artistName,
              trackName,
              artistMbid,
            })
            const seedWeight = Math.min(1, Math.max(0.3, seed.weight))
            for (const t of found) {
              similar.push({
                artistName: t.artistName,
                trackName: t.trackName,
                recordingMbid: t.recordingMbid,
                similarityScore: t.similarityScore * seedWeight,
                aiReasoning: becauseYouLike(seed),
                source: provider.id,
              })
            }
          } catch (err) {
            failures.set(
              provider.id,
              redactSecrets(err instanceof Error ? err.message : String(err)),
            )
          }
        })
      }),
    )
    for (const provider of providers) {
      const failure = failures.get(provider.id)
      if (failure) {
        console.warn(`[discover-tracks] ${provider.name} lookups failed: ${failure}`)
        options.onSourceFailure?.(provider.id, failure)
      }
      options.onSourceResults?.(provider.id, similar.filter((t) => t.source === provider.id).length)
    }
    results.push(...capSimilarTracks(similar))
  }

  if (sources.ai) {
    try {
      const prompt = buildTrackRecommendationPrompt(seeds)
      const recs = await sources.ai.getRecommendations({
        topArtists: [],
        topGenres: [],
        listeningPatterns: { totalListens: 0, recentTrend: 'stable' },
        _rawPrompt: prompt,
      })
      for (const rec of recs) {
        if (!rec.trackName) continue
        results.push({
          artistName: rec.artistName,
          trackName: rec.trackName,
          similarityScore: rec.confidence,
          aiReasoning: rec.reasoning,
          genres: rec.genres,
          // Deliberately 'ai', not 'ai-track' -- score.ts's aiReasoning/
          // aiConfidence components key off source === 'ai' exactly, and
          // reusing it here means track-derived AI recs get real reasoning
          // and confidence surfaced with zero changes to score.ts. Never
          // collides with the artist-similarity path's own 'ai' discoveries
          // since track-path and artist-path candidates resolve to distinct
          // ResolvedArtist objects.
          source: 'ai',
        })
      }
    } catch (err) {
      console.warn(
        `[discover-tracks] AI track recommendation failed: ${redactSecrets(err instanceof Error ? err.message : String(err))}`,
      )
    }
  }

  return results
}

/**
 * Turn artist-level picks (AI artist suggestions) into track candidates, so
 * their album is chosen through a song like every other recommendation. A
 * pick that named its starting track uses it; one that didn't gets the
 * artist's most-played Last.fm track; with neither, it's dropped -- there's
 * no track to choose an album by.
 */
export async function artistPicksToTracks(
  picks: DiscoveredArtist[],
  topTracks?:
    | ((artistName: string, mbid?: string) => Promise<Array<{ trackName: string; mbid?: string }>>)
    | null,
): Promise<DiscoveredTrack[]> {
  const out = await Promise.all(
    picks.map(async (pick): Promise<DiscoveredTrack | null> => {
      const base = {
        artistName: pick.name,
        similarityScore: pick.similarityScore,
        aiReasoning: pick.aiReasoning,
        genres: pick.genres,
        source: pick.source,
      }
      if (pick.trackName) return { ...base, trackName: pick.trackName }
      if (!topTracks) return null
      try {
        const [top] = await topTracks(pick.name, pick.mbid)
        return top ? { ...base, trackName: top.trackName, recordingMbid: top.mbid } : null
      } catch {
        return null
      }
    }),
  )
  return out.filter((t): t is DiscoveredTrack => t !== null)
}
