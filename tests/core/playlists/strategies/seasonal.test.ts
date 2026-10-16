import { describe, expect, it } from 'vitest'
import { seasonalStrategy } from '@/core/playlists/strategies/seasonal'
import type { StrategyArtist, StrategyDeps } from '@/core/playlists/strategies/types'

function artist(name: string, score: number, genres?: string[]): StrategyArtist {
  return { name, score, genres }
}

describe('seasonalStrategy', () => {
  it('falls back to getApprovedArtists sorted by score when no preset matches presetKey', async () => {
    const deps: StrategyDeps = {
      getApprovedArtists: async () => [artist('B', 1), artist('A', 5)],
      getOlderApprovedArtists: async () => [],
    }
    const result = await seasonalStrategy.selectArtists(deps, {
      size: 6,
      presetKey: 'not-a-real-preset',
    })
    expect(result.map((a) => a.name)).toEqual(['A', 'B'])
  })

  it('does not hard-exclude non-matching artists (boost, never filter) -- the daily_mix variety bug', async () => {
    // A mainstream artist with no "christmas" genre tag (e.g. Mariah Carey in
    // reality) must still be eligible for a Christmas playlist -- the old
    // implementation hard-filtered the pool down to genre-tagged artists
    // only, which structurally could never surface her.
    const pool: StrategyArtist[] = [
      artist('Mainstream Pop Star', 50, ['pop']),
      artist('Dedicated Christmas Artist', 10, ['christmas']),
    ]
    const deps: StrategyDeps = {
      getApprovedArtists: async () => [],
      getOlderApprovedArtists: async () => [],
      getTrackTasteWeightedArtists: async () => pool,
    }

    const result = await seasonalStrategy.selectArtists(deps, { size: 6, presetKey: 'christmas' })
    expect(result.some((a) => a.name === 'Mainstream Pop Star')).toBe(true)
  })

  it('boosts a genre-matching artist above a higher-taste-score non-match for an iconic preset', async () => {
    const pool: StrategyArtist[] = [
      artist('Unrelated Pop Artist', 20, ['pop']),
      artist('Halloween Specialist', 10, ['horror', 'goth']),
    ]
    const deps: StrategyDeps = {
      getApprovedArtists: async () => [],
      getOlderApprovedArtists: async () => [],
      getTrackTasteWeightedArtists: async () => pool,
    }

    const result = await seasonalStrategy.selectArtists(deps, { size: 3, presetKey: 'halloween' })
    expect(result[0]?.name).toBe('Halloween Specialist')
  })

  it('uses the broad taste+library pool (includeLibraryFiller) rather than the narrow approved-only pool', async () => {
    let capturedOpts: { includeLibraryFiller?: boolean } | undefined
    const deps: StrategyDeps = {
      getApprovedArtists: async () => {
        throw new Error(
          'should not call getApprovedArtists when getTrackTasteWeightedArtists is available',
        )
      },
      getOlderApprovedArtists: async () => [],
      getTrackTasteWeightedArtists: async (opts) => {
        capturedOpts = opts
        return [artist('Some Artist', 5, ['rock'])]
      },
    }

    await seasonalStrategy.selectArtists(deps, { size: 6, presetKey: 'summer' })
    expect(capturedOpts?.includeLibraryFiller).toBe(true)
  })

  it('falls back to getApprovedArtists when getTrackTasteWeightedArtists is unavailable', async () => {
    const deps: StrategyDeps = {
      getApprovedArtists: async () => [artist('Halloween Specialist', 5, ['horror'])],
      getOlderApprovedArtists: async () => [],
    }
    const result = await seasonalStrategy.selectArtists(deps, { size: 3, presetKey: 'halloween' })
    expect(result.map((a) => a.name)).toEqual(['Halloween Specialist'])
  })
})
