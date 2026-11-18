import OpenAI from 'openai'
import type { AiRecommendation, TasteProfile } from '@/core/types'
import { errMsg } from '@/core/validation'
import {
  buildRecommendationPrompt,
  getAiRecommendationsJsonSchema,
  parseRecommendationResponse,
} from './prompt'
import { RecommendationStreamParser } from './stream-parse'
import { DEFAULT_SDK_TIMEOUT_MS, optionalTimeoutSecondsToMs } from './timeout'
import type { AiUsage, RecommendationProvider } from './types'

const DEFAULT_MODEL = 'gpt-5.4-mini'

export class OpenAIProvider implements RecommendationProvider {
  private client: OpenAI
  private model: string
  lastUsage: AiUsage | null = null

  constructor(
    apiKey: string,
    model: string = DEFAULT_MODEL,
    baseUrl?: string | null,
    timeoutSeconds?: number | null,
  ) {
    const timeoutMs = optionalTimeoutSecondsToMs(timeoutSeconds)
    this.client = new OpenAI({
      apiKey,
      ...(baseUrl ? { baseURL: baseUrl } : {}),
      timeout: timeoutMs ?? DEFAULT_SDK_TIMEOUT_MS,
    })
    this.model = model
  }

  /** text-embedding-3-small, shortened to 256 dimensions (the API supports truncation natively). */
  async embed(texts: string[]): Promise<number[][]> {
    this.lastUsage = null
    const out: number[][] = []
    let tokens = 0
    for (let i = 0; i < texts.length; i += 512) {
      const res = await this.client.embeddings.create({
        model: 'text-embedding-3-small',
        input: texts.slice(i, i + 512),
        dimensions: 256,
      })
      for (const d of [...res.data].sort((a, b) => a.index - b.index)) out.push(d.embedding)
      tokens += res.usage?.prompt_tokens ?? 0
    }
    this.lastUsage = {
      provider: 'openai',
      model: 'text-embedding-3-small',
      inputTokens: tokens,
      outputTokens: 0,
    }
    return out
  }

  private buildRequest(profile: TasteProfile) {
    const prompt = buildRecommendationPrompt(profile)
    const schema = getAiRecommendationsJsonSchema()
    return {
      model: this.model,
      response_format: {
        type: 'json_schema' as const,
        json_schema: {
          name: 'music_recommendations',
          schema: schema as Record<string, unknown>,
          strict: false,
        },
      },
      max_completion_tokens: 4096,
      messages: [
        {
          role: 'system' as const,
          content:
            'You are a music discovery expert. Respond with a JSON object matching the provided schema (a "recommendations" array).',
        },
        { role: 'user' as const, content: prompt },
      ],
    }
  }

  private recordUsage(
    usage: { prompt_tokens: number; completion_tokens: number } | null | undefined,
  ) {
    if (!usage) return
    this.lastUsage = {
      provider: 'openai',
      model: this.model,
      inputTokens: usage.prompt_tokens,
      outputTokens: usage.completion_tokens,
    }
  }

  async getRecommendations(profile: TasteProfile): Promise<AiRecommendation[]> {
    this.lastUsage = null
    const response = await this.client.chat.completions.create(this.buildRequest(profile))
    this.recordUsage(response.usage)

    const content = response.choices[0]?.message?.content
    if (!content) {
      throw new Error('Empty response from OpenAI API')
    }

    // strict:false means the model can still emit fenced or truncated output;
    // the shared parser extracts the array instead of crashing on bare JSON.parse.
    return parseRecommendationResponse(content)
  }

  async streamRecommendations(
    profile: TasteProfile,
    onRecommendation: (rec: AiRecommendation) => void,
  ): Promise<AiRecommendation[]> {
    this.lastUsage = null
    const parser = new RecommendationStreamParser(onRecommendation)
    const stream = await this.client.chat.completions.create({
      ...this.buildRequest(profile),
      stream: true,
      stream_options: { include_usage: true },
    })
    let content = ''
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content ?? ''
      content += delta
      parser.push(delta)
      if (chunk.usage) this.recordUsage(chunk.usage)
    }
    if (!content) throw new Error('Empty response from OpenAI API')
    return parseRecommendationResponse(content)
  }

  async testConnection(): Promise<{ success: boolean; message: string }> {
    try {
      await this.client.chat.completions.create({
        model: this.model,
        max_completion_tokens: 10,
        messages: [{ role: 'user', content: 'ping' }],
      })

      return { success: true, message: `Connected to OpenAI (${this.model})` }
    } catch (err: unknown) {
      return { success: false, message: errMsg(err) }
    }
  }
}
