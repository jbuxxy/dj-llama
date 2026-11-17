import type { AiRecommendation, TasteProfile } from '@/core/types'
import { errMsg } from '@/core/validation'
import { buildRecommendationPrompt, parseRecommendationResponse } from './prompt'
import { readLines } from './read-lines'
import { fetchWithRetry } from './retry'
import { RecommendationStreamParser } from './stream-parse'
import { timeoutSecondsWithDefaultToMs, withTimeout } from './timeout'
import type { AiUsage, RecommendationProvider } from './types'

const DEFAULT_BASE_URL = 'http://localhost:11434'
const DEFAULT_TIMEOUT_SECONDS = 120

type OllamaChatResponse = {
  message: {
    role: string
    content: string
  }
  prompt_eval_count?: number
  eval_count?: number
}

type OllamaTagsResponse = {
  models: Array<{ name: string }>
}

export class OllamaProvider implements RecommendationProvider {
  private model: string
  private baseUrl: string
  private timeoutMs: number
  lastUsage: AiUsage | null = null

  constructor(model: string, baseUrl: string = DEFAULT_BASE_URL, timeoutSeconds?: number | null) {
    this.model = model
    this.baseUrl = baseUrl.replace(/\/$/, '')
    this.timeoutMs = timeoutSecondsWithDefaultToMs(timeoutSeconds, DEFAULT_TIMEOUT_SECONDS)
  }

  async getRecommendations(profile: TasteProfile): Promise<AiRecommendation[]> {
    this.lastUsage = null
    const prompt = buildRecommendationPrompt(profile)

    return withTimeout(this.timeoutMs, 'Ollama recommendation request', async (signal) => {
      const response = await fetchWithRetry(
        `${this.baseUrl}/api/chat`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: this.model,
            messages: [{ role: 'user', content: prompt }],
            format: 'json',
            stream: false,
            // Keep the model resident between calls: a scan makes two AI calls
            // back to back and mood searches come in bursts, and Ollama's 5m
            // default meant paying a cold model load (often 10s+) repeatedly.
            keep_alive: '30m',
          }),
          signal: signal,
        },
        { providerLabel: 'ollama' },
      )

      const data = (await response.json()) as OllamaChatResponse
      const content = data.message?.content

      if (data.prompt_eval_count != null || data.eval_count != null) {
        this.lastUsage = {
          provider: 'ollama',
          model: this.model,
          inputTokens: data.prompt_eval_count,
          outputTokens: data.eval_count,
        }
      }

      if (!content) {
        throw new Error('Empty response from Ollama API')
      }

      return parseRecommendationResponse(content)
    })
  }

  async streamRecommendations(
    profile: TasteProfile,
    onRecommendation: (rec: AiRecommendation) => void,
  ): Promise<AiRecommendation[]> {
    this.lastUsage = null
    const prompt = buildRecommendationPrompt(profile)
    const parser = new RecommendationStreamParser(onRecommendation)

    return withTimeout(this.timeoutMs, 'Ollama recommendation request', async (signal) => {
      const response = await fetchWithRetry(
        `${this.baseUrl}/api/chat`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: this.model,
            messages: [{ role: 'user', content: prompt }],
            format: 'json',
            stream: true,
            keep_alive: '30m',
          }),
          signal: signal,
        },
        { providerLabel: 'ollama' },
      )
      if (!response.body) throw new Error('Empty response from Ollama API')

      // NDJSON: one {"message":{"content":"..."},"done":false} per token
      // batch, then a final {"done":true,...counts}.
      let content = ''
      for await (const line of readLines(response.body)) {
        let chunk: OllamaChatResponse & { done?: boolean; error?: string }
        try {
          chunk = JSON.parse(line)
        } catch {
          continue
        }
        if (chunk.error) throw new Error(`Ollama: ${chunk.error}`)
        const delta = chunk.message?.content ?? ''
        content += delta
        parser.push(delta)
        if (chunk.done && (chunk.prompt_eval_count != null || chunk.eval_count != null)) {
          this.lastUsage = {
            provider: 'ollama',
            model: this.model,
            inputTokens: chunk.prompt_eval_count,
            outputTokens: chunk.eval_count,
          }
        }
      }
      if (!content) throw new Error('Empty response from Ollama API')
      return parseRecommendationResponse(content)
    })
  }

  async testConnection(): Promise<{ success: boolean; message: string }> {
    try {
      return await withTimeout(10_000, 'Ollama connection test', async (signal) => {
        const response = await fetch(`${this.baseUrl}/api/tags`, {
          signal: signal,
        })

        if (!response.ok) {
          return {
            success: false,
            message: `Ollama returned ${response.status} ${response.statusText}`,
          }
        }

        const data = (await response.json()) as OllamaTagsResponse
        const models = data.models?.map((m) => m.name) ?? []

        // Ollama treats a tagless name as ":latest", so "llama3" must match a
        // pulled "llama3:latest" - compare both the full name and the base name.
        const available = models.some(
          (name) => name === this.model || name.split(':')[0] === this.model,
        )
        if (!available) {
          return {
            success: false,
            message: `Connected to Ollama, but model "${this.model}" is not available (${models.length} model(s) installed). Pull it first: ollama pull ${this.model}`,
          }
        }

        return {
          success: true,
          message: `Connected to Ollama - model "${this.model}" is available (${models.length} model(s) installed)`,
        }
      })
    } catch (err: unknown) {
      return { success: false, message: errMsg(err) }
    }
  }
}

/**
 * Lists models actually installed on a given Ollama server -- used to
 * populate the model dropdown in the setup wizard and Settings instead of
 * making the admin guess/type an exact model name. Deliberately standalone
 * (not a method on OllamaProvider) since it's needed before a model has been
 * chosen, i.e. before a full provider instance can even be constructed.
 */
export async function probeOllamaModels(
  baseUrl: string,
): Promise<{ success: boolean; message: string; models?: string[] }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/tags`, {
      signal: controller.signal,
    })
    if (!response.ok) {
      return {
        success: false,
        message: `Ollama returned ${response.status} ${response.statusText}`,
      }
    }
    const data = (await response.json()) as OllamaTagsResponse
    const models = data.models?.map((m) => m.name) ?? []
    return { success: true, message: `${models.length} model(s) installed`, models }
  } catch (err: unknown) {
    return { success: false, message: errMsg(err) }
  } finally {
    clearTimeout(timer)
  }
}
