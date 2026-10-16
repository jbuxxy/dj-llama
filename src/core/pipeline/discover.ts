import type { DiscoverySource } from '@/core/plugins/types'
import { redactSecrets } from '@/core/providers/retry'
import type { AiRecommendation, DiscoveredArtist, TasteProfile } from '@/core/types'

const ARTICLES = /^(the|a|an)\s+/i

/** Normalize an artist name for comparison: lowercase, strip leading articles. */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(ARTICLES, '').trim()
}

/**
 * Detect likely AI name confusion - the model meant to describe a top artist
 * but output a similarly-named different artist. Checks substring containment
 * in both directions (covers "Sonic Youth" in "Sonic Youth Junior").
 */
function hasNameConfusion(recName: string, topArtistNames: string[]): string | null {
  const recNorm = normalizeName(recName)
  for (const topName of topArtistNames) {
    const topNorm = normalizeName(topName)
    if (recNorm === topNorm) continue // exact match handled by topArtistNames filter
    if (topNorm.length < 4) continue // skip very short names to avoid false positives
    if (recNorm.includes(topNorm) || topNorm.includes(recNorm)) return topName
  }
  return null
}

/**
 * Detect when AI reasoning is actually ABOUT a different top artist, not the
 * one being recommended -- e.g. reasoning for "Digital Underground" literally
 * describes "Velvet Underground" and never mentions Digital Underground at
 * all. Good, ordinary reasoning routinely cites a top artist for comparison
 * ("similar to your love of X") while still centering on the recommended
 * artist by name -- that's expected and NOT a red flag, so this only fires
 * when the reasoning never actually names the artist it's supposedly about.
 */
function reasoningMentionsTopArtist(
  reasoning: string,
  recName: string,
  topArtistNames: string[],
): boolean {
  const reaNorm = reasoning.toLowerCase()
  const recNorm = normalizeName(recName)
  if (reaNorm.includes(recNorm)) return false
  for (const topName of topArtistNames) {
    const topNorm = normalizeName(topName)
    if (recNorm === topNorm) continue
    if (topNorm.length < 5) continue // avoid matching short common words
    if (reaNorm.includes(topNorm)) return true
  }
  return false
}

interface AiSource {
  getRecommendations: (profile: TasteProfile) => Promise<AiRecommendation[]>
}

export interface DiscoverSources {
  /** Listening source plugins (Plex, Deezer, etc.) */
  listeningSources?: DiscoverySource[]
  ai?: AiSource | null
}

export type DiscoverOptions = {
  /** Invoked when a source fails entirely, so callers can surface the real error. */
  onSourceFailure?: (sourceId: string, error: string) => void
}

export async function discover(
  profile: TasteProfile,
  sources: DiscoverSources,
  topArtistsLimit: number,
  libraryArtists?: Array<{ mbid: string; name: string }>,
  librarySeedRatio = 0.3,
  options: DiscoverOptions = {},
): Promise<DiscoveredArtist[]> {
  const topArtists = profile.topArtists.slice(0, topArtistsLimit)
  const results: DiscoveredArtist[] = []

  // Mix in library artists based on librarySeedRatio (0 = none, 1 = all library)
  let seedArtists = topArtists
  if (libraryArtists && libraryArtists.length > 0 && librarySeedRatio > 0) {
    const librarySlots = Math.max(1, Math.round(topArtistsLimit * librarySeedRatio))
    const listeningSlots = topArtistsLimit - librarySlots

    // Fisher-Yates shuffle for uniform distribution
    const shuffled = [...libraryArtists]
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      const current = shuffled[i]
      const swap = shuffled[j]
      if (!current || !swap) {
        throw new Error('Unexpected missing library artist during shuffle')
      }
      shuffled[i] = swap
      shuffled[j] = current
    }
    // Exclude artists already in topArtists
    const topMbids = new Set(topArtists.map((a) => a.mbid).filter(Boolean))
    const librarySeeds = shuffled
      .filter((a) => !topMbids.has(a.mbid))
      .slice(0, librarySlots)
      .map((a) => ({
        name: a.name,
        mbid: a.mbid,
        playCount: 0,
        source: 'library' as const,
      }))

    seedArtists = [...topArtists.slice(0, listeningSlots), ...librarySeeds]
  }

  const listeningSources = sources.listeningSources ?? []

  // Aggregate per-source failures so a dead source is logged once, not per seed.
  const sourceFailures = new Map<string, { count: number; lastError: string }>()
  await Promise.all(
    seedArtists.map(async (artist) => {
      for (const source of listeningSources) {
        try {
          const similar = await source.getSimilarArtists(artist.name, artist.mbid)
          for (const s of similar) {
            results.push({
              name: s.name,
              mbid: s.mbid,
              similarityScore: s.similarityScore,
              source: source.id,
            })
          }
        } catch (err) {
          const prev = sourceFailures.get(source.id)
          sourceFailures.set(source.id, {
            count: (prev?.count ?? 0) + 1,
            lastError: redactSecrets(err instanceof Error ? err.message : String(err)),
          })
        }
      }
    }),
  )
  for (const [sourceId, { count, lastError }] of sourceFailures) {
    console.warn(
      `[discover] source ${sourceId} failed for ${count} seed artist(s); last error: ${lastError}`,
    )
    options.onSourceFailure?.(sourceId, lastError)
  }

  // One AI call with the full profile
  if (sources.ai != null) {
    try {
      const aiRecs = await sources.ai.getRecommendations(profile)
      console.log(`[debug-diag] AI getRecommendations() returned ${aiRecs.length} raw suggestions`)
      // Cross-check AI recommendations against the user's top artists to catch
      // name confusion hallucinations (e.g. "Digital Underground" with a
      // description of "Velvet Underground"). Uses the FULL top artists list,
      // not just the seed slice, for maximum coverage.
      const allTopNames = profile.topArtists.map((a) => a.name)
      for (const rec of aiRecs) {
        const confusedWith = hasNameConfusion(rec.artistName, allTopNames)
        if (confusedWith) {
          console.log(
            `[debug-diag] rejected "${rec.artistName}": name-confusion with top artist "${confusedWith}"`,
          )
          continue
        }
        if (reasoningMentionsTopArtist(rec.reasoning, rec.artistName, allTopNames)) {
          console.log(`[debug-diag] rejected "${rec.artistName}": reasoning-mentions-top-artist`)
          continue
        }
        results.push({
          name: rec.artistName,
          similarityScore: rec.confidence,
          aiReasoning: rec.reasoning,
          trackName: rec.trackName,
          genres: rec.genres,
          source: 'ai',
        })
      }
    } catch (err) {
      const detail = redactSecrets(err instanceof Error ? err.message : String(err))
      console.warn(`[discover] AI source failed: ${detail}`)
      options.onSourceFailure?.('ai', detail)
    }
  }

  return results
}
