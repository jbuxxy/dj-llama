import { Hono } from 'hono'
import { validateAiBaseUrl } from '@/core/url-safety'
import type { SetupConfig } from '@/db/queries/settings'
import { upsertSystemTarget } from '@/db/queries/targets'
import type { AppDependencies } from '@/server'
import { apiError, problem } from '@/server/helpers/problem'
import { requireAdmin } from '@/server/helpers/require-user'
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

  // The wizard only renders after Plex sign-in, and the first sign-in makes
  // the server owner an admin -- so finishing setup needs that admin session.
  // Unauthenticated, anyone who reached a fresh install first could point
  // Lidarr and the AI provider at servers they control.
  router.post('/api/v1/setup/complete', zJson(setupCompleteSchema), async (c) => {
    const auth = await requireAdmin(c, deps.getUserById)
    if (!auth.ok) return auth.response

    const alreadyDone = await deps.isSetupComplete()
    if (alreadyDone) {
      return apiError(c, 409, 'Setup already complete')
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
      return apiError(c, 400, 'Missing required fields', { fields: missing })
    }

    if (typeof sanitized.aiBaseUrl === 'string' && sanitized.aiBaseUrl.length > 0) {
      const validation = await validateAiBaseUrl(
        sanitized.aiBaseUrl,
        String(sanitized.aiProvider ?? ''),
        'AI base URL',
      )
      if (!validation.ok) {
        return problem(c, 'invalid-base-url', 'Invalid AI base URL', 400, validation.message)
      }
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
