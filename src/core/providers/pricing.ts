// Default per-model prices in USD per 1M tokens, used to turn recorded token
// counts into an estimated cost. Prices change -- the admin can override any
// model in Settings (preferences.aiPricingOverrides), and unknown models
// record tokens with no cost. Matched by longest model-id prefix, so dated
// or suffixed ids ("claude-haiku-4-5-20251001") resolve to their family.
//
// Sources, checked 2026-11: Anthropic's model table, Google's Gemini API
// pricing page, OpenAI's pricing page. Batch rates are half of standard on
// all three.

export type ModelPrice = {
  input: number
  output: number
  /** Cached-input read price; falls back to `input` when absent. */
  cachedInput?: number
}

export const BATCH_DISCOUNT = 0.5

const DEFAULT_PRICES: Record<string, ModelPrice> = {
  // Anthropic
  'claude-fable-5-1': { input: 10, output: 50, cachedInput: 1 },
  'claude-fable-5': { input: 10, output: 50, cachedInput: 1 },
  'claude-opus-5-5': { input: 4, output: 20, cachedInput: 0.2 },
  'claude-opus-5': { input: 5, output: 25, cachedInput: 0.5 },
  'claude-opus-4': { input: 5, output: 25, cachedInput: 0.5 },
  'claude-sonnet-5': { input: 2, output: 10, cachedInput: 0.2 },
  'claude-sonnet-4': { input: 3, output: 15, cachedInput: 0.3 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cachedInput: 0.01 },
  'claude-haiku-4-5': { input: 1, output: 5, cachedInput: 0.1 },
  // Google Gemini
  'gemini-3.8-flash': { input: 0.75, output: 3.75, cachedInput: 0.075 },
  'gemini-3.6-flash': { input: 0.75, output: 3.75, cachedInput: 0.075 },
  'gemini-3-flash': { input: 0.5, output: 3, cachedInput: 0.05 },
  'gemini-3.1-pro': { input: 2, output: 12, cachedInput: 0.2 },
  'gemini-2.5-flash-lite': { input: 0.1, output: 0.4, cachedInput: 0.01 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5, cachedInput: 0.03 },
  'gemini-2.5-pro': { input: 1.25, output: 10, cachedInput: 0.125 },
  'gemini-embedding-001': { input: 0.15, output: 0 },
  // OpenAI
  'gpt-4o-mini': { input: 0.15, output: 0.6, cachedInput: 0.075 },
  'gpt-4o': { input: 2.5, output: 10, cachedInput: 1.25 },
  'gpt-4.1-nano': { input: 0.1, output: 0.4, cachedInput: 0.025 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6, cachedInput: 0.1 },
  'gpt-4.1': { input: 2, output: 8, cachedInput: 0.5 },
  'text-embedding-3-small': { input: 0.02, output: 0 },
}

// Local models cost nothing per token.
const FREE_PROVIDERS = new Set(['ollama'])

export function priceFor(
  provider: string,
  model: string,
  overrides?: Record<string, ModelPrice> | null,
): ModelPrice | null {
  if (FREE_PROVIDERS.has(provider)) return { input: 0, output: 0 }
  const id = model.toLowerCase().replace(/^models\//, '')
  const table = { ...DEFAULT_PRICES, ...(overrides ?? {}) }
  if (table[id]) return table[id] as ModelPrice
  let best: string | null = null
  for (const key of Object.keys(table)) {
    if (id.startsWith(key) && (!best || key.length > best.length)) best = key
  }
  return best ? (table[best] as ModelPrice) : null
}

export function estimateCostUsd(
  price: ModelPrice | null,
  tokens: { input?: number; output?: number; cached?: number },
  batch = false,
): number | null {
  if (!price) return null
  const cached = tokens.cached ?? 0
  const freshInput = Math.max(0, (tokens.input ?? 0) - cached)
  const usd =
    (freshInput * price.input +
      cached * (price.cachedInput ?? price.input) +
      (tokens.output ?? 0) * price.output) /
    1_000_000
  return batch ? usd * BATCH_DISCOUNT : usd
}
