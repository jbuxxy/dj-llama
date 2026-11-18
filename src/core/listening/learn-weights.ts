// Fits scoring weights to what a user actually kept listening to. Each
// acted-on recommendation already stores its per-component scores in
// `recommendations.sources`, so the training data is just (components,
// how it turned out). The score is a clamped weighted sum, so the fit is
// non-negative least squares: projected gradient descent, then normalized so
// the weights sum to 1 like the manual ones. Shrunk toward the user's manual
// weights until there's enough data to trust it.

import type { ScoringWeights } from '@/db/schema'

export const WEIGHT_KEYS = [
  'consensus',
  'similarity',
  'genreOverlap',
  'aiConfidence',
  'feedbackBoost',
  'popularity',
  'semantic',
] as const satisfies ReadonlyArray<keyof ScoringWeights>

export type TrainingSample = {
  components: Partial<Record<keyof ScoringWeights, number>>
  /** 1 = keeper, 0.5 = tried, 0 = never played or rejected. */
  target: number
}

/** Below this many samples there's no learned weighting at all. */
export const MIN_SAMPLES = 20
// Shrinkage: the learned weights get n/(n+PRIOR_STRENGTH) of the say.
const PRIOR_STRENGTH = 50
const ITERATIONS = 2000
const LEARNING_RATE = 0.5

export function fitWeights(samples: TrainingSample[]): ScoringWeights | null {
  if (samples.length < MIN_SAMPLES) return null
  const xs = samples.map((s) => WEIGHT_KEYS.map((k) => clamp01(s.components[k] ?? 0)))
  const ys = samples.map((s) => s.target)
  const dims = WEIGHT_KEYS.length
  // Intercept absorbs the base rate, so the weights only explain the spread.
  let w = new Array<number>(dims).fill(1 / dims)
  let b = 0
  const n = samples.length
  for (let it = 0; it < ITERATIONS; it++) {
    const grad = new Array<number>(dims).fill(0)
    let gradB = 0
    for (let i = 0; i < n; i++) {
      const x = xs[i] as number[]
      let pred = b
      for (let d = 0; d < dims; d++) pred += (w[d] as number) * (x[d] as number)
      const err = pred - (ys[i] as number)
      for (let d = 0; d < dims; d++) grad[d] = (grad[d] as number) + err * (x[d] as number)
      gradB += err
    }
    w = w.map((v, d) => Math.max(0, v - (LEARNING_RATE * (grad[d] as number)) / n))
    b -= (LEARNING_RATE * gradB) / n
  }
  const total = w.reduce((a, v) => a + v, 0)
  if (!(total > 0)) return null
  return toWeights(w.map((v) => v / total))
}

/** Blend learned weights toward the manual ones by sample count; result sums to 1. */
export function blendWeights(
  manual: ScoringWeights,
  learned: ScoringWeights,
  samples: number,
): ScoringWeights {
  const lambda = samples / (samples + PRIOR_STRENGTH)
  const manualTotal = WEIGHT_KEYS.reduce((a, k) => a + (manual[k] ?? 0), 0) || 1
  const mixed = WEIGHT_KEYS.map(
    (k) => (1 - lambda) * ((manual[k] ?? 0) / manualTotal) + lambda * (learned[k] ?? 0),
  )
  const total = mixed.reduce((a, v) => a + v, 0) || 1
  return toWeights(mixed.map((v) => v / total))
}

function toWeights(values: number[]): ScoringWeights {
  const out = {} as ScoringWeights
  WEIGHT_KEYS.forEach((k, i) => {
    out[k] = Math.round((values[i] ?? 0) * 1000) / 1000
  })
  return out
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0
}

/** The weights a scoring run should use: learned (blended) when the user opted in and has them. */
export function effectiveWeights(
  prefs: { scoringWeights: ScoringWeights; autoTuneWeights?: boolean },
  learned: { weights: ScoringWeights; samples: number } | null | undefined,
): ScoringWeights {
  if (!prefs.autoTuneWeights || !learned) return prefs.scoringWeights
  return blendWeights(prefs.scoringWeights, learned.weights, learned.samples)
}
