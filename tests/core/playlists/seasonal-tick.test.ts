import { describe, expect, it, vi } from 'vitest'
import { tickSeasonalPlaylists } from '@/core/playlists/seasonal-tick'

type FakePlaylist = {
  id: number
  name: string
  config: {
    presetKey?: string
    windowOverride?: { startMonth: number; startDay: number; endMonth: number; endDay: number }
  } | null
  status: string
}

const HALLOWEEN_IN_WINDOW = new Date('2026-10-15T12:00:00Z')
const HALLOWEEN_OUT_OF_WINDOW = new Date('2026-11-15T12:00:00Z')

function makePlaylist(overrides: Partial<FakePlaylist> = {}): FakePlaylist {
  return {
    id: 1,
    name: 'Halloween Mix',
    config: { presetKey: 'halloween' },
    status: 'pending_review',
    ...overrides,
  }
}

describe('tickSeasonalPlaylists', () => {
  it('generates a playlist whose window just opened', async () => {
    const playlist = makePlaylist({ status: 'pending_review' })
    const generatePlaylist = vi.fn().mockResolvedValue(undefined)
    const tearDownPlaylist = vi.fn().mockResolvedValue(undefined)
    const onGenerated = vi.fn()

    await tickSeasonalPlaylists({
      getEnabledSeasonalPlaylists: async () => [playlist],
      generatePlaylist,
      tearDownPlaylist,
      onGenerated,
      now: HALLOWEEN_IN_WINDOW,
    })

    expect(generatePlaylist).toHaveBeenCalledWith(1)
    expect(tearDownPlaylist).not.toHaveBeenCalled()
    expect(onGenerated).toHaveBeenCalledWith(playlist)
  })

  it('tears down a playlist whose window just closed', async () => {
    const playlist = makePlaylist({ status: 'active' })
    const generatePlaylist = vi.fn().mockResolvedValue(undefined)
    const tearDownPlaylist = vi.fn().mockResolvedValue(undefined)
    const onTornDown = vi.fn()

    await tickSeasonalPlaylists({
      getEnabledSeasonalPlaylists: async () => [playlist],
      generatePlaylist,
      tearDownPlaylist,
      onTornDown,
      now: HALLOWEEN_OUT_OF_WINDOW,
    })

    expect(tearDownPlaylist).toHaveBeenCalledWith(playlist)
    expect(generatePlaylist).not.toHaveBeenCalled()
    expect(onTornDown).toHaveBeenCalledWith(playlist)
  })

  it('does nothing when state already matches the window (idempotent)', async () => {
    const inWindowAlreadyGenerated = makePlaylist({
      id: 1,
      status: 'active',
    })
    const outOfWindowAlreadyTornDown = makePlaylist({
      id: 2,
      config: { presetKey: 'summer' },
      status: 'pending_review',
    })
    const generatePlaylist = vi.fn().mockResolvedValue(undefined)
    const tearDownPlaylist = vi.fn().mockResolvedValue(undefined)

    await tickSeasonalPlaylists({
      getEnabledSeasonalPlaylists: async () => [
        inWindowAlreadyGenerated,
        outOfWindowAlreadyTornDown,
      ],
      generatePlaylist,
      tearDownPlaylist,
      now: HALLOWEEN_IN_WINDOW,
    })

    expect(generatePlaylist).not.toHaveBeenCalled()
    expect(tearDownPlaylist).not.toHaveBeenCalled()
  })

  it('skips playlists whose presetKey does not resolve to a known preset', async () => {
    const playlist = makePlaylist({ config: { presetKey: 'not-a-real-preset' } })
    const generatePlaylist = vi.fn().mockResolvedValue(undefined)
    const tearDownPlaylist = vi.fn().mockResolvedValue(undefined)

    await tickSeasonalPlaylists({
      getEnabledSeasonalPlaylists: async () => [playlist],
      generatePlaylist,
      tearDownPlaylist,
      now: HALLOWEEN_IN_WINDOW,
    })

    expect(generatePlaylist).not.toHaveBeenCalled()
    expect(tearDownPlaylist).not.toHaveBeenCalled()
  })

  it('continues to the next playlist when generation fails for one', async () => {
    const failing = makePlaylist({ id: 1, name: 'Failing' })
    const succeeding = makePlaylist({ id: 2, name: 'Succeeding' })
    const generatePlaylist = vi.fn().mockImplementation(async (id: number) => {
      if (id === 1) throw new Error('boom')
    })
    const onGenerateFailed = vi.fn()
    const onGenerated = vi.fn()

    await tickSeasonalPlaylists({
      getEnabledSeasonalPlaylists: async () => [failing, succeeding],
      generatePlaylist,
      tearDownPlaylist: vi.fn().mockResolvedValue(undefined),
      onGenerateFailed,
      onGenerated,
      now: HALLOWEEN_IN_WINDOW,
    })

    expect(onGenerateFailed).toHaveBeenCalledWith(failing, expect.any(Error))
    expect(onGenerated).toHaveBeenCalledWith(succeeding)
  })

  it('respects a per-row window override over the preset default', async () => {
    // Halloween's default window is Oct 1-31; override it to Nov 1-30 and
    // confirm the tick follows the override, not the built-in default.
    const playlist = makePlaylist({
      status: 'pending_review',
      config: {
        presetKey: 'halloween',
        windowOverride: { startMonth: 11, startDay: 1, endMonth: 11, endDay: 30 },
      },
    })
    const generatePlaylist = vi.fn().mockResolvedValue(undefined)

    await tickSeasonalPlaylists({
      getEnabledSeasonalPlaylists: async () => [playlist],
      generatePlaylist,
      tearDownPlaylist: vi.fn().mockResolvedValue(undefined),
      now: HALLOWEEN_OUT_OF_WINDOW,
    })

    expect(generatePlaylist).toHaveBeenCalledWith(1)
  })
})
