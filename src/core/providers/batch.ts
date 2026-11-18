// "Cheaper mode" for scheduled scans: the provider's batch API at about half
// price, behind the ordinary getRecommendations() interface. Each call
// submits a one-request batch and polls until it lands, so the pipeline code
// doesn't change shape. A scheduled scan has no one waiting on it; an
// interactive caller never gets this wrapper.
//
// While any call is waiting, onWaitingChange(true) fires (the orchestrator
// parks its job as 'waiting_ai' so the stuck detector leaves it alone).
// Batch failure, expiry, or a wait past maxWaitMs falls back to a normal
// call, so cheaper mode can only ever be slower, never broken. A restart
// mid-wait abandons the batch (the run is marked interrupted like any other
// job; the abandoned batch costs a fraction of a cent).

import type { AiRecommendation, TasteProfile } from '@/core/types'
import type { AiUsage, RecommendationProvider } from './types'

export type BatchOptions = {
  pollMs?: number
  maxWaitMs?: number
  onWaitingChange?: (waiting: boolean) => void
}

const DEFAULT_POLL_MS = 60_000
// Providers target 24h; past that a scheduled scan is better off paying full price.
const DEFAULT_MAX_WAIT_MS = 24 * 60 * 60 * 1000

export function supportsBatch(p: RecommendationProvider): boolean {
  return typeof p.submitBatch === 'function' && typeof p.getBatch === 'function'
}

export class BatchingProvider implements RecommendationProvider {
  lastUsage: AiUsage | null = null
  private waiting = 0
  private seq = 0

  constructor(
    private readonly inner: RecommendationProvider,
    private readonly opts: BatchOptions = {},
  ) {}

  async getRecommendations(profile: TasteProfile): Promise<AiRecommendation[]> {
    this.lastUsage = null
    const submit = this.inner.submitBatch
    const poll = this.inner.getBatch
    if (!submit || !poll) return this.direct(profile)
    const key = `r${++this.seq}`
    let batchId: string
    try {
      batchId = await submit.call(this.inner, [{ key, profile }])
    } catch (err) {
      const msg = errText(err)
      // Gemini refuses batch jobs from keys without billing (free tier) with
      // FAILED_PRECONDITION; say so instead of a bare error.
      const hint = /precondition/i.test(msg)
        ? ' (the provider refused batch jobs for this API key; Gemini needs a billing-enabled key)'
        : ''
      console.warn(`[ai-batch] submit failed${hint}, using a normal call:`, msg)
      return this.direct(profile)
    }
    this.setWaiting(+1)
    try {
      const deadline = Date.now() + (this.opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS)
      while (Date.now() < deadline) {
        await sleep(this.opts.pollMs ?? DEFAULT_POLL_MS)
        let status: Awaited<ReturnType<NonNullable<RecommendationProvider['getBatch']>>>
        try {
          status = await poll.call(this.inner, batchId)
        } catch (err) {
          // A failed poll is usually transient; keep waiting.
          console.warn('[ai-batch] poll failed:', errText(err))
          continue
        }
        if (status.state === 'pending' || status.state === 'running') continue
        if (status.state !== 'succeeded') break
        const result = status.results?.get(key)
        if (!result || 'error' in result) {
          console.warn(
            '[ai-batch] request failed in batch:',
            result && 'error' in result ? result.error : 'missing',
          )
          break
        }
        this.lastUsage = result.usage ? { ...result.usage, batch: true } : null
        return result.recs
      }
      console.warn(`[ai-batch] batch ${batchId} did not complete, using a normal call`)
    } finally {
      this.setWaiting(-1)
    }
    return this.direct(profile)
  }

  async testConnection() {
    return this.inner.testConnection()
  }

  private async direct(profile: TasteProfile) {
    const recs = await this.inner.getRecommendations(profile)
    this.lastUsage = this.inner.lastUsage ?? null
    return recs
  }

  private setWaiting(delta: number) {
    const before = this.waiting > 0
    this.waiting += delta
    const after = this.waiting > 0
    if (before !== after) this.opts.onWaitingChange?.(after)
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err))
