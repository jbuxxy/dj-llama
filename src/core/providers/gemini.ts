import type { AiRecommendation, TasteProfile } from '@/core/types'
import { errMsg } from '@/core/validation'
import {
  buildRecommendationPrompt,
  getAiRecommendationsJsonSchema,
  parseRecommendationResponse,
} from './prompt'
import { readLines } from './read-lines'
import { fetchWithRetry } from './retry'
import { RecommendationStreamParser } from './stream-parse'
import { timeoutSecondsWithDefaultToMs, withTimeout } from './timeout'
import type { AiUsage, BatchStatus, RecommendationProvider } from './types'

const DEFAULT_MODEL = 'gemini-3-flash-preview'
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'
const DEFAULT_TIMEOUT_SECONDS = 60
const EMBEDDING_MODEL = 'gemini-embedding-001'
const EMBEDDING_DIMENSIONS = 256
// batchEmbedContents accepts up to 100 requests per call.
const EMBED_BATCH = 50

// Gemini's responseSchema is a subset of JSON Schema and rejects fields like
// `$schema`, `additionalProperties`, `exclusiveMinimum`, etc. Strip the ones
// that are known to cause 400s while keeping the shape-defining fields.
// Numeric/length bounds (maxLength, maxItems, minimum, ...) are dropped too:
// Gemini's constrained decoder compiles these into a state machine, and
// combined with this schema's nesting it reliably fails with "the specified
// schema produces a constraint that has too many states for serving" --
// reproduced even on a trivial one-line prompt with these bounds present,
// and confirmed fixed by removing them. Safe to drop because
// validateAiRecommendations (Zod) re-enforces every one of these bounds
// after parsing regardless of what was sent as responseSchema.
const GEMINI_DROP_KEYS = new Set([
  '$schema',
  '$id',
  'additionalProperties',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'default',
  'const',
  'examples',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'minimum',
  'maximum',
])
function sanitizeGeminiSchema(input: unknown): unknown {
  if (Array.isArray(input)) return input.map((v) => sanitizeGeminiSchema(v))
  if (input && typeof input === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(input)) {
      if (GEMINI_DROP_KEYS.has(k)) continue
      out[k] = sanitizeGeminiSchema(v)
    }
    return out
  }
  return input
}

type GeminiResponse = {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
}

export class GeminiProvider implements RecommendationProvider {
  private apiKey: string
  private model: string
  private timeoutMs: number
  lastUsage: AiUsage | null = null

  constructor(apiKey: string, model: string = DEFAULT_MODEL, timeoutSeconds?: number | null) {
    this.apiKey = apiKey
    this.model = model
    this.timeoutMs = timeoutSecondsWithDefaultToMs(timeoutSeconds, DEFAULT_TIMEOUT_SECONDS)
  }

  private requestBody(profile: TasteProfile): string {
    return JSON.stringify({
      contents: [{ parts: [{ text: buildRecommendationPrompt(profile) }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: sanitizeGeminiSchema(getAiRecommendationsJsonSchema()),
        maxOutputTokens: 4096,
        // 2.5-series models spend part of maxOutputTokens on invisible
        // "thinking" before writing the response text, which can
        // consume the entire budget on a long prompt (many candidate
        // artists) and truncate the JSON before it's ever emitted.
        // This is a plain structured-extraction task with no need for
        // multi-step reasoning, so thinking is disabled outright.
        thinkingConfig: { thinkingBudget: 0 },
      },
    })
  }

  private recordUsage(usage?: { promptTokenCount?: number; candidatesTokenCount?: number }) {
    if (!usage) return
    this.lastUsage = {
      provider: 'gemini',
      model: this.model,
      inputTokens: usage.promptTokenCount,
      outputTokens: usage.candidatesTokenCount,
    }
  }

  /**
   * Artist-similarity embeddings via gemini-embedding-001, truncated to
   * EMBEDDING_DIMENSIONS (Matryoshka -- the leading dimensions carry the most
   * signal). The API returns no token count; usage is estimated at ~4 chars
   * per token so the cost dashboard still sees it.
   */
  async embed(texts: string[]): Promise<number[][]> {
    this.lastUsage = null
    const out: number[][] = []
    for (let i = 0; i < texts.length; i += EMBED_BATCH) {
      const chunk = texts.slice(i, i + EMBED_BATCH)
      const vectors = await withTimeout(
        this.timeoutMs,
        'Gemini embedding request',
        async (signal) => {
          const res = await fetchWithRetry(
            `${API_BASE}/${EMBEDDING_MODEL}:batchEmbedContents`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
              body: JSON.stringify({
                requests: chunk.map((text) => ({
                  model: `models/${EMBEDDING_MODEL}`,
                  content: { parts: [{ text }] },
                  taskType: 'SEMANTIC_SIMILARITY',
                  outputDimensionality: EMBEDDING_DIMENSIONS,
                })),
              }),
              signal,
            },
            { providerLabel: 'gemini' },
          )
          const data = (await res.json()) as { embeddings?: Array<{ values?: number[] }> }
          return (data.embeddings ?? []).map((e) => e.values ?? [])
        },
      )
      if (vectors.length !== chunk.length)
        throw new Error('Gemini returned the wrong number of embeddings')
      out.push(...vectors)
    }
    this.lastUsage = {
      provider: 'gemini',
      model: EMBEDDING_MODEL,
      inputTokens: Math.ceil(texts.reduce((n, t) => n + t.length, 0) / 4),
      outputTokens: 0,
    }
    return out
  }

  /**
   * Gemini Batch Mode, inline requests. Google's docs show the state and the
   * results under two different paths (`state`/`metadata.state`,
   * `dest.inlinedResponses`/`response.inlinedResponses`), so both are read.
   */
  async submitBatch(requests: Array<{ key: string; profile: TasteProfile }>): Promise<string> {
    const res = await fetchWithRetry(
      `${API_BASE}/${this.model}:batchGenerateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
        body: JSON.stringify({
          batch: {
            display_name: `djllama-${Date.now()}`,
            input_config: {
              requests: {
                requests: requests.map((r) => ({
                  request: JSON.parse(this.requestBody(r.profile)),
                  metadata: { key: r.key },
                })),
              },
            },
          },
        }),
      },
      { providerLabel: 'gemini' },
    )
    const data = (await res.json()) as { name?: string }
    if (!data.name) throw new Error('Gemini did not return a batch name')
    return data.name
  }

  async getBatch(batchId: string): Promise<BatchStatus> {
    const res = await fetchWithRetry(
      `https://generativelanguage.googleapis.com/v1beta/${batchId}`,
      { headers: { 'x-goog-api-key': this.apiKey } },
      { providerLabel: 'gemini' },
    )
    type Inlined = {
      response?: GeminiResponse
      error?: { message?: string }
      metadata?: { key?: string }
    }
    type BatchBody = {
      state?: string
      metadata?: {
        state?: string
        output?: { inlinedResponses?: { inlinedResponses?: Inlined[] } }
      }
      dest?: { inlinedResponses?: Inlined[] | { inlinedResponses?: Inlined[] } }
      response?: { inlinedResponses?: Inlined[] | { inlinedResponses?: Inlined[] } }
    }
    const data = (await res.json()) as BatchBody
    const rawState = data.state ?? data.metadata?.state ?? ''
    const state = geminiBatchState(rawState)
    if (state !== 'succeeded') return { state }
    const container =
      data.dest?.inlinedResponses ??
      data.response?.inlinedResponses ??
      data.metadata?.output?.inlinedResponses
    const list: Inlined[] = Array.isArray(container)
      ? container
      : (container?.inlinedResponses ?? [])
    const results: NonNullable<BatchStatus['results']> = new Map()
    list.forEach((item, i) => {
      const key = item.metadata?.key ?? String(i)
      if (item.error || !item.response) {
        results.set(key, { error: item.error?.message ?? 'no response' })
        return
      }
      const text = item.response.candidates?.[0]?.content?.parts?.[0]?.text
      if (!text) {
        results.set(key, { error: 'empty response' })
        return
      }
      try {
        const usage = item.response.usageMetadata
        results.set(key, {
          recs: parseRecommendationResponse(text),
          usage: usage
            ? {
                provider: 'gemini',
                model: this.model,
                inputTokens: usage.promptTokenCount,
                outputTokens: usage.candidatesTokenCount,
                batch: true,
              }
            : null,
        })
      } catch (err) {
        results.set(key, { error: errMsg(err) })
      }
    })
    return { state, results }
  }

  async getRecommendations(profile: TasteProfile): Promise<AiRecommendation[]> {
    this.lastUsage = null

    return withTimeout(this.timeoutMs, 'Gemini recommendation request', async (signal) => {
      const res = await fetchWithRetry(
        `${API_BASE}/${this.model}:generateContent`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': this.apiKey,
          },
          body: this.requestBody(profile),
          signal: signal,
        },
        { providerLabel: 'gemini' },
      )

      const data = (await res.json()) as GeminiResponse
      this.recordUsage(data.usageMetadata)
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text
      if (!text) throw new Error('Empty response from Gemini')

      // responseSchema does not guarantee well-formed output (truncation at
      // maxOutputTokens); the shared parser fails with a clear message instead.
      return parseRecommendationResponse(text)
    })
  }

  async streamRecommendations(
    profile: TasteProfile,
    onRecommendation: (rec: AiRecommendation) => void,
  ): Promise<AiRecommendation[]> {
    this.lastUsage = null
    const parser = new RecommendationStreamParser(onRecommendation)
    return withTimeout(this.timeoutMs, 'Gemini recommendation request', async (signal) => {
      const res = await fetchWithRetry(
        `${API_BASE}/${this.model}:streamGenerateContent?alt=sse`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': this.apiKey,
          },
          body: this.requestBody(profile),
          signal: signal,
        },
        { providerLabel: 'gemini' },
      )
      if (!res.body) throw new Error('Empty response from Gemini')
      let content = ''
      for await (const line of readLines(res.body)) {
        if (!line.startsWith('data:')) continue
        try {
          const chunk = JSON.parse(line.slice(5).trim()) as GeminiResponse
          const delta =
            chunk.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? ''
          content += delta
          parser.push(delta)
          this.recordUsage(chunk.usageMetadata)
        } catch {
          // partial / keep-alive frame
        }
      }
      if (!content) throw new Error('Empty response from Gemini')
      return parseRecommendationResponse(content)
    })
  }

  async testConnection(): Promise<{ success: boolean; message: string }> {
    try {
      return await withTimeout(10_000, 'Gemini connection test', async (signal) => {
        const res = await fetch(`${API_BASE}/${this.model}:generateContent`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': this.apiKey,
          },
          body: JSON.stringify({
            contents: [{ parts: [{ text: 'ping' }] }],
            generationConfig: { maxOutputTokens: 10 },
          }),
          signal: signal,
        })

        if (res.ok) {
          return { success: true, message: `Connected to Gemini (${this.model})` }
        }
        const body = await res.text().catch(() => '')
        return { success: false, message: body || `HTTP ${res.status}` }
      })
    } catch (err: unknown) {
      return {
        success: false,
        message: errMsg(err),
      }
    }
  }
}

function geminiBatchState(raw: string): BatchStatus['state'] {
  // JOB_STATE_* in current docs, BATCH_STATE_* in older ones.
  const s = raw.replace(/^(JOB|BATCH)_STATE_/, '')
  switch (s) {
    case 'SUCCEEDED':
      return 'succeeded'
    case 'FAILED':
      return 'failed'
    case 'CANCELLED':
      return 'cancelled'
    case 'EXPIRED':
      return 'expired'
    case 'RUNNING':
      return 'running'
    default:
      return 'pending'
  }
}
