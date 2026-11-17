// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMusicBrainzClient, runInteractive } from '@/core/clients/musicbrainz'

describe('MusicBrainz priority lanes', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('serves an interactive lookup before already-queued background ones', async () => {
    const order: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        order.push(String(url).includes('interactive') ? 'interactive' : 'background')
        return new Response(JSON.stringify({ artists: [] }), { status: 200 })
      }),
    )
    const mb = createMusicBrainzClient()
    const background = [1, 2, 3].map((i) => mb.searchArtist(`background-${i}`))
    // Queued after all three background requests, but should run second
    // (the first background request already holds the slot).
    const interactive = runInteractive(() => mb.searchArtist('interactive'))
    await interactive
    await Promise.all(background)
    expect(order.indexOf('interactive')).toBeLessThanOrEqual(1)
  }, 15_000)
})
