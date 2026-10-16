import type { StrategyArtist } from './strategies/types'

export type MixBucket = {
  /** Lowercased/normalized genre this bucket is centered on. */
  genre: string
  artists: StrategyArtist[]
}

// Below this, a bucket reads as "not really a mix" -- drop it rather than
// surface a near-empty playlist.
const MIN_BUCKET_SIZE = 3

/**
 * Splits a taste-weighted artist pool into a handful of genre-coherent
 * buckets (Spotify Daily Mix-style): rank genres by total weighted presence
 * across the pool, then greedily build one bucket per genre (highest-weight
 * first), assigning each artist to at most one bucket so buckets don't
 * overlap. Genres that can't clear MIN_BUCKET_SIZE are skipped rather than
 * surfaced as a near-empty mix.
 *
 * If a user's genre tags are sparse or heavily overlapping, fewer than
 * `mixCount` genres may ever reach MIN_BUCKET_SIZE this way -- rather than
 * leaving a mix slot permanently empty (e.g. "Daily Mix 3" never
 * generating), whatever's left over (including untagged artists) is folded
 * into one broader catch-all bucket so every mix index still gets
 * something.
 */
export function clusterIntoMixes(pool: StrategyArtist[], mixCount = 3): MixBucket[] {
  const genreWeight = new Map<string, number>()
  for (const artist of pool) {
    for (const genre of artist.genres ?? []) {
      const key = genre.trim().toLowerCase()
      if (!key) continue
      genreWeight.set(key, (genreWeight.get(key) ?? 0) + artist.score)
    }
  }

  const rankedGenres = [...genreWeight.entries()].sort((a, b) => b[1] - a[1]).map(([g]) => g)
  if (rankedGenres.length === 0) return []

  const assigned = new Set<StrategyArtist>()
  const buckets: MixBucket[] = []

  for (const genre of rankedGenres) {
    if (buckets.length >= mixCount) break
    const artists = pool.filter(
      (a) => !assigned.has(a) && (a.genres ?? []).some((g) => g.trim().toLowerCase() === genre),
    )
    if (artists.length < MIN_BUCKET_SIZE) continue
    for (const a of artists) assigned.add(a)
    buckets.push({ genre, artists })
  }

  if (buckets.length < mixCount) {
    const leftover = pool.filter((a) => !assigned.has(a))
    if (leftover.length >= MIN_BUCKET_SIZE) {
      buckets.push({ genre: 'mixed', artists: leftover })
    }
  }

  return buckets
}
