// Wraps a provider so every call records its own usage row (ai_usage), with
// cost estimated from core/providers/pricing.ts. Usage is read off the inner
// provider immediately after each call resolves: providers set lastUsage
// right before returning, and only microtasks run between that and this
// wrapper's continuation, so concurrent calls on one instance can't swap
// each other's numbers (the old single `lastUsage` read at the end of a run
// could, and dropped every call but the last).
//
// The wrapper's own `lastUsage` is the running total across its calls --
// what a job's metadata.aiUsage should show.

import type { AiFeature } from '@/db/schema'
import type { AiUsage, RecommendationProvider } from './types'

export type UsageContext = {
  feature: AiFeature
  userId?: number | null
  jobRunId?: number | null
}

export type UsageRecord = UsageContext & {
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  batch: boolean
}

export type UsageRecorder = (record: UsageRecord) => void | Promise<void>

/** Token counts normalized so inputTokens always includes cached input. */
export function normalizeUsage(u: AiUsage): {
  inputTokens: number
  outputTokens: number
  cachedTokens: number
} {
  // Anthropic reports cache reads/writes separately from input_tokens;
  // Gemini and OpenAI fold cached tokens into the prompt count.
  const cacheRead = u.cacheReadInputTokens ?? 0
  const cacheWrite = u.cacheCreationInputTokens ?? 0
  return {
    inputTokens: (u.inputTokens ?? 0) + cacheRead + cacheWrite,
    outputTokens: u.outputTokens ?? 0,
    cachedTokens: cacheRead,
  }
}

export class MeteredProvider implements RecommendationProvider {
  private total: AiUsage | null = null

  constructor(
    private readonly inner: RecommendationProvider,
    private readonly ctx: UsageContext,
    private readonly record: UsageRecorder,
  ) {
    if (inner.streamRecommendations) {
      this.streamRecommendations = async (profile, onRec) => {
        const out = await (
          inner.streamRecommendations as NonNullable<
            RecommendationProvider['streamRecommendations']
          >
        )(profile, onRec)
        this.capture()
        return out
      }
    }
    if (inner.embed) {
      this.embed = async (texts) => {
        const out = await (inner.embed as NonNullable<RecommendationProvider['embed']>)(texts)
        this.capture('embedding')
        return out
      }
    }
  }

  streamRecommendations?: RecommendationProvider['streamRecommendations']
  embed?: RecommendationProvider['embed']

  get lastUsage(): AiUsage | null {
    return this.total
  }

  async getRecommendations(profile: Parameters<RecommendationProvider['getRecommendations']>[0]) {
    const out = await this.inner.getRecommendations(profile)
    this.capture()
    return out
  }

  testConnection() {
    return this.inner.testConnection()
  }

  /** Same provider and recorder, recording under a different feature. */
  withFeature(feature: AiFeature): MeteredProvider {
    return new MeteredProvider(this.inner, { ...this.ctx, feature }, this.record)
  }

  private capture(feature?: AiFeature) {
    const u = this.inner.lastUsage
    if (!u) return
    this.total = this.total
      ? {
          provider: u.provider,
          model: u.model,
          inputTokens: (this.total.inputTokens ?? 0) + (u.inputTokens ?? 0),
          outputTokens: (this.total.outputTokens ?? 0) + (u.outputTokens ?? 0),
          cacheReadInputTokens:
            (this.total.cacheReadInputTokens ?? 0) + (u.cacheReadInputTokens ?? 0),
          cacheCreationInputTokens:
            (this.total.cacheCreationInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0),
        }
      : { ...u }
    try {
      const pending = this.record({
        ...this.ctx,
        ...(feature ? { feature } : {}),
        provider: u.provider,
        model: u.model,
        ...normalizeUsage(u),
        batch: u.batch ?? false,
      })
      if (pending) void Promise.resolve(pending).catch((err) => warn(err))
    } catch (err) {
      warn(err)
    }
  }
}

function warn(err: unknown) {
  console.warn('[ai-usage] failed to record usage:', err instanceof Error ? err.message : err)
}

/** Adds two usage totals (either may be missing); null when both are. */
export function sumUsage(
  a: AiUsage | null | undefined,
  b: AiUsage | null | undefined,
): AiUsage | null {
  if (!a) return b ?? null
  if (!b) return a
  return {
    provider: a.provider,
    model: a.model,
    inputTokens: (a.inputTokens ?? 0) + (b.inputTokens ?? 0),
    outputTokens: (a.outputTokens ?? 0) + (b.outputTokens ?? 0),
    cacheReadInputTokens: (a.cacheReadInputTokens ?? 0) + (b.cacheReadInputTokens ?? 0),
    cacheCreationInputTokens: (a.cacheCreationInputTokens ?? 0) + (b.cacheCreationInputTokens ?? 0),
  }
}
