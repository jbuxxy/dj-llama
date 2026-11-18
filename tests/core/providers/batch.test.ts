import { describe, expect, it, vi } from 'vitest'
import { BatchingProvider, supportsBatch } from '@/core/providers/batch'
import { AiProviderRegistry } from '@/core/providers/registry'
import type { BatchStatus, RecommendationProvider } from '@/core/providers/types'
import type { AiRecommendation } from '@/core/types'

const PROFILE = {
  topArtists: [],
  topGenres: [],
  listeningPatterns: { totalListens: 0, recentTrend: 'stable' as const },
}
const REC: AiRecommendation = { artistName: 'Grouper', reasoning: 'r', confidence: 0.9, genres: [] }
const DIRECT: AiRecommendation = {
  artistName: 'Direct',
  reasoning: 'r',
  confidence: 0.5,
  genres: [],
}

function provider(states: Array<BatchStatus['state']>, opts: { submitFails?: boolean } = {}) {
  let polls = 0
  let submittedKey = ''
  const p: RecommendationProvider & { lastUsage: unknown } = {
    lastUsage: null,
    getRecommendations: vi.fn(async () => {
      p.lastUsage = { provider: 'gemini', model: 'm', inputTokens: 10, outputTokens: 1 }
      return [DIRECT]
    }),
    testConnection: async () => ({ success: true, message: 'ok' }),
    submitBatch: vi.fn(async (reqs) => {
      if (opts.submitFails) throw new Error('nope')
      submittedKey = reqs[0]?.key ?? ''
      return 'batches/1'
    }),
    getBatch: vi.fn(async () => {
      const state = states[Math.min(polls++, states.length - 1)] ?? 'pending'
      if (state !== 'succeeded') return { state }
      return {
        state,
        results: new Map([
          [
            submittedKey,
            { recs: [REC], usage: { provider: 'gemini', model: 'm', inputTokens: 100 } },
          ],
        ]),
      }
    }),
  }
  return p
}

describe('BatchingProvider', () => {
  it('waits for the batch, returns its result and marks usage as batch', async () => {
    const inner = provider(['pending', 'running', 'succeeded'])
    const waiting = vi.fn()
    const p = new BatchingProvider(inner, { pollMs: 0, onWaitingChange: waiting })
    expect(await p.getRecommendations(PROFILE)).toEqual([REC])
    expect(p.lastUsage).toMatchObject({ inputTokens: 100, batch: true })
    expect(inner.getRecommendations).not.toHaveBeenCalled()
    expect(waiting.mock.calls).toEqual([[true], [false]])
  })

  it('falls back to a normal call when the batch fails or expires', async () => {
    for (const state of ['failed', 'expired', 'cancelled'] as const) {
      const inner = provider([state])
      const p = new BatchingProvider(inner, { pollMs: 0 })
      expect(await p.getRecommendations(PROFILE)).toEqual([DIRECT])
      expect(p.lastUsage).toMatchObject({ inputTokens: 10 })
    }
  })

  it('falls back when submission fails or the wait runs out', async () => {
    expect(
      await new BatchingProvider(provider(['succeeded'], { submitFails: true }), {
        pollMs: 0,
      }).getRecommendations(PROFILE),
    ).toEqual([DIRECT])
    expect(
      await new BatchingProvider(provider(['pending']), {
        pollMs: 1,
        maxWaitMs: 5,
      }).getRecommendations(PROFILE),
    ).toEqual([DIRECT])
  })

  it('reports waiting once across overlapping calls', async () => {
    const inner = provider(['running', 'succeeded'])
    const waiting = vi.fn()
    const p = new BatchingProvider(inner, { pollMs: 0, onWaitingChange: waiting })
    await Promise.all([p.getRecommendations(PROFILE), p.getRecommendations(PROFILE)])
    expect(waiting.mock.calls.filter(([w]) => w)).toHaveLength(1)
  })

  it('the registry only wraps providers that have a batch API, and only when asked', async () => {
    const registry = new AiProviderRegistry()
    registry.register({ id: 'b', name: 'B', create: () => provider(['succeeded']) })
    registry.register({
      id: 'plain',
      name: 'Plain',
      create: () => ({
        getRecommendations: async () => [],
        testConnection: async () => ({ success: true, message: '' }),
      }),
    })
    expect(await registry.create('b', { apiKey: null, model: 'm' }, undefined, {})).toBeInstanceOf(
      BatchingProvider,
    )
    expect(await registry.create('b', { apiKey: null, model: 'm' })).not.toBeInstanceOf(
      BatchingProvider,
    )
    const plain = await registry.create('plain', { apiKey: null, model: 'm' }, undefined, {})
    expect(plain).not.toBeInstanceOf(BatchingProvider)
    expect(supportsBatch(plain)).toBe(false)
  })
})
