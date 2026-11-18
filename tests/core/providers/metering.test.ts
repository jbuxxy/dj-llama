import { describe, expect, it, vi } from 'vitest'
import { AiBudgetExceededError, createBudgetGuard } from '@/core/providers/budget'
import { MeteredProvider, normalizeUsage, type UsageRecord } from '@/core/providers/metered'
import { estimateCostUsd, priceFor } from '@/core/providers/pricing'
import { AiProviderRegistry } from '@/core/providers/registry'
import type { AiUsage, RecommendationProvider } from '@/core/providers/types'

const PROFILE = {
  topArtists: [],
  topGenres: [],
  listeningPatterns: { totalListens: 0, recentTrend: 'stable' as const },
}

// A provider whose calls finish in the order their delays say, each setting
// lastUsage to its own token count right before returning -- like the real ones.
function fakeProvider(): RecommendationProvider & { lastUsage: AiUsage | null } {
  const p = {
    lastUsage: null as AiUsage | null,
    async getRecommendations(profile: { _rawPrompt?: string }) {
      const tokens = Number(profile._rawPrompt)
      await new Promise((r) => setTimeout(r, tokens / 10))
      p.lastUsage = {
        provider: 'gemini',
        model: 'gemini-3-flash-preview',
        inputTokens: tokens,
        outputTokens: 10,
      }
      return []
    },
    async testConnection() {
      return { success: true, message: 'ok' }
    },
  }
  return p
}

describe('MeteredProvider', () => {
  it('records each concurrent call with its own usage and totals them', async () => {
    const records: UsageRecord[] = []
    const inner = fakeProvider()
    const metered = new MeteredProvider(inner, { feature: 'pipeline_artists', userId: 1 }, (r) => {
      records.push(r)
    })
    const tracks = metered.withFeature('pipeline_tracks')
    await Promise.all([
      metered.getRecommendations({ ...PROFILE, _rawPrompt: '300' }),
      tracks.getRecommendations({ ...PROFILE, _rawPrompt: '100' }),
    ])
    expect(records.map((r) => [r.feature, r.inputTokens]).sort()).toEqual([
      ['pipeline_artists', 300],
      ['pipeline_tracks', 100],
    ])
    expect(metered.lastUsage?.inputTokens).toBe(300)
    expect(tracks.lastUsage?.inputTokens).toBe(100)
  })

  it('never lets a failing recorder break the call', async () => {
    const metered = new MeteredProvider(fakeProvider(), { feature: 'mood' }, () => {
      throw new Error('db down')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(metered.getRecommendations({ ...PROFILE, _rawPrompt: '5' })).resolves.toEqual([])
    warn.mockRestore()
  })

  it('folds Anthropic cache tokens into input', () => {
    expect(
      normalizeUsage({
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: 900,
        cacheCreationInputTokens: 0,
      }),
    ).toEqual({ inputTokens: 1000, outputTokens: 50, cachedTokens: 900 })
  })
})

describe('pricing', () => {
  it('matches dated ids by longest prefix and honors overrides', () => {
    expect(priceFor('anthropic', 'claude-haiku-4-5-20251001')?.input).toBe(1)
    expect(priceFor('gemini', 'gemini-2.5-flash-lite')?.input).toBe(0.1)
    expect(priceFor('gemini', 'gemini-2.5-flash')?.input).toBe(0.3)
    expect(priceFor('openai', 'some-unknown-model')).toBeNull()
    expect(priceFor('ollama', 'llama3')).toEqual({ input: 0, output: 0 })
    expect(
      priceFor('gemini', 'gemini-3-flash-preview', { 'gemini-3-flash': { input: 9, output: 9 } })
        ?.input,
    ).toBe(9)
  })

  it('prices cached input at the cache rate and halves batch calls', () => {
    const price = { input: 1, output: 5, cachedInput: 0.1 }
    // 1M input of which 900k cached + 100k output.
    const full = estimateCostUsd(price, { input: 1_000_000, cached: 900_000, output: 100_000 })
    expect(full).toBeCloseTo(0.1 + 0.09 + 0.5)
    expect(estimateCostUsd(price, { input: 1_000_000, output: 0 }, true)).toBeCloseTo(0.5)
    expect(estimateCostUsd(null, { input: 10 })).toBeNull()
  })
})

describe('budget', () => {
  it('refuses metered creation once the month is spent, but not unmetered', async () => {
    const guard = createBudgetGuard(async () => ({ spentUsd: 12, budgetUsd: 10 }))
    const registry = new AiProviderRegistry()
    registry.register({ id: 'fake', name: 'Fake', create: () => fakeProvider() })
    registry.setUsageRecorder(() => {})
    registry.setBudgetCheck(() => guard.check())
    await expect(
      registry.create('fake', { apiKey: null, model: 'm' }, { feature: 'mood' }),
    ).rejects.toBeInstanceOf(AiBudgetExceededError)
    // Connection tests and other unmetered creates still work.
    await expect(registry.create('fake', { apiKey: null, model: 'm' })).resolves.toBeDefined()
  })

  it('no budget means no limit', async () => {
    const guard = createBudgetGuard(async () => ({ spentUsd: 1000, budgetUsd: null }))
    await expect(guard.check()).resolves.toBeUndefined()
  })
})
