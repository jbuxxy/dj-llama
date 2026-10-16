import { useState } from 'react'
import { toast } from 'sonner'
import { AiModelField } from '../components/ai-model-field'
import { Field } from '../components/field'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Select } from '../components/ui/select'
import { ApiError, completeSetup } from '../lib/api'

type FormState = {
  lidarr: { url: string; apiKey: string; skipTlsVerify: boolean }
  ai: { provider: string; model: string; apiKey: string; baseUrl: string }
}

function StepIndicator({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex items-center justify-center gap-0 mb-8">
      {Array.from({ length: total }, (_, i) => {
        const step = i + 1
        const done = step < current
        const active = step === current

        return (
          <div key={step} className="flex items-center">
            <div
              className={[
                'flex h-8 w-8 items-center justify-center rounded-full text-sm font-semibold border',
                active
                  ? 'bg-accent text-accent-fg border-accent'
                  : done
                    ? 'bg-approve text-bg border-approve'
                    : 'bg-surface text-muted border-border',
              ].join(' ')}
            >
              {done ? (
                <svg
                  className="h-4 w-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2.5}
                  aria-label="Step complete"
                  role="img"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              ) : (
                step
              )}
            </div>
            {i < total - 1 && (
              <div className={['h-px w-12', done ? 'bg-approve' : 'bg-border'].join(' ')} />
            )}
          </div>
        )
      })}
    </div>
  )
}

function StepLidarr({
  form,
  onFormChange,
  onContinue,
}: {
  form: FormState['lidarr']
  onFormChange: (v: FormState['lidarr']) => void
  onContinue: () => void
}) {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold text-text">Connect Lidarr</h2>
        <p className="text-sm text-muted mt-1">Lidarr manages your music library and downloads.</p>
      </div>
      <Field label="Lidarr URL" id="lidarr-url">
        <Input
          id="lidarr-url"
          type="url"
          placeholder="http://localhost:8686"
          value={form.url}
          onChange={(e) => onFormChange({ ...form, url: e.target.value })}
        />
      </Field>
      <label className="flex items-center gap-2 text-sm text-muted cursor-pointer">
        <input
          type="checkbox"
          checked={form.skipTlsVerify}
          onChange={(e) => onFormChange({ ...form, skipTlsVerify: e.target.checked })}
          className="rounded border-border"
        />
        Skip TLS verification
      </label>
      <Field label="API Key" id="lidarr-apikey">
        <Input
          id="lidarr-apikey"
          type="password"
          placeholder="Your Lidarr API key"
          value={form.apiKey}
          onChange={(e) => onFormChange({ ...form, apiKey: e.target.value })}
        />
      </Field>
      <p className="text-xs text-muted">
        Connection tests are available in Settings after setup. Continue once the URL and API key
        look right.
      </p>
      <Button onClick={onContinue} disabled={!form.url || !form.apiKey} className="w-full">
        Continue
      </Button>
    </div>
  )
}

function StepAi({
  form,
  onFormChange,
  onContinue,
  onSkip,
}: {
  form: FormState['ai']
  onFormChange: (v: FormState['ai']) => void
  onContinue: () => void
  onSkip: () => void
}) {
  const needsApiKey = form.provider !== 'ollama' && form.provider !== 'openai-compatible'
  const apiKeyOptional = form.provider === 'openai-compatible'
  const needsBaseUrl = form.provider === 'ollama' || form.provider === 'openai-compatible'

  const apiKeyLinks: Record<string, { url: string; label: string }> = {
    anthropic: { url: 'https://console.anthropic.com/settings/keys', label: 'Get API key' },
    openai: { url: 'https://platform.openai.com/api-keys', label: 'Get API key' },
    gemini: { url: 'https://aistudio.google.com/app/apikey', label: 'Get API key' },
  }

  const link = apiKeyLinks[form.provider]

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold text-text">AI Provider</h2>
        <p className="text-sm text-muted mt-1">
          Optional. Powers AI recommendations and playlist generation -- skip this and set it up
          later in Settings if you want.
        </p>
        <p className="text-xs text-muted mt-2">
          You'll connect personal listening sources later in Settings after you log in.
        </p>
      </div>
      <Field label="Provider" id="ai-provider">
        <Select
          id="ai-provider"
          value={form.provider}
          onChange={(e) => onFormChange({ ...form, provider: e.target.value, model: '' })}
        >
          <option value="anthropic">Anthropic</option>
          <option value="openai">OpenAI</option>
          <option value="gemini">Google Gemini</option>
          <option value="ollama">Ollama</option>
          <option value="openai-compatible">OpenAI-Compatible</option>
        </Select>
      </Field>
      {needsBaseUrl && (
        <Field label="Base URL" id="ai-baseurl">
          <Input
            id="ai-baseurl"
            type="url"
            placeholder={
              form.provider === 'openai-compatible'
                ? 'http://localhost:8080'
                : 'http://localhost:11434'
            }
            value={form.baseUrl}
            onChange={(e) => onFormChange({ ...form, baseUrl: e.target.value })}
          />
        </Field>
      )}
      <Field label="Model" id="ai-model">
        <AiModelField
          id="ai-model"
          provider={form.provider}
          model={form.model}
          baseUrl={form.baseUrl}
          onModelChange={(model) => onFormChange({ ...form, model })}
        />
      </Field>
      {(needsApiKey || apiKeyOptional) && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <label htmlFor="ai-apikey" className="text-sm text-muted">
              {apiKeyOptional ? `API Key (optional)` : 'API Key'}
            </label>
            {link && (
              <a
                href={link.url}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-accent underline"
              >
                Get API key
              </a>
            )}
          </div>
          <Input
            id="ai-apikey"
            type="password"
            placeholder={form.provider === 'anthropic' ? 'sk-ant-...' : 'sk-...'}
            value={form.apiKey}
            onChange={(e) => onFormChange({ ...form, apiKey: e.target.value })}
          />
        </div>
      )}
      {form.provider === 'openai-compatible' && (
        <p className="text-xs text-muted">
          Works with Groq, OpenRouter, LiteLLM, LocalAI, and any OpenAI-compatible endpoint. API key
          is optional for local services.
        </p>
      )}
      <p className="text-xs text-muted">
        You can verify the provider from Settings after setup. Continue once the provider details
        are filled in.
      </p>
      <Button
        onClick={onContinue}
        disabled={!form.model || (needsApiKey && !form.apiKey) || (needsBaseUrl && !form.baseUrl)}
        className="w-full"
      >
        Continue
      </Button>
      <button
        type="button"
        onClick={onSkip}
        className="w-full text-sm text-muted hover:text-text text-center"
      >
        Skip for now
      </button>
    </div>
  )
}

function StepDone({
  form,
  onStart,
  starting,
}: {
  form: FormState
  onStart: () => void
  starting: boolean
}) {
  const rows: { label: string; value: string }[] = [{ label: 'Lidarr', value: form.lidarr.url }]
  rows.push({
    label: 'AI Provider',
    value: form.ai.model ? `${form.ai.provider} / ${form.ai.model}` : 'Not configured',
  })

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-text">Ready to go</h2>
        <p className="text-sm text-muted mt-1">Here's what you've configured:</p>
        <p className="text-xs text-muted mt-2">
          Personal listening sources are connected per user from Settings after setup.
        </p>
      </div>
      <div className="rounded-lg border border-border bg-surface divide-y divide-border">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center justify-between px-4 py-3">
            <span className="text-sm text-muted">{row.label}</span>
            <span className="text-sm text-text font-medium">{row.value}</span>
          </div>
        ))}
      </div>
      <Button onClick={onStart} disabled={starting} className="w-full" size="lg">
        {starting ? 'Starting...' : 'Start Digging'}
      </Button>
    </div>
  )
}

const DEFAULT_FORM: FormState = {
  lidarr: { url: '', apiKey: '', skipTlsVerify: false },
  ai: { provider: 'anthropic', model: '', apiKey: '', baseUrl: '' },
}

// Lidarr is the only supported target and is required, so the wizard is a
// fixed 3-step flow (Lidarr -> AI -> review) with no mode-selection step.
const AI_STEP = 2
const DONE_STEP = 3

export function SetupWizard({ onComplete }: { onComplete: () => void }) {
  const [step, setStep] = useState(1)
  const [form, setForm] = useState<FormState>(DEFAULT_FORM)
  const [starting, setStarting] = useState(false)

  async function handleStart() {
    setStarting(true)
    const config: Record<string, unknown> = {
      lidarrUrl: form.lidarr.url,
      lidarrApiKey: form.lidarr.apiKey,
      skipTlsVerify: form.lidarr.skipTlsVerify,
    }
    // AI is optional -- only send these if a model was actually chosen.
    // Sending an empty aiModel alongside a (default) aiProvider would make
    // the backend think AI was partially configured and reject the request.
    if (form.ai.model) {
      config.aiProvider = form.ai.provider
      config.aiModel = form.ai.model
      config.aiApiKey = form.ai.apiKey || null
      config.aiBaseUrl = form.ai.baseUrl || null
    }
    try {
      await completeSetup(config)
      onComplete()
    } catch (err) {
      // Surface the backend's reason (missing field, validation, conflict)
      // instead of an opaque generic toast. ApiError.message already carries
      // the server message; the missing-fields list adds detail.
      if (err instanceof ApiError) {
        const fields = (err.data as { fields?: string[] } | null)?.fields
        toast.error(fields?.length ? `${err.message}: ${fields.join(', ')}` : err.message)
      } else {
        toast.error('Setup failed - please try again')
      }
      setStarting(false)
    }
  }

  return (
    <div className="min-h-screen bg-bg flex items-center justify-center p-6">
      <div className="w-full max-w-md">
        <h1 className="sr-only">Setup</h1>
        <div className="mb-8 text-center">
          <div className="flex items-center justify-center gap-2">
            <img src="/icon.png" alt="" width="28" height="28" />
            <span className="text-3xl font-display tracking-wide text-accent">DJ LLAMA</span>
          </div>
          <p className="text-muted text-sm mt-1">Initial setup</p>
        </div>

        <StepIndicator current={step} total={DONE_STEP} />

        <div className="rounded-lg border border-border bg-surface p-6">
          {step === 1 && (
            <StepLidarr
              form={form.lidarr}
              onFormChange={(v) => setForm((f) => ({ ...f, lidarr: v }))}
              onContinue={() => setStep(AI_STEP)}
            />
          )}
          {step === AI_STEP && (
            <StepAi
              form={form.ai}
              onFormChange={(v) => setForm((f) => ({ ...f, ai: v }))}
              onContinue={() => setStep(DONE_STEP)}
              onSkip={() => {
                setForm((f) => ({ ...f, ai: DEFAULT_FORM.ai }))
                setStep(DONE_STEP)
              }}
            />
          )}
          {step === DONE_STEP && <StepDone form={form} onStart={handleStart} starting={starting} />}
        </div>

        {step > 1 && step < DONE_STEP && (
          <button
            type="button"
            onClick={() => setStep((s) => s - 1)}
            className="mt-4 text-sm text-muted hover:text-text"
          >
            &larr; Back
          </button>
        )}
      </div>
    </div>
  )
}
