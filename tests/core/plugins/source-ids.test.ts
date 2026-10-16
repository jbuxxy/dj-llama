import { describe, expect, it } from 'vitest'
import { createPlexSource } from '@/core/plugins/plex'
import { LISTENING_SOURCE_IDS } from '@/core/plugins/registry'

describe('LISTENING_SOURCE_IDS', () => {
  it('every registrable source id appears in LISTENING_SOURCE_IDS', () => {
    const sources = [createPlexSource('http://x', 't', undefined)]
    expect(new Set(sources.map((s) => s.id))).toEqual(new Set(LISTENING_SOURCE_IDS))
  })
})
