import { Hono } from 'hono'
import type { SetupConfig } from '@/db/queries/settings'
import { upsertSystemTarget } from '@/db/queries/targets'
import type { AppDependencies } from '@/server'
import { setupCompleteSchema } from '@/server/schemas/setup'
import { zJson } from '@/server/schemas/validator'
import type { HonoEnv } from '@/server/types'

export function setupRoutes(deps: AppDependencies) {
  const router = new Hono<HonoEnv>()
  const GLOBAL_SETUP_FIELDS = new Set([
    'lidarrUrl',
    'lidarrApiKey',
    'skipTlsVerify',
    'aiProvider',
    'aiApiKey',
    'aiModel',
    'aiBaseUrl',
    'preferences',
  ])

  router.get('/api/v1/setup/status', async (c) => {
    const complete = await deps.isSetupComplete()
    return c.json({ setupComplete: complete })
  })

  router.post('/api/v1/setup/complete', zJson(setupCompleteSchema), async (c) => {
    const alreadyDone = await deps.isSetupComplete()
    if (alreadyDone) {
      return c.json({ error: 'Setup already complete' }, 409)
    }

    const body = c.req.valid('json') as Record<string, unknown>
    const sanitized = Object.fromEntries(
      Object.entries(body).filter(([key, value]) => GLOBAL_SETUP_FIELDS.has(key) && value != null),
    )

    const missing: string[] = []
    // Lidarr is required -- DJ Llama has nothing to dispatch requests/
    // recommendations to without it. AI is optional: AI-powered features
    // (recommendations, playlist generation) just stay disabled until an
    // admin configures a provider later in Settings.
    if (!sanitized.lidarrUrl) missing.push('lidarrUrl')
    if (!sanitized.lidarrApiKey) missing.push('lidarrApiKey')
    // AI is optional - only validate if partially provided
    if (sanitized.aiProvider && !sanitized.aiModel) {
      missing.push('aiModel (required when aiProvider is set)')
    }
    if (!sanitized.aiProvider && sanitized.aiModel) {
      missing.push('aiProvider (required when aiModel is set)')
    }

    if (missing.length > 0) {
      return c.json({ error: 'Missing required fields', fields: missing }, 400)
    }

    await deps.completeSetup(sanitized as SetupConfig)

    // Mirror Lidarr into the system target row, even though
    // settings.lidarrUrl/apiKey is now the actual source of truth (see
    // db/queries/targets.ts).
    if (sanitized.lidarrUrl && sanitized.lidarrApiKey) {
      try {
        await upsertSystemTarget(deps.db, 'lidarr', 'Lidarr', {
          url: sanitized.lidarrUrl,
          apiKey: sanitized.lidarrApiKey,
          skipTlsVerify: sanitized.skipTlsVerify ?? false,
        })
      } catch {
        // Best-effort - the boot-time backfill will handle it on next restart
      }
    }

    return c.body(null, 204)
  })

  return router
}
