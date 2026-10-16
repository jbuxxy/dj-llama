// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { consumeQueryFlag, usesSameTabPlexSignIn } from '@/web/lib/plex-same-tab'

describe('plex same-tab helpers', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    window.history.replaceState({}, '', '/')
  })

  it('keeps the popup flow in a regular, unframed browser', () => {
    expect(usesSameTabPlexSignIn()).toBe(false)
  })

  it('uses the same tab in the Tesla browser', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (X11; GNU/Linux) AppleWebKit/537.36 Chrome/124.0 Safari/537.36 Tesla/2025.32',
    )
    expect(usesSameTabPlexSignIn()).toBe(true)
  })

  it('uses the same tab when framed by another page', () => {
    vi.spyOn(window, 'top', 'get').mockReturnValue({} as Window)
    expect(usesSameTabPlexSignIn()).toBe(true)
  })

  it('consumes a one-shot return marker and keeps other query params', () => {
    window.history.replaceState({}, '', '/settings?tab=connections&plexReconfigureReturn=1')
    expect(consumeQueryFlag('plexReconfigureReturn')).toBe(true)
    expect(window.location.pathname + window.location.search).toBe('/settings?tab=connections')
    expect(consumeQueryFlag('plexReconfigureReturn')).toBe(false)
  })
})
