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
import type { AiUsage, RecommendationProvider } from './types'

const DEFAULT_MODEL = 'gemini-3-flash-preview'
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'
const DEFAULT_TIMEOUT_SECONDS = 60

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
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10_000)
    try {
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
        signal: controller.signal,
      })

      if (res.ok) {
        return { success: true, message: `Connected to Gemini (${this.model})` }
      }
      const body = await res.text().catch(() => '')
      return { success: false, message: body || `HTTP ${res.status}` }
    } catch (err: unknown) {
      return {
        success: false,
        message: errMsg(err),
      }
    } finally {
      clearTimeout(timer)
    }
  }
}
