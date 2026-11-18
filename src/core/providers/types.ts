import type { AiRecommendation, TasteProfile } from '@/core/types'

// Per-request token accounting surfaced by providers. Providers that do not
// return usage (e.g. OpenAI-compatible endpoints without token reporting)
// leave this undefined. Persisted to `job_runs.metadata` as `aiUsage`.
export type AiUsage = {
  provider: string
  model: string
  inputTokens?: number
  outputTokens?: number
  /** Anthropic-specific: tokens read from the prompt cache. */
  cacheReadInputTokens?: number
  /** Anthropic-specific: tokens written to the prompt cache. */
  cacheCreationInputTokens?: number
  /** Served through the provider's batch API (half price). */
  batch?: boolean
}

export type BatchState = 'pending' | 'running' | 'succeeded' | 'failed' | 'expired' | 'cancelled'

export type BatchStatus = {
  state: BatchState
  /** Present once state is 'succeeded': per request key, the parsed result or why it failed. */
  results?: Map<string, { recs: AiRecommendation[]; usage: AiUsage | null } | { error: string }>
}

export interface RecommendationProvider {
  getRecommendations(profile: TasteProfile): Promise<AiRecommendation[]>
  /**
   * Same request as getRecommendations, but streamed: `onRecommendation`
   * fires for each recommendation as soon as the model has finished writing
   * it. Resolves with the complete, authoritative list. Optional -- callers
   * fall back to getRecommendations for providers without it.
   */
  streamRecommendations?(
    profile: TasteProfile,
    onRecommendation: (rec: AiRecommendation) => void,
  ): Promise<AiRecommendation[]>
  testConnection(): Promise<{ success: boolean; message: string }>
  /**
   * Embeds each text into a vector (same length for every text from one
   * provider/model). Optional -- only providers with an embeddings API have it.
   */
  embed?(texts: string[]): Promise<number[][]>
  /**
   * Batch API (about half price, results in minutes to hours). Optional --
   * see core/providers/batch.ts, which turns these into an ordinary
   * getRecommendations for scheduled scans.
   */
  submitBatch?(requests: Array<{ key: string; profile: TasteProfile }>): Promise<string>
  getBatch?(batchId: string): Promise<BatchStatus>
  /**
   * Usage reported by the most recent `getRecommendations` call, or null if
   * the call never ran or the provider does not surface usage. Read after a
   * successful call; providers reset this on each invocation.
   */
  readonly lastUsage?: AiUsage | null
}
