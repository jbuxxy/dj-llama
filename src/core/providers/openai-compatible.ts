import type { AiRecommendation, TasteProfile } from '@/core/types'
import { errMsg } from '@/core/validation'
import {
  buildRecommendationPrompt,
  parseRecommendationResponse,
  unwrapRecommendationArrayPayload,
} from './prompt'
import { readLines } from './read-lines'
import { fetchWithRetry } from './retry'
import { RecommendationStreamParser } from './stream-parse'
import { timeoutSecondsWithDefaultToMs } from './timeout'
import type { AiUsage, RecommendationProvider } from './types'

const DEFAULT_TIMEOUT_SECONDS = 60

function buildChatCompletionsUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, '')
  if (normalized.endsWith('/chat/completions')) return normalized
  if (normalized.endsWith('/v1') || normalized.endsWith('/api')) {
    return `${normalized}/chat/completions`
  }
  return `${normalized}/v1/chat/completions`
}

function timeoutMessage(operation: string, timeoutMs: number): string {
  const seconds = timeoutMs / 1000
  return `OpenAI-Compatible ${operation} timed out after ${seconds} second${seconds === 1 ? '' : 's'}`
}

export class OpenAICompatibleProvider implements RecommendationProvider {
  private baseUrl: string
  private chatCompletionsUrl: string
  private apiKey: string | null
  private model: string
  private timeoutMs: number
  lastUsage: AiUsage | null = null

  constructor(
    baseUrl: string,
    model: string,
    apiKey: string | null = null,
    timeoutSeconds?: number | null,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.chatCompletionsUrl = buildChatCompletionsUrl(this.baseUrl)
    this.model = model
    this.apiKey = apiKey
    this.timeoutMs = timeoutSecondsWithDefaultToMs(timeoutSeconds, DEFAULT_TIMEOUT_SECONDS)
  }

  async getRecommendations(profile: TasteProfile): Promise<AiRecommendation[]> {
    this.lastUsage = null
    const prompt = buildRecommendationPrompt(profile)
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetchWithRetry(
        this.chatCompletionsUrl,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: this.model,
            messages: [
              { role: 'system', content: 'Respond with a JSON array only.' },
              { role: 'user', content: prompt },
            ],
            max_completion_tokens: 4096,
          }),
          signal: controller.signal,
        },
        { providerLabel: 'openai-compatible' },
      )

      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>
        usage?: { prompt_tokens?: number; completion_tokens?: number }
      }
      if (data.usage) {
        this.lastUsage = {
          provider: 'openai-compatible',
          model: this.model,
          inputTokens: data.usage.prompt_tokens,
          outputTokens: data.usage.completion_tokens,
        }
      }
      const text = data.choices?.[0]?.message?.content
      if (!text) throw new Error('Empty response')
      return parseRecommendationResponse(unwrapRecommendationArrayPayload(text))
    } catch (err: unknown) {
      if (controller.signal.aborted) {
        throw new Error(timeoutMessage('recommendation request', this.timeoutMs))
      }
      throw err
    } finally {
      clearTimeout(timer)
    }
  }

  async streamRecommendations(
    profile: TasteProfile,
    onRecommendation: (rec: AiRecommendation) => void,
  ): Promise<AiRecommendation[]> {
    this.lastUsage = null
    const prompt = buildRecommendationPrompt(profile)
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`
    const parser = new RecommendationStreamParser(onRecommendation)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetchWithRetry(
        this.chatCompletionsUrl,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: this.model,
            messages: [
              { role: 'system', content: 'Respond with a JSON array only.' },
              { role: 'user', content: prompt },
            ],
            max_completion_tokens: 4096,
            stream: true,
          }),
          signal: controller.signal,
        },
        { providerLabel: 'openai-compatible' },
      )
      if (!res.body) throw new Error('Empty response')
      // Some "compatible" servers ignore stream:true and answer with one
      // plain JSON body -- handle that the same as getRecommendations.
      if (!(res.headers.get('content-type') ?? '').includes('text/event-stream')) {
        const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
        const text = data.choices?.[0]?.message?.content
        if (!text) throw new Error('Empty response')
        const recs = parseRecommendationResponse(unwrapRecommendationArrayPayload(text))
        for (const rec of recs) onRecommendation(rec)
        return recs
      }
      let content = ''
      for await (const line of readLines(res.body)) {
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') break
        try {
          const chunk = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string } }>
            usage?: { prompt_tokens?: number; completion_tokens?: number }
          }
          const delta = chunk.choices?.[0]?.delta?.content ?? ''
          content += delta
          parser.push(delta)
          if (chunk.usage) {
            this.lastUsage = {
              provider: 'openai-compatible',
              model: this.model,
              inputTokens: chunk.usage.prompt_tokens,
              outputTokens: chunk.usage.completion_tokens,
            }
          }
        } catch {
          // keep-alive comments / partial frames
        }
      }
      if (!content) throw new Error('Empty response')
      return parseRecommendationResponse(unwrapRecommendationArrayPayload(content))
    } catch (err: unknown) {
      if (controller.signal.aborted) {
        throw new Error(timeoutMessage('recommendation request', this.timeoutMs))
      }
      throw err
    } finally {
      clearTimeout(timer)
    }
  }

  async testConnection(): Promise<{ success: boolean; message: string }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`

      const res = await fetch(this.chatCompletionsUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: 'user', content: 'ping' }],
          max_completion_tokens: 10,
        }),
        signal: controller.signal,
      })

      if (res.ok) {
        return { success: true, message: `Connected to ${this.baseUrl} (${this.model})` }
      }
      const body = await res.text().catch(() => '')
      return { success: false, message: body || `HTTP ${res.status}` }
    } catch (err: unknown) {
      return {
        success: false,
        message: controller.signal.aborted
          ? timeoutMessage('connection test', this.timeoutMs)
          : errMsg(err),
      }
    } finally {
      clearTimeout(timer)
    }
  }
}
