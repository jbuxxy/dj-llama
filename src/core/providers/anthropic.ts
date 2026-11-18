import Anthropic from '@anthropic-ai/sdk'
import type { AiRecommendation, TasteProfile } from '@/core/types'
import { errMsg } from '@/core/validation'
import {
  buildRecommendationPrompt,
  buildRecommendationUserTurn,
  getAiRecommendationsJsonSchema,
  parseRecommendationResponse,
  RECOMMENDATION_SYSTEM_PRELUDE,
  validateAiRecommendations,
} from './prompt'
import { RecommendationStreamParser } from './stream-parse'
import { DEFAULT_SDK_TIMEOUT_MS, optionalTimeoutSecondsToMs } from './timeout'
import type { AiUsage, BatchStatus, RecommendationProvider } from './types'

const RECOMMENDATION_TOOL_NAME = 'emit_recommendations'

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001'

export class AnthropicProvider implements RecommendationProvider {
  private client: Anthropic
  private model: string
  lastUsage: AiUsage | null = null

  constructor(
    apiKey: string,
    model: string = DEFAULT_MODEL,
    baseUrl?: string | null,
    timeoutSeconds?: number | null,
  ) {
    const timeoutMs = optionalTimeoutSecondsToMs(timeoutSeconds)
    this.client = new Anthropic({
      apiKey,
      ...(baseUrl ? { baseURL: baseUrl } : {}),
      timeout: timeoutMs ?? DEFAULT_SDK_TIMEOUT_MS,
    })
    this.model = model
  }

  private buildRequest(profile: TasteProfile) {
    const schema = getAiRecommendationsJsonSchema() as {
      type: string
      properties: Record<string, unknown>
      required?: string[]
    }

    // When the caller supplied a pre-built prompt (quick-discover, mood) we
    // skip the split because there is no cacheable prelude to reuse.
    const useCachedPrelude = !profile._rawPrompt
    const userContent = useCachedPrelude
      ? buildRecommendationUserTurn(profile)
      : buildRecommendationPrompt(profile)

    return {
      model: this.model,
      max_tokens: 4096,
      ...(useCachedPrelude
        ? {
            // System blocks support `cache_control: { type: 'ephemeral' }`.
            // The first request writes the cache; subsequent requests within
            // the 5-minute TTL read from it at ~10% of input-token cost.
            system: [
              {
                type: 'text' as const,
                text: RECOMMENDATION_SYSTEM_PRELUDE,
                cache_control: { type: 'ephemeral' as const },
              },
            ],
          }
        : {}),
      messages: [{ role: 'user' as const, content: userContent }],
      tools: [
        {
          name: RECOMMENDATION_TOOL_NAME,
          description:
            'Emit the structured recommendation list. Call this tool exactly once with the complete array of recommendations.',
          input_schema: {
            type: 'object' as const,
            properties: schema.properties,
            required: schema.required ?? ['recommendations'],
          },
        },
      ],
      tool_choice: { type: 'tool' as const, name: RECOMMENDATION_TOOL_NAME },
    }
  }

  private parseMessage(message: Anthropic.Messages.Message): AiRecommendation[] {
    this.lastUsage = extractUsage(this.model, message.usage)

    const toolUse = message.content.find((block) => block.type === 'tool_use')
    if (toolUse && toolUse.type === 'tool_use') {
      return validateAiRecommendations(toolUse.input)
    }

    // Fallback: some proxy deployments drop tool_use support - parse any text
    // block as a JSON array the old way.
    const firstContent = message.content[0]
    if (firstContent?.type !== 'text') {
      throw new Error('Unexpected response format from Anthropic API')
    }
    return parseRecommendationResponse(firstContent.text)
  }

  /** Message Batches API -- same request body as getRecommendations, half price. */
  async submitBatch(requests: Array<{ key: string; profile: TasteProfile }>): Promise<string> {
    const batch = await this.client.messages.batches.create({
      requests: requests.map((r) => ({ custom_id: r.key, params: this.buildRequest(r.profile) })),
    })
    return batch.id
  }

  async getBatch(batchId: string): Promise<BatchStatus> {
    const batch = await this.client.messages.batches.retrieve(batchId)
    if (batch.processing_status !== 'ended') {
      return { state: batch.processing_status === 'canceling' ? 'cancelled' : 'running' }
    }
    const results: NonNullable<BatchStatus['results']> = new Map()
    // Results come back in any order -- keyed by custom_id, never position.
    for await (const item of await this.client.messages.batches.results(batchId)) {
      if (item.result.type !== 'succeeded') {
        results.set(item.custom_id, { error: item.result.type })
        continue
      }
      try {
        const recs = this.parseMessage(item.result.message)
        results.set(item.custom_id, {
          recs,
          usage: this.lastUsage ? { ...this.lastUsage, batch: true } : null,
        })
      } catch (err) {
        results.set(item.custom_id, { error: errMsg(err) })
      }
    }
    return { state: 'succeeded', results }
  }

  async getRecommendations(profile: TasteProfile): Promise<AiRecommendation[]> {
    this.lastUsage = null
    const response = await this.client.messages.create(this.buildRequest(profile))
    return this.parseMessage(response)
  }

  async streamRecommendations(
    profile: TasteProfile,
    onRecommendation: (rec: AiRecommendation) => void,
  ): Promise<AiRecommendation[]> {
    this.lastUsage = null
    const parser = new RecommendationStreamParser(onRecommendation)
    const stream = this.client.messages.stream(this.buildRequest(profile))
    for await (const event of stream) {
      if (event.type !== 'content_block_delta') continue
      // The forced tool call streams its arguments as partial JSON; the text
      // fallback (proxies without tool support) streams as text.
      if (event.delta.type === 'input_json_delta') parser.push(event.delta.partial_json)
      else if (event.delta.type === 'text_delta') parser.push(event.delta.text)
    }
    return this.parseMessage(await stream.finalMessage())
  }

  async testConnection(): Promise<{ success: boolean; message: string }> {
    try {
      await this.client.messages.create({
        model: this.model,
        max_tokens: 10,
        messages: [{ role: 'user', content: 'ping' }],
      })

      return { success: true, message: `Connected to Anthropic (${this.model})` }
    } catch (err: unknown) {
      return { success: false, message: errMsg(err) }
    }
  }
}

function extractUsage(
  model: string,
  usage: Anthropic.Messages.Usage | null | undefined,
): AiUsage | null {
  if (!usage) return null
  return {
    provider: 'anthropic',
    model,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? undefined,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? undefined,
  }
}
