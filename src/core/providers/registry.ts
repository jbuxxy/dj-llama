import { BatchingProvider, type BatchOptions, supportsBatch } from './batch'
import { MeteredProvider, type UsageContext, type UsageRecorder } from './metered'
import type { RecommendationProvider } from './types'

export type AiProviderConfig = {
  apiKey: string | null
  model: string
  baseUrl?: string | null
  timeoutSeconds?: number | null
}

export type AiProviderDefinition = {
  id: string
  name: string
  create: (config: AiProviderConfig) => RecommendationProvider | Promise<RecommendationProvider>
}

export class AiProviderRegistry {
  private providers = new Map<string, AiProviderDefinition>()

  register(definition: AiProviderDefinition): void {
    this.providers.set(definition.id, definition)
  }

  private usageRecorder: UsageRecorder | null = null

  private budgetCheck: (() => Promise<void>) | null = null

  /** Runs before every metered create; throws (e.g. AiBudgetExceededError) to refuse it. */
  setBudgetCheck(check: (() => Promise<void>) | null): void {
    this.budgetCheck = check
  }

  /** Where metered providers send one usage row per call (set once at boot). */
  setUsageRecorder(recorder: UsageRecorder | null): void {
    this.usageRecorder = recorder
  }

  /**
   * With `usage`, the provider comes back metered: every call records its
   * tokens and cost against that feature/user (see metered.ts).
   */
  async create(
    id: string,
    config: AiProviderConfig,
    usage?: UsageContext,
    /** Route getRecommendations through the batch API when the provider has one (scheduled scans). */
    batch?: BatchOptions,
  ): Promise<RecommendationProvider> {
    const definition = this.providers.get(id)
    if (!definition) {
      throw new Error(`Unknown AI provider: ${id}`)
    }
    if (usage && this.budgetCheck) await this.budgetCheck()
    const created = await definition.create(config)
    const provider =
      batch && supportsBatch(created) ? new BatchingProvider(created, batch) : created
    return usage && this.usageRecorder
      ? new MeteredProvider(provider, usage, this.usageRecorder)
      : provider
  }

  has(id: string): boolean {
    return this.providers.has(id)
  }

  availableIds(): string[] {
    return [...this.providers.keys()]
  }
}

export function createDefaultRegistry(): AiProviderRegistry {
  const registry = new AiProviderRegistry()

  registry.register({
    id: 'anthropic',
    name: 'Anthropic',
    async create({ apiKey, model, baseUrl, timeoutSeconds }) {
      const { AnthropicProvider } = await import('./anthropic')
      if (!apiKey) throw new Error('Anthropic requires an API key')
      return new AnthropicProvider(apiKey, model, baseUrl, timeoutSeconds ?? undefined)
    },
  })

  registry.register({
    id: 'openai',
    name: 'OpenAI',
    async create({ apiKey, model, baseUrl, timeoutSeconds }) {
      const { OpenAIProvider } = await import('./openai')
      if (!apiKey) throw new Error('OpenAI requires an API key')
      return new OpenAIProvider(apiKey, model, baseUrl, timeoutSeconds ?? undefined)
    },
  })

  registry.register({
    id: 'ollama',
    name: 'Ollama',
    async create({ model, baseUrl, timeoutSeconds }) {
      const { OllamaProvider } = await import('./ollama')
      if (!baseUrl) throw new Error('Ollama requires a base URL')
      return new OllamaProvider(model, baseUrl, timeoutSeconds ?? undefined)
    },
  })

  registry.register({
    id: 'gemini',
    name: 'Google Gemini',
    async create({ apiKey, model, timeoutSeconds }) {
      const { GeminiProvider } = await import('./gemini')
      if (!apiKey) throw new Error('Gemini requires an API key')
      return new GeminiProvider(apiKey, model, timeoutSeconds ?? undefined)
    },
  })

  registry.register({
    id: 'openai-compatible',
    name: 'OpenAI-Compatible',
    async create({ apiKey, model, baseUrl, timeoutSeconds }) {
      const { OpenAICompatibleProvider } = await import('./openai-compatible')
      if (!baseUrl) throw new Error('OpenAI-Compatible requires a base URL')
      return new OpenAICompatibleProvider(baseUrl, model, apiKey, timeoutSeconds ?? undefined)
    },
  })

  return registry
}
