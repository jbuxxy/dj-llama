import { useState } from 'react'
import { errMsg } from '@/core/validation'
import { testService } from '../lib/api'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Select } from './ui/select'

// Curated, small lists per hosted provider -- kept in sync with each
// provider's own DEFAULT_MODEL constant (core/providers/{provider}.ts) so
// the pre-selected option always matches what the app actually defaults to.
export const AI_MODEL_OPTIONS: Record<string, Array<{ value: string; label: string }>> = {
  anthropic: [
    { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
    { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
    { value: 'claude-opus-4-6', label: 'Claude Opus 4.6' },
  ],
  openai: [
    { value: 'gpt-5.4-nano', label: 'GPT-5.4 Nano' },
    { value: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' },
    { value: 'gpt-5.4', label: 'GPT-5.4' },
  ],
  gemini: [
    { value: 'gemini-3-flash-preview', label: 'Gemini 3 Flash (Preview)' },
    { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
  ],
}

interface AiModelFieldProps {
  id: string
  provider: string
  model: string
  baseUrl: string
  onModelChange: (model: string) => void
}

/**
 * Model picker for the AI provider config, shared between the setup wizard
 * and Settings so the two never drift. Anthropic/OpenAI/Gemini get a small
 * curated dropdown; Ollama's list is fetched live from the configured
 * server (models installed there vary per user, so nothing static would be
 * accurate); openai-compatible stays free text since it's an arbitrary
 * self-hosted endpoint whose available models can't be known in advance.
 */
export function AiModelField({ id, provider, model, baseUrl, onModelChange }: AiModelFieldProps) {
  const [ollamaModels, setOllamaModels] = useState<string[] | null>(null)
  const [ollamaLoading, setOllamaLoading] = useState(false)
  const [ollamaError, setOllamaError] = useState<string | null>(null)

  async function loadOllamaModels() {
    if (!baseUrl) return
    setOllamaLoading(true)
    setOllamaError(null)
    try {
      const result = await testService('ai-ollama-models', { baseUrl })
      setOllamaModels(result.models ?? [])
      if ((result.models ?? []).length > 0 && !(result.models ?? []).includes(model)) {
        onModelChange(result.models?.[0] ?? '')
      }
    } catch (err: unknown) {
      setOllamaModels(null)
      setOllamaError(errMsg(err))
    } finally {
      setOllamaLoading(false)
    }
  }

  if (provider === 'openai-compatible') {
    return (
      <Input
        id={id}
        placeholder="model-name"
        value={model}
        onChange={(e) => onModelChange(e.target.value)}
      />
    )
  }

  if (provider === 'ollama') {
    return (
      <div className="space-y-1.5">
        <div className="flex gap-2">
          {ollamaModels && ollamaModels.length > 0 ? (
            <Select
              id={id}
              value={model}
              onChange={(e) => onModelChange(e.target.value)}
              className="flex-1"
            >
              {ollamaModels.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </Select>
          ) : (
            <Input
              id={id}
              placeholder="llama4"
              value={model}
              onChange={(e) => onModelChange(e.target.value)}
              className="flex-1"
            />
          )}
          <Button
            type="button"
            variant="outline"
            onClick={loadOllamaModels}
            disabled={!baseUrl || ollamaLoading}
          >
            {ollamaLoading ? 'Loading...' : 'Load models'}
          </Button>
        </div>
        {ollamaError && <p className="text-xs text-reject">{ollamaError}</p>}
        {!ollamaModels && !ollamaError && (
          <p className="text-xs text-muted">
            Enter your Ollama server URL, then click Load models.
          </p>
        )}
      </div>
    )
  }

  const options = AI_MODEL_OPTIONS[provider] ?? []
  return (
    <Select id={id} value={model} onChange={(e) => onModelChange(e.target.value)}>
      {!model && <option value="">model-name</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </Select>
  )
}
