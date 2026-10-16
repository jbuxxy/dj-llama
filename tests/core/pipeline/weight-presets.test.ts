// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { resolveWeights, WEIGHT_PRESETS } from '@/core/pipeline/weight-presets'
import type { ScoringWeights } from '@/db/schema'

function sumWeights(w: ScoringWeights): number {
  return (
    w.consensus + w.similarity + w.genreOverlap + w.aiConfidence + w.feedbackBoost + w.popularity
  )
}

describe('WEIGHT_PRESETS', () => {
  it('default preset sums to 1.0', () => {
    expect(sumWeights(WEIGHT_PRESETS.default)).toBeCloseTo(1.0)
  })

  it('genre preset sums to 1.0', () => {
    expect(sumWeights(WEIGHT_PRESETS.genre)).toBeCloseTo(1.0)
  })
})

describe('resolveWeights()', () => {
  it('returns default preset for "default"', () => {
    expect(resolveWeights('default')).toEqual(WEIGHT_PRESETS.default)
  })

  it('returns genre preset for "genre"', () => {
    const result = resolveWeights('genre')
    expect(result).toEqual(WEIGHT_PRESETS.genre)
    expect(result.genreOverlap).toBe(WEIGHT_PRESETS.genre.genreOverlap)
  })

  it('falls back to default for unknown preset name', () => {
    expect(resolveWeights('nonexistent')).toEqual(WEIGHT_PRESETS.default)
  })

  it('applies a single override to the correct key', () => {
    const result = resolveWeights('default', { consensus: 0.5 })
    expect(result.consensus).toBe(0.5)
  })

  it('keeps other weights unchanged when applying an override', () => {
    const result = resolveWeights('default', { consensus: 0.5 })
    expect(result.similarity).toBe(WEIGHT_PRESETS.default.similarity)
    expect(result.genreOverlap).toBe(WEIGHT_PRESETS.default.genreOverlap)
    expect(result.aiConfidence).toBe(WEIGHT_PRESETS.default.aiConfidence)
    expect(result.feedbackBoost).toBe(WEIGHT_PRESETS.default.feedbackBoost)
  })

  it('ignores override keys that are not valid weight fields', () => {
    const result = resolveWeights('default', { consensus: 0.5, unknownKey: 0.99 })
    // unknownKey should not appear on the result
    expect((result as Record<string, unknown>).unknownKey).toBeUndefined()
  })

  it('returns base preset unchanged when overrides is null', () => {
    expect(resolveWeights('default', null)).toEqual(WEIGHT_PRESETS.default)
  })

  it('returns base preset unchanged when overrides is undefined', () => {
    expect(resolveWeights('default', undefined)).toEqual(WEIGHT_PRESETS.default)
  })
})
