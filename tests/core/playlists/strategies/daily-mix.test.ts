import { describe, expect, it, vi } from 'vitest'
import { dailyMixStrategy } from '@/core/playlists/strategies/daily-mix'
import type { StrategyArtist, StrategyDeps } from '@/core/playlists/strategies/types'

function artist(name: string, score: number, genres: string[]): StrategyArtist {
  return { name, score, genres }
}

describe('dailyMixStrategy', () => {
  it('returns [] when getTrackTasteWeightedArtists is absent', async () => {
    const deps: StrategyDeps = {
      getApprovedArtists: async () => [],
      getOlderApprovedArtists: async () => [],
    }
    const result = await dailyMixStrategy.selectArtists(deps, { size: 25 })
    expect(result).toEqual([])
  })

  it('excludes holiday-only artists from every bucket', async () => {
    const pool: StrategyArtist[] = [
      ...Array.from({ length: 5 }, (_, i) => artist(`Rock ${i}`, 10 - i, ['rock'])),
      ...Array.from({ length: 5 }, (_, i) => artist(`Pop ${i}`, 10 - i, ['pop'])),
      artist('Mariah Carey Xmas', 999, ['christmas']),
      artist('Holiday Singers', 999, ['holiday pop']),
    ]
    const deps: StrategyDeps = {
      getApprovedArtists: async () => [],
      getOlderApprovedArtists: async () => [],
      getTrackTasteWeightedArtists: async () => pool,
    }

    const mix0 = await dailyMixStrategy.selectArtists(deps, { size: 9, mixIndex: 0 })
    const mix1 = await dailyMixStrategy.selectArtists(deps, { size: 9, mixIndex: 1 })
    const allSelected = [...mix0, ...mix1]

    expect(allSelected.some((a) => a.name.includes('Xmas'))).toBe(false)
    expect(allSelected.some((a) => a.name.includes('Holiday'))).toBe(false)
  })

  it('only returns artists belonging to the requested mix bucket', async () => {
    const pool: StrategyArtist[] = [
      ...Array.from({ length: 5 }, (_, i) => artist(`Rock ${i}`, 10 - i, ['rock'])),
      ...Array.from({ length: 5 }, (_, i) => artist(`Pop ${i}`, 10 - i, ['pop'])),
    ]
    const deps: StrategyDeps = {
      getApprovedArtists: async () => [],
      getOlderApprovedArtists: async () => [],
      getTrackTasteWeightedArtists: async () => pool,
    }

    const mix0 = await dailyMixStrategy.selectArtists(deps, { size: 9, mixIndex: 0 })
    expect(mix0.length).toBeGreaterThan(0)
    expect(mix0.every((a) => a.genres?.includes('rock'))).toBe(true)
  })

  it('varies artist selection across regenerations instead of always picking the same top-N', async () => {
    const pool: StrategyArtist[] = Array.from({ length: 40 }, (_, i) =>
      artist(`Rock ${i}`, 40 - i, ['rock']),
    )
    const deps: StrategyDeps = {
      getApprovedArtists: async () => [],
      getOlderApprovedArtists: async () => [],
      getTrackTasteWeightedArtists: async () => pool,
    }

    const randomSpy = vi.spyOn(Math, 'random')
    randomSpy.mockReturnValue(0.01)
    const first = await dailyMixStrategy.selectArtists(deps, { size: 9, mixIndex: 0 })
    randomSpy.mockReturnValue(0.99)
    const second = await dailyMixStrategy.selectArtists(deps, { size: 9, mixIndex: 0 })
    randomSpy.mockRestore()

    expect(first.map((a) => a.name)).not.toEqual(second.map((a) => a.name))
  })
})
