// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { STRATEGY_POLICIES, strategyPolicy } from '@/core/playlists/policy'

describe('strategy policies', () => {
  it('keeps each lifecycle distinct', () => {
    expect(STRATEGY_POLICIES.ai_prompt.autoPush).toBe('never')
    expect(STRATEGY_POLICIES.seasonal.autoPush).toBe('seasonal-window')
    expect(STRATEGY_POLICIES.weekly_digest.autoPush).toBe('always')
    expect(STRATEGY_POLICIES.daily_mix.ownedTracksOnly).toBe(true)
  })

  it('only lets curated strategies expire unreviewed', () => {
    const expiring = Object.entries(STRATEGY_POLICIES)
      .filter(([, p]) => p.reviewExpires && p.generation === 'strategy')
      .map(([s]) => s)
      .sort()
    expect(expiring).toEqual(['genre_focus', 'mood_mix', 'rediscover', 'weekly_digest'])
  })

  it('treats unknown strategies as custom playlists', () => {
    expect(strategyPolicy('something_new').section).toBe('custom')
  })
})
