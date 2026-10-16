import { describe, expect, it, vi } from 'vitest'
import { aiPromptStrategy } from '@/core/playlists/strategies/ai-prompt'
import type { StrategyAlbum, StrategyArtist, StrategyDeps } from '@/core/playlists/strategies/types'

const baseDeps: Pick<StrategyDeps, 'getApprovedArtists' | 'getOlderApprovedArtists'> = {
  getApprovedArtists: async () => [],
  getOlderApprovedArtists: async () => [],
}

describe('aiPromptStrategy', () => {
  it('returns [] when the prompt is empty', async () => {
    const deps: StrategyDeps = { ...baseDeps }
    const result = await aiPromptStrategy.selectArtists(deps, { size: 10, prompt: '  ' })
    expect(result).toEqual([])
  })

  it('prefers selectAlbumsWithAi over selectArtistsWithAi when both are present', async () => {
    const album: StrategyAlbum = {
      name: 'Artist',
      score: 0.9,
      albumTitle: 'Album',
    }
    const selectAlbumsWithAi = vi.fn().mockResolvedValue([album])
    const selectArtistsWithAi = vi.fn().mockResolvedValue([])
    const deps: StrategyDeps = { ...baseDeps, selectAlbumsWithAi, selectArtistsWithAi }

    const result = await aiPromptStrategy.selectArtists(deps, {
      size: 10,
      prompt: 'mellow 90s',
      useListeningHistory: true,
    })

    expect(selectAlbumsWithAi).toHaveBeenCalledWith({
      prompt: 'mellow 90s',
      size: 10,
      useListeningHistory: true,
    })
    expect(selectArtistsWithAi).not.toHaveBeenCalled()
    expect(result).toEqual([album])
  })

  it('falls back to selectArtistsWithAi when selectAlbumsWithAi is absent', async () => {
    const artist: StrategyArtist = { name: 'Artist', score: 0.5 }
    const selectArtistsWithAi = vi.fn().mockResolvedValue([artist])
    const deps: StrategyDeps = { ...baseDeps, selectArtistsWithAi }

    const result = await aiPromptStrategy.selectArtists(deps, { size: 10, prompt: 'mellow 90s' })

    expect(selectArtistsWithAi).toHaveBeenCalledWith({ prompt: 'mellow 90s', size: 10 })
    expect(result).toEqual([artist])
  })

  it('returns [] when neither AI selector is present', async () => {
    const deps: StrategyDeps = { ...baseDeps }
    const result = await aiPromptStrategy.selectArtists(deps, { size: 10, prompt: 'mellow 90s' })
    expect(result).toEqual([])
  })
})
