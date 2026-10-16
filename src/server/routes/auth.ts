import { lookup } from 'node:dns/promises'
import { Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import {
  encryptChannelSecrets,
  encryptField,
  maskChannelSecrets,
  restoreMaskedChannelSecrets,
  SENSITIVE_PREFERENCES,
} from '@/core/crypto'
import type { NotificationChannel } from '@/core/notifications/types'
import { deleteSession, SessionRotationConflictError } from '@/core/sessions'
import { getLookupHostname, isHttpUrl, isPrivateIp, isPrivateUrl } from '@/core/validation'
import { updateUserPreferences } from '@/db/queries/users'
import { mergePreferences, type Preferences } from '@/db/schema'
import type { AppDependencies } from '@/server'
import { problem } from '@/server/helpers/problem'
import { requireSessionUser } from '@/server/helpers/require-user'
import {
  clearSessionCookie,
  issueSession,
  prepareSessionCookie,
} from '@/server/helpers/session-auth'
import { SESSION_COOKIE_NAME } from '@/server/middleware/session-cookie'
import {
  changePasswordSchema,
  registerSchema,
  updatePreferencesSchema,
} from '@/server/schemas/auth'
import { zJson } from '@/server/schemas/validator'
import type { HonoEnv } from '@/server/types'

const ALLOWED_PREF_KEYS = new Set([
  'scoreThreshold',
  'scoringWeights',
  'rejectionCooldownDays',
  'topArtistsLimit',
  'librarySeedRatio',
  'scheduleCron',
  'webhookUrl',
  'autoApproveEnabled',
  'autoApproveThreshold',
  'autoApproveMonitorOption',
  'dismissedHints',
  'playlistSize',
  'playlistSchedule',
  'fanartApiKey',
  'metadataFallbackUrl',
  'integrationCapabilitiesExpanded',
  'seasonalPlaylistsEnabled',
  'reviewWindowDays',
  'channels',
])

export function authRoutes(deps: AppDependencies) {
  const router = new Hono<HonoEnv>()

  // DJ Llama fork: local password accounts don't exist here. Every account
  // (including the first/admin) is created by signing in with Plex --
  // see routes/auth-plex.ts. Kept as a stub (rather than removing the route)
  // so a stray POST here fails loudly instead of 404ing in a confusing way.
  router.post('/api/v1/auth/register', zJson(registerSchema), async (c) => {
    return c.json({ error: 'Local registration is disabled. Sign in with Plex instead.' }, 403)
  })

  // DJ Llama fork: no local password login, same as /register above. Every
  // account's passwordHash is an unguessable random UUID (see auth-plex.ts),
  // so this was already unusable in practice -- stubbed explicitly anyway
  // for the same "fail loudly, not confusingly" reason as /register.
  router.post('/api/v1/auth/login', async (c) => {
    return c.json({ error: 'Local login is disabled. Sign in with Plex instead.' }, 403)
  })

  router.post('/api/v1/auth/session/migrate', async (c) => {
    const authMethod = c.get('authMethod')
    if (authMethod === 'legacy-bearer') {
      return problem(
        c,
        'auth-session-migration-legacy-token',
        'Legacy token cannot be migrated',
        403,
      )
    }
    if (authMethod !== 'session-bearer') {
      return problem(c, 'auth-session-migration-requires-bearer', 'Bearer session required', 403)
    }

    const auth = requireSessionUser(c)
    if (!auth.ok) return auth.response
    const header = c.req.header('Authorization')
    const bearer = header?.startsWith('Bearer ') ? header.slice(7) : ''
    if (!bearer) {
      return problem(c, 'auth-session-migration-requires-bearer', 'Bearer session required', 403)
    }

    const existingCookie = getCookie(c, SESSION_COOKIE_NAME)
    try {
      const cookie = prepareSessionCookie(c)
      await issueSession(c, auth.userId, {
        kind: 'rotate',
        cookie,
        requiredSourceToken: bearer,
        revokeTokens: existingCookie && existingCookie !== bearer ? [existingCookie] : undefined,
      })
    } catch (error) {
      if (error instanceof SessionRotationConflictError) {
        return problem(c, 'auth-session-migration-conflict', 'Session migration conflict', 409)
      }
      throw error
    }

    return c.body(null, 204)
  })

  // Logout (invalidate all credentials presented by this request)
  router.post('/api/v1/auth/logout', async (c) => {
    const header = c.req.header('Authorization')
    const tokens = new Set<string>()
    if (header?.startsWith('Bearer ') && header.length > 7) {
      tokens.add(header.slice(7))
    }
    const cookieToken = getCookie(c, SESSION_COOKIE_NAME)
    if (cookieToken) tokens.add(cookieToken)
    for (const token of tokens) await deleteSession(token)
    c.header('Cache-Control', 'no-store')
    clearSessionCookie(c)
    return c.body(null, 204)
  })

  router.get('/api/v1/auth/me', async (c) => {
    const userId = c.get('userId')
    if (!userId) {
      return problem(
        c,
        'auth-not-authenticated',
        'Not authenticated',
        401,
        undefined,
        undefined,
        'errors.auth.notAuthenticated',
      )
    }
    const user = await deps.getUserById(userId)
    if (!user) {
      return c.json({ error: 'User not found' }, 404)
    }
    return c.json(user)
  })

  router.get('/api/v1/auth/validate', (c) => {
    const userId = c.get('userId')
    if (!userId) {
      return problem(
        c,
        'auth-not-authenticated',
        'Not authenticated',
        401,
        undefined,
        undefined,
        'errors.auth.notAuthenticated',
      )
    }
    return c.body(null, 204)
  })

  // DJ Llama fork: no local passwords exist to change, same reasoning as
  // /register and /login above.
  router.post('/api/v1/auth/change-password', zJson(changePasswordSchema), async (c) => {
    return c.json({ error: 'Local login is disabled. Sign in with Plex instead.' }, 403)
  })

  // Get the authenticated user's merged preferences
  router.get('/api/v1/auth/me/preferences', async (c) => {
    const userId = c.get('userId')
    if (!userId)
      return problem(
        c,
        'auth-not-authenticated',
        'Not authenticated',
        401,
        undefined,
        undefined,
        'errors.auth.notAuthenticated',
      )
    const user = await deps.getUserById(userId)
    if (!user) return c.json({ error: 'User not found' }, 404)
    const merged = mergePreferences(user.preferences)
    // Sensitive fields are stored encrypted; mask them directly rather than
    // decrypting, since the response never needs the real value.
    const response = { ...merged } as Record<string, unknown>
    for (const key of SENSITIVE_PREFERENCES) {
      const val = response[key]
      if (typeof val === 'string' && val) {
        response[key] = '***'
      }
    }
    // Notification channel secrets must never leave the server (plaintext or
    // ciphertext) -- same masking settings.ts's buildSettingsResponse applies
    // to the global channels.
    if (Array.isArray(response.channels)) {
      response.channels = maskChannelSecrets(response.channels as NotificationChannel[])
    }
    return c.json(response)
  })

  // Update the authenticated user's preferences (partial merge)
  router.patch('/api/v1/auth/me/preferences', zJson(updatePreferencesSchema), async (c) => {
    const auth = requireSessionUser(c)
    if (!auth.ok) return auth.response
    const body = c.req.valid('json')
    const user = await deps.getUserById(auth.userId)
    if (!user) return c.json({ error: 'User not found' }, 404)
    // Filter to allowed preference keys only
    const filtered: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(body)) {
      if (ALLOWED_PREF_KEYS.has(key)) {
        filtered[key] = value
      }
    }

    // SSRF protection: validate metadataFallbackUrl against private IP ranges
    const fallbackUrl = filtered.metadataFallbackUrl
    if (typeof fallbackUrl === 'string' && fallbackUrl) {
      if (!isHttpUrl(fallbackUrl)) {
        return c.json({ error: 'Metadata fallback URL must use http:// or https://' }, 400)
      }
      if (isPrivateUrl(fallbackUrl)) {
        return c.json({ error: 'Metadata fallback URL must not point to a private address' }, 400)
      }
      try {
        const hostname = getLookupHostname(fallbackUrl)
        const { address } = await lookup(hostname)
        if (isPrivateIp(address)) {
          return c.json({ error: 'Metadata fallback URL resolves to a private/internal IP' }, 400)
        }
      } catch {
        return c.json({ error: 'Could not resolve metadata fallback URL hostname' }, 400)
      }
    }

    // Restore masked channel secrets from the user's own stored (encrypted)
    // channel of the same id, then encrypt any new plaintext secrets before
    // persistence -- same pattern settings.ts's PATCH handler uses for the
    // global channels, just scoped to this user's own stored preferences
    // instead of the global settings row.
    if (Array.isArray(filtered.channels)) {
      const storedChannels = (user.preferences as Record<string, unknown> | null)?.channels as
        | NotificationChannel[]
        | undefined
      const byId = new Map((storedChannels ?? []).map((ch) => [ch.id, ch]))
      const restored = restoreMaskedChannelSecrets(filtered.channels as NotificationChannel[], byId)
      filtered.channels = encryptChannelSecrets(restored)
    }

    // Encrypt sensitive preference values before storage (skip masked placeholders)
    for (const key of SENSITIVE_PREFERENCES) {
      const val = filtered[key]
      if (val === '***') {
        delete filtered[key]
      } else if (typeof val === 'string' && val) {
        filtered[key] = encryptField(val)
      }
    }

    // Merge incoming with existing to preserve fields not being updated
    const current = (user.preferences ?? {}) as Record<string, unknown>
    const updated = { ...current, ...filtered }
    await updateUserPreferences(deps.db, auth.userId, updated as Preferences)
    return c.body(null, 204)
  })

  return router
}
