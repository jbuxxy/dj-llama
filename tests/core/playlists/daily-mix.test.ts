import { describe, expect, it } from 'vitest'
import { clusterIntoMixes } from '@/core/playlists/daily-mix'
import type { StrategyArtist } from '@/core/playlists/strategies/types'

function artist(name: string, score: number, genres: string[]): StrategyArtist {
  return { name, score, genres }
}

describe('clusterIntoMixes', () => {
  it('returns one bucket per genre when there are exactly mixCount genres', () => {
    const pool = [
      ...Array.from({ length: 4 }, (_, i) => artist(`Rock ${i}`, 10 - i, ['rock'])),
      ...Array.from({ length: 4 }, (_, i) => artist(`Pop ${i}`, 10 - i, ['pop'])),
      ...Array.from({ length: 4 }, (_, i) => artist(`Jazz ${i}`, 10 - i, ['jazz'])),
    ]

    const buckets = clusterIntoMixes(pool, 3)

    expect(buckets).toHaveLength(3)
    expect(buckets.map((b) => b.genre)).toEqual(['rock', 'pop', 'jazz'])
  })

  it('folds leftovers into a catch-all bucket instead of leaving a mix slot empty', () => {
    // Only two genres have enough artists to form a coherent bucket on
    // their own -- without a fallback, the third mix would never generate
    // (the reported "Daily Mix 3 never generates" bug).
    const pool = [
      ...Array.from({ length: 5 }, (_, i) => artist(`Rock ${i}`, 10 - i, ['rock'])),
      ...Array.from({ length: 5 }, (_, i) => artist(`Pop ${i}`, 10 - i, ['pop'])),
      artist('Odd One', 1, ['polka']),
      artist('Odd Two', 1, ['zydeco']),
      artist('No Genre Artist', 1, []),
    ]

    const buckets = clusterIntoMixes(pool, 3)

    expect(buckets).toHaveLength(3)
    const catchAll = buckets[2]
    expect(catchAll?.genre).toBe('mixed')
    expect(catchAll?.artists.map((a) => a.name)).toEqual(
      expect.arrayContaining(['Odd One', 'Odd Two', 'No Genre Artist']),
    )
  })

  it('does not duplicate an artist across buckets', () => {
    // Tagged with both of two dominant genres -- should land in exactly one.
    const pool = [
      ...Array.from({ length: 4 }, (_, i) => artist(`Rock ${i}`, 10 - i, ['rock'])),
      ...Array.from({ length: 4 }, (_, i) => artist(`Pop ${i}`, 10 - i, ['pop'])),
      artist('Rock Pop Hybrid', 20, ['rock', 'pop']),
    ]

    const buckets = clusterIntoMixes(pool, 2)
    const allNames = buckets.flatMap((b) => b.artists.map((a) => a.name))
    const occurrences = allNames.filter((n) => n === 'Rock Pop Hybrid').length

    expect(occurrences).toBe(1)
  })

  it('returns [] when no artist has any genre data', () => {
    const pool = Array.from({ length: 10 }, (_, i) => artist(`Artist ${i}`, 10 - i, []))
    expect(clusterIntoMixes(pool, 3)).toEqual([])
  })

  it('omits a bucket entirely when even the catch-all is too small', () => {
    const pool = [
      ...Array.from({ length: 5 }, (_, i) => artist(`Rock ${i}`, 10 - i, ['rock'])),
      artist('Lone Pop', 1, ['pop']),
    ]

    const buckets = clusterIntoMixes(pool, 3)

    expect(buckets).toHaveLength(1)
    expect(buckets[0]?.genre).toBe('rock')
  })
})
