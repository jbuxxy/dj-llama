import { Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import * as z from 'zod'
import { envConfig } from '@/config/env'
import {
  buildPlexAuthAppUrl,
  checkPlexPin,
  createPlexPin,
  getPlexAccount,
  getPlexLibrarySections,
  listOwnedPlexServers,
  type OwnedPlexServer,
  type PlexLibrarySection,
  type ResolvedPlexServer,
  resolvePlexServerConnection,
} from '@/core/auth/plex'
import { createLidarrClient } from '@/core/clients/lidarr'
import {
  decryptChannelSecrets,
  encryptChannelSecrets,
  maskChannelSecrets,
  restoreMaskedChannelSecrets,
} from '@/core/crypto'
import { dispatch } from '@/core/notifications'
import type { NotificationChannel, NotificationEvent } from '@/core/notifications/types'
import { redactSecrets } from '@/core/providers/retry'
import { validateAiBaseUrl } from '@/core/url-safety'
import { disableSystemTarget, upsertSystemTarget } from '@/db/queries/targets'
import { getUserConnections, updateUserConnections } from '@/db/queries/users'
import { mergePreferences, type Preferences } from '@/db/schema'
import type { AppDependencies } from '@/server'
import { problem } from '@/server/helpers/problem'
import { adminGuard, resolveAdmin } from '@/server/middleware/admin-guard'
import { browserCookieSecure } from '@/server/middleware/session-cookie'
import { notificationChannel, updateSettingsSchema } from '@/server/schemas/settings'
import { zJson } from '@/server/schemas/validator'
import type { HonoEnv } from '@/server/types'

// Admin-triggered "change server" reconfiguration. Mirrors the shape of the
// first-login bootstrap flow in auth-plex.ts (select-server -> select-library
// -> finalize), but for an *already-configured* install: an admin explicitly
// re-authenticates with Plex (there's no way to re-list an account's servers
// without a fresh identity token, since only the server-scoped access token
// is ever persisted -- see auth-plex.ts's PendingBootstrap comment), then
// picks which server/libraries to point the whole app at from here on.
// Deliberately separate in-memory state from auth-plex.ts's pendingBootstraps
// -- different trigger (admin action vs. first login), different finalize
// side effects (overwrite existing global config vs. create the owner).
const PLEX_RECONFIG_PIN_COOKIE = 'djllama_plex_reconfig_pin'
const PLEX_RECONFIG_COOKIE = 'djllama_plex_reconfig'
const PLEX_RECONFIG_PIN_MAX_AGE_S = 10 * 60
const PLEX_RECONFIG_TTL_MS = 10 * 60 * 1000

type PendingPlexReconfig =
  | { stage: 'select-server'; identityToken: string; servers: OwnedPlexServer[]; createdAt: number }
  | {
      stage: 'select-library'
      server: ResolvedPlexServer
      sections: PlexLibrarySection[]
      createdAt: number
    }
const pendingPlexReconfigs = new Map<string, PendingPlexReconfig>()

function sweepExpiredPlexReconfigs() {
  const cutoff = Date.now() - PLEX_RECONFIG_TTL_MS
  for (const [id, entry] of pendingPlexReconfigs) {
    if (entry.createdAt < cutoff) pendingPlexReconfigs.delete(id)
  }
}

async function resolvePlexReconfigLibraryStage(
  identityToken: string,
  machineIdentifier: string,
): Promise<{ server: ResolvedPlexServer; sections: PlexLibrarySection[] } | null> {
  const server = await resolvePlexServerConnection(identityToken, machineIdentifier)
  if (!server) return null
  const sections = await getPlexLibrarySections(server.url, server.accessToken)
  return { server, sections }
}

const plexReconfigSelectServerSchema = z.object({ machineIdentifier: z.string().min(1) })
const plexReconfigSelectLibrarySchema = z.object({ sectionIds: z.array(z.string()).min(1) })
const plexLibrarySectionsSchema = z.object({ sectionIds: z.array(z.string()).min(1) })

const SECRET_FIELDS = [
  'lidarrApiKey',
  'aiApiKey',
  'audiodbApiKey',
  'lastfmApiKey',
  'plexToken',
] as const

type SettingsResponse = Record<string, unknown>

function maskSecrets(settings: Record<string, unknown>): SettingsResponse {
  const masked: SettingsResponse = { ...settings }
  for (const field of SECRET_FIELDS) {
    if (typeof masked[field] === 'string' && masked[field].length > 0) {
      masked[field] = '***'
    }
  }
  return masked
}

function mergePreferenceUpdate(
  current: Partial<Preferences> | null | undefined,
  incoming: Partial<Preferences>,
): Partial<Preferences> {
  const merged: Partial<Preferences> = {
    ...(current ?? {}),
    ...incoming,
  }

  if (current?.scoringWeights && incoming.scoringWeights) {
    merged.scoringWeights = {
      ...current.scoringWeights,
      ...incoming.scoringWeights,
    }
  }

  return merged
}

type ProbeTestResult = {
  success: boolean
  message: string
  details?: Record<string, unknown>
}

// Returns a problem+json response on probe failure. The upstream failure
// message is surfaced as `detail` (secrets redacted, whitespace collapsed,
// length capped) so admins can act on it - a bare "unknown error" hides the
// provider body that names the missing model or malformed field.
function probeResult(
  c: Parameters<typeof problem>[0],
  result: ProbeTestResult,
  fallbackMessage: string,
  latencyMs?: number,
) {
  if (result.success) {
    const version = result.details?.version
    // Whitelisted structured extras (the Plex library picker): never spread
    // details wholesale, probes may stash internals there.
    const sectionId = result.details?.sectionId
    const sections = result.details?.sections
    const models = result.details?.models
    return c.json(
      {
        message: result.message,
        ...(typeof version === 'string' && version.length > 0 ? { version } : {}),
        ...(typeof latencyMs === 'number' ? { latencyMs } : {}),
        ...(typeof sectionId === 'string' ? { sectionId } : {}),
        ...(Array.isArray(sections) ? { sections } : {}),
        ...(Array.isArray(models) ? { models } : {}),
      },
      200,
    )
  }
  const detail =
    redactSecrets(result.message ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 300) || fallbackMessage
  return problem(c, 'probe-failed', 'Probe failed', 502, detail, undefined, 'common.unknownError')
}

async function runProbe(
  c: Parameters<typeof problem>[0],
  probe: () => Promise<ProbeTestResult>,
  fallbackMessage: string,
) {
  const startedAt = performance.now()
  const result = await probe()
  return probeResult(
    c,
    result,
    fallbackMessage,
    Math.max(0, Math.round(performance.now() - startedAt)),
  )
}

/** Strip global connection fields that should not leak to non-admin users. */
function stripForNonAdmin(settings: Record<string, unknown>): SettingsResponse {
  const stripped: SettingsResponse = {}

  // Non-admins see: lidarrUrl (read-only context), aiProvider, aiModel (no keys),
  // setupComplete, preferences (for scoring weights), skipTlsVerify
  const ALLOWED_GLOBAL = new Set([
    'id',
    'setupComplete',
    'lidarrUrl',
    'aiProvider',
    'aiModel',
    'skipTlsVerify',
    'preferences',
  ])

  for (const [key, val] of Object.entries(settings)) {
    if (ALLOWED_GLOBAL.has(key) || key.startsWith('_')) {
      stripped[key] = val
    }
  }
  // Whether Last.fm discovery is on is shown to everyone; the key never is.
  if (settings.lastfmApiKey) stripped.lastfmApiKey = '***'

  // Strip webhook URL and notification channels (secret-bearing) from
  // preferences for non-admins - notification config is admin-only.
  if (stripped.preferences && typeof stripped.preferences === 'object') {
    const prefs = { ...(stripped.preferences as Record<string, unknown>) }
    delete prefs.webhookUrl
    delete prefs.channels
    // Keep scheduleCron visible but not editable (frontend hides the tab)
    stripped.preferences = prefs
  }

  return stripped
}

async function buildSettingsResponse(
  deps: AppDependencies,
  userId: number | undefined,
  isAdmin: boolean,
): Promise<Record<string, unknown> | null> {
  const row = await deps.getSettings()
  if (!row) return null

  let response: Record<string, unknown> = { ...row }

  // Non-admins get a stripped view of global settings
  if (!isAdmin) {
    response = stripForNonAdmin(response)
  }

  if (userId) {
    const userConns = await getUserConnections(deps.db, userId)
    if (userConns) {
      response.plexUrl = userConns.plexUrl ?? ''
      response.plexToken = userConns.plexToken
      response.plexSectionId = userConns.plexSectionId ?? ''
      response._plexScope = 'user'
    }
  }

  // Notification channel secrets must never leave the server (plaintext OR
  // ciphertext). Mask them in a copied preferences object so the stored row is
  // not mutated. Non-admins already had channels stripped above.
  if (response.preferences && typeof response.preferences === 'object') {
    const prefs = { ...(response.preferences as Record<string, unknown>) }
    if (Array.isArray(prefs.channels)) {
      prefs.channels = maskChannelSecrets(prefs.channels as NotificationChannel[])
      response.preferences = prefs
    }
  }

  return response
}

export function settingsRoutes(deps: AppDependencies) {
  const router = new Hono<HonoEnv>()

  router.get('/api/v1/settings', async (c) => {
    const userId = c.get('userId')
    const isAdmin = await resolveAdmin(
      userId,
      deps.getUserById,
      c.get('authSkipped'),
      c.get('legacyTokenAuth'),
    )
    const response = await buildSettingsResponse(deps, userId, isAdmin)
    if (!response) {
      return c.json({ error: 'Settings not found' }, 404)
    }
    return c.json(maskSecrets(response))
  })

  // The Plex server's human-assigned "friendlyName" isn't stored anywhere --
  // it's read live from the server itself so it stays correct if renamed.
  // Best-effort: any failure (server offline, no connection yet) just yields
  // null rather than an error, since this is cosmetic (Settings display).
  router.get('/api/v1/settings/plex-server-name', async (c) => {
    const userId = c.get('userId')
    const userConns = userId ? await getUserConnections(deps.db, userId) : null
    if (!userConns?.plexUrl || !userConns?.plexToken) {
      return c.json({ name: null })
    }
    const { createPlexClient } = await import('@/core/clients/plex')
    const client = createPlexClient(userConns.plexUrl, userConns.plexToken)
    const name = await client.getServerName()
    return c.json({ name })
  })

  // Change library: no re-auth needed, the admin server connection is
  // already known-good -- just re-list its sections fresh (so a library
  // added/renamed in Plex since initial setup shows up) and let the admin
  // re-pick which one(s) count as Music.
  router.get('/api/v1/settings/plex/library-sections', adminGuard(deps.getUserById), async (c) => {
    const settings = await deps.getSettings()
    if (!settings?.plexAdminUrl || !settings.plexAdminToken) {
      return problem(c, 'plex-not-configured', 'Plex is not configured yet', 400)
    }
    const sections = await getPlexLibrarySections(settings.plexAdminUrl, settings.plexAdminToken)
    return c.json({
      sections: sections.map((s) => ({ id: s.id, title: s.title, type: s.type })),
      currentSectionIds: settings.plexMusicSectionIds ?? [],
    })
  })

  router.post(
    '/api/v1/settings/plex/library-sections',
    adminGuard(deps.getUserById),
    zJson(plexLibrarySectionsSchema),
    async (c) => {
      const settings = await deps.getSettings()
      if (!settings?.plexAdminUrl || !settings.plexAdminToken) {
        return problem(c, 'plex-not-configured', 'Plex is not configured yet', 400)
      }
      const { sectionIds } = c.req.valid('json')
      const sections = await getPlexLibrarySections(settings.plexAdminUrl, settings.plexAdminToken)
      const validIds = new Set(sections.map((s) => s.id))
      if (!sectionIds.every((id) => validIds.has(id))) {
        return problem(c, 'plex-invalid-section', 'Invalid library section', 400)
      }
      await deps.updateSettings({ plexMusicSectionIds: sectionIds })
      const userId = c.get('userId')
      if (userId) {
        await updateUserConnections(deps.db, userId, { plexSectionId: sectionIds[0] ?? null })
      }
      return c.json({ success: true })
    },
  )

  // Change server: the account-level Plex identity token is never persisted
  // (only the server-scoped access token is, once a server's picked -- see
  // auth-plex.ts), so there's no way to re-list an account's servers without
  // a fresh real Plex sign-in. This re-runs that same PIN-based handshake,
  // admin-gated and separate from the public sign-in flow.
  router.post(
    '/api/v1/settings/plex/reconfigure/start',
    adminGuard(deps.getUserById),
    async (c) => {
      const pin = await createPlexPin()
      setCookie(c, PLEX_RECONFIG_PIN_COOKIE, String(pin.id), {
        httpOnly: true,
        secure: browserCookieSecure(c),
        sameSite: 'Lax',
        path: '/api/v1/settings/plex/reconfigure',
        maxAge: PLEX_RECONFIG_PIN_MAX_AGE_S,
      })
      const origin = envConfig.allowedOrigin || new URL(c.req.url).origin
      // ?sameTab=1 (car browsers, framed app): Plex returns the whole tab to
      // Settings, where the admin controls resume polling from the PIN cookie.
      const sameTab = c.req.query('sameTab') === '1'
      const forwardUrl = sameTab
        ? `${origin}/settings?plexReconfigureReturn=1`
        : `${origin}/?plexAuthWindow=1`
      return c.json({ authAppUrl: buildPlexAuthAppUrl(pin.code, forwardUrl) })
    },
  )

  router.get('/api/v1/settings/plex/reconfigure/poll', adminGuard(deps.getUserById), async (c) => {
    const pinId = getCookie(c, PLEX_RECONFIG_PIN_COOKIE)
    if (!pinId) return problem(c, 'plex-no-pin', 'No Plex sign-in in progress', 400)

    let identityToken: string | null
    try {
      identityToken = await checkPlexPin(Number(pinId))
    } catch {
      return problem(c, 'plex-unreachable', 'Could not reach Plex', 502)
    }
    if (!identityToken) return c.json({ status: 'pending' })
    deleteCookie(c, PLEX_RECONFIG_PIN_COOKIE, { path: '/api/v1/settings/plex/reconfigure' })

    try {
      await getPlexAccount(identityToken) // verifies the identity token resolves at all
      const owned = await listOwnedPlexServers(identityToken)
      if (owned.length === 0) {
        return problem(
          c,
          'plex-not-owner',
          'This Plex account does not own a server',
          403,
          'Sign in with the Plex account that owns the server DJ Llama should connect to.',
        )
      }

      sweepExpiredPlexReconfigs()
      const reconfigId = crypto.randomUUID()

      if (owned.length > 1) {
        pendingPlexReconfigs.set(reconfigId, {
          stage: 'select-server',
          identityToken,
          servers: owned,
          createdAt: Date.now(),
        })
        setCookie(c, PLEX_RECONFIG_COOKIE, reconfigId, {
          httpOnly: true,
          secure: browserCookieSecure(c),
          sameSite: 'Lax',
          path: '/api/v1/settings/plex/reconfigure',
          maxAge: PLEX_RECONFIG_TTL_MS / 1000,
        })
        return c.json({ status: 'select-server', servers: owned })
      }

      const firstOwned = owned[0]
      if (!firstOwned) throw new Error('unreachable: owned.length === 1')
      const resolved = await resolvePlexReconfigLibraryStage(
        identityToken,
        firstOwned.machineIdentifier,
      )
      if (!resolved) {
        return problem(
          c,
          'plex-no-server',
          'No Plex server found',
          403,
          'Could not connect to your Plex server. It may be offline.',
        )
      }
      pendingPlexReconfigs.set(reconfigId, {
        stage: 'select-library',
        server: resolved.server,
        sections: resolved.sections,
        createdAt: Date.now(),
      })
      setCookie(c, PLEX_RECONFIG_COOKIE, reconfigId, {
        httpOnly: true,
        secure: browserCookieSecure(c),
        sameSite: 'Lax',
        path: '/api/v1/settings/plex/reconfigure',
        maxAge: PLEX_RECONFIG_TTL_MS / 1000,
      })
      return c.json({
        status: 'select-library',
        sections: resolved.sections.map((s) => ({ id: s.id, title: s.title, type: s.type })),
      })
    } catch (err) {
      console.warn('[settings/plex/reconfigure] failed:', err)
      return problem(c, 'plex-reconfigure-failed', 'Plex reconfiguration failed', 502)
    }
  })

  router.post(
    '/api/v1/settings/plex/reconfigure/select-server',
    adminGuard(deps.getUserById),
    zJson(plexReconfigSelectServerSchema),
    async (c) => {
      const reconfigId = getCookie(c, PLEX_RECONFIG_COOKIE)
      if (!reconfigId)
        return problem(c, 'plex-no-reconfig', 'No Plex reconfiguration in progress', 400)
      sweepExpiredPlexReconfigs()
      const pending = pendingPlexReconfigs.get(reconfigId)
      if (pending?.stage !== 'select-server') {
        return problem(c, 'plex-reconfig-expired', 'Plex reconfiguration expired', 400)
      }

      const { machineIdentifier } = c.req.valid('json')
      const chosen = pending.servers.find((s) => s.machineIdentifier === machineIdentifier)
      if (!chosen) {
        return problem(c, 'plex-invalid-server', 'Invalid server selection', 400)
      }

      const resolved = await resolvePlexReconfigLibraryStage(
        pending.identityToken,
        machineIdentifier,
      )
      if (!resolved) {
        return problem(
          c,
          'plex-no-server',
          'No Plex server found',
          403,
          'Could not connect to that Plex server. It may be offline.',
        )
      }

      pendingPlexReconfigs.set(reconfigId, {
        stage: 'select-library',
        server: resolved.server,
        sections: resolved.sections,
        createdAt: Date.now(),
      })
      return c.json({
        status: 'select-library',
        sections: resolved.sections.map((s) => ({ id: s.id, title: s.title, type: s.type })),
      })
    },
  )

  router.post(
    '/api/v1/settings/plex/reconfigure/select-library',
    adminGuard(deps.getUserById),
    zJson(plexReconfigSelectLibrarySchema),
    async (c) => {
      const reconfigId = getCookie(c, PLEX_RECONFIG_COOKIE)
      if (!reconfigId)
        return problem(c, 'plex-no-reconfig', 'No Plex reconfiguration in progress', 400)
      sweepExpiredPlexReconfigs()
      const pending = pendingPlexReconfigs.get(reconfigId)
      if (pending?.stage !== 'select-library') {
        return problem(c, 'plex-reconfig-expired', 'Plex reconfiguration expired', 400)
      }

      const { sectionIds } = c.req.valid('json')
      const validIds = new Set(pending.sections.map((s) => s.id))
      if (!sectionIds.every((id) => validIds.has(id))) {
        return problem(c, 'plex-invalid-section', 'Invalid library section', 400)
      }

      pendingPlexReconfigs.delete(reconfigId)
      deleteCookie(c, PLEX_RECONFIG_COOKIE, { path: '/api/v1/settings/plex/reconfigure' })

      const { server } = pending
      await deps.updateSettings({
        plexAdminUrl: server.url,
        plexAdminToken: server.accessToken,
        plexMachineIdentifier: server.machineIdentifier,
        plexMusicSectionIds: sectionIds,
      })
      const userId = c.get('userId')
      if (userId) {
        await updateUserConnections(deps.db, userId, {
          plexUrl: server.url,
          plexToken: server.accessToken,
          plexSectionId: sectionIds[0] ?? null,
        })
      }
      return c.json({ status: 'complete' })
    },
  )

  const GLOBAL_MUTABLE_FIELDS = new Set([
    'lidarrUrl',
    'lidarrApiKey',
    'skipTlsVerify',
    'librarySyncIntervalHours',
    'aiProvider',
    'aiApiKey',
    'aiModel',
    'aiBaseUrl',
    'audiodbApiKey',
    'lastfmApiKey',
    'audiodbProxyImages',
    'wikidataEnabled',
    'preferences',
  ])

  // plexUrl/plexToken/plexSectionId are intentionally excluded -- auto-managed
  // by the Plex login flow (auth-plex.ts), read-only in Settings. No other
  // per-user connection fields exist today; this stays as the generic split
  // point for whenever the next one does.
  const USER_CONNECTION_FIELDS = new Set<string>([])

  const ALL_MUTABLE_FIELDS = new Set([...GLOBAL_MUTABLE_FIELDS, ...USER_CONNECTION_FIELDS])

  router.patch('/api/v1/settings', zJson(updateSettingsSchema), async (c) => {
    const body = c.req.valid('json')
    const sanitized: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      if (value === undefined) continue
      if (ALL_MUTABLE_FIELDS.has(key)) {
        sanitized[key] = value
      }
    }

    const userId = c.get('userId')
    const isAdmin = await resolveAdmin(
      userId,
      deps.getUserById,
      c.get('authSkipped'),
      c.get('legacyTokenAuth'),
    )
    const storedSettings =
      Object.hasOwn(sanitized, 'preferences') || Object.hasOwn(sanitized, 'skipTlsVerify')
        ? await deps.getSettings()
        : null

    // Split fields into user-connection vs global
    const userUpdate: Record<string, string | null> = {}
    const globalFields: Record<string, unknown> = {}

    for (const [key, val] of Object.entries(sanitized)) {
      if (USER_CONNECTION_FIELDS.has(key)) {
        if (userId) {
          userUpdate[key] = (val as string | null | undefined) ?? null
        }
        continue
      }
      globalFields[key] = val
    }

    const incomingPrefs =
      globalFields.preferences && typeof globalFields.preferences === 'object'
        ? (globalFields.preferences as Partial<Preferences>)
        : undefined

    // Restore masked channel secrets from the stored (encrypted) channel of the
    // same id, then encrypt any new plaintext secrets before persistence. Keeps
    // channel botToken/token/urls encrypted at rest in the settings row.
    if (incomingPrefs && Array.isArray(incomingPrefs.channels)) {
      const byId = new Map((storedSettings?.preferences?.channels ?? []).map((ch) => [ch.id, ch]))
      const restored = restoreMaskedChannelSecrets(incomingPrefs.channels, byId)
      incomingPrefs.channels = encryptChannelSecrets(restored)
    }

    if (incomingPrefs) {
      globalFields.preferences = mergePreferenceUpdate(storedSettings?.preferences, incomingPrefs)
    }

    if (!isAdmin && Object.keys(globalFields).length > 0) {
      return c.json({ error: 'Admin access required to modify global settings' }, 403)
    }

    if (typeof globalFields.aiBaseUrl === 'string' && globalFields.aiBaseUrl.length > 0) {
      // The admin may patch aiProvider in the same request, or rely on the existing stored
      // provider. Use the incoming provider when present so the validation matches the
      // post-save state, otherwise fall back to what's persisted.
      const provider =
        typeof globalFields.aiProvider === 'string' && globalFields.aiProvider.length > 0
          ? globalFields.aiProvider
          : ((await deps.getSettings())?.aiProvider ?? '')
      const validation = await validateAiBaseUrl(
        globalFields.aiBaseUrl,
        provider as string,
        'AI base URL',
      )
      if (!validation.ok) {
        return problem(c, 'invalid-base-url', 'Invalid AI base URL', 400, validation.message)
      }
    }

    if (userId && Object.keys(userUpdate).length > 0) {
      await updateUserConnections(deps.db, userId, userUpdate)
    }

    if (Object.keys(globalFields).length > 0) {
      await deps.updateSettings(globalFields)
    }

    // Keep the system Lidarr target (see db/queries/targets.ts) in sync with
    // settings.lidarrUrl/apiKey/skipTlsVerify -- getEnabledTargetsForResolvedUser
    // dispatches using this row's cached config, not settings directly, so
    // without this an admin rotating their Lidarr API key or URL here would
    // silently keep dispatching to the old one until the row is touched some
    // other way (previously only initial setup and a one-time boot backfill
    // wrote it).
    if (
      'lidarrUrl' in globalFields ||
      'lidarrApiKey' in globalFields ||
      'skipTlsVerify' in globalFields
    ) {
      const current = await deps.getSettings()
      const url = current?.lidarrUrl as string | undefined
      const apiKey = current?.lidarrApiKey as string | undefined
      if (url && apiKey) {
        await upsertSystemTarget(deps.db, 'lidarr', 'Lidarr', {
          url,
          apiKey,
          skipTlsVerify: (current?.skipTlsVerify as boolean) ?? false,
        })
      } else {
        await disableSystemTarget(deps.db, 'lidarr')
      }
    }

    if (
      incomingPrefs?.scheduleCron !== undefined &&
      typeof incomingPrefs.scheduleCron === 'string'
    ) {
      try {
        deps.restartScheduler(incomingPrefs.scheduleCron || null)
      } catch (err: unknown) {
        console.error('Failed to apply cron expression:', err)
        const row = await buildSettingsResponse(deps, userId, isAdmin)
        return c.json({
          ...maskSecrets((row ?? {}) as Record<string, unknown>),
          warning: 'Settings saved but cron expression is invalid',
        })
      }
    }

    if (incomingPrefs?.digestCron !== undefined) {
      try {
        await deps.restartDigestNotifier?.()
      } catch (err: unknown) {
        console.error('Failed to apply digest cron expression:', err)
        const row = await buildSettingsResponse(deps, userId, isAdmin)
        return c.json({
          ...maskSecrets((row ?? {}) as Record<string, unknown>),
          warning: 'Settings saved but cron expression is invalid',
        })
      }
    }

    // aiProvider/aiModel gate whether ai_prompt playlists get scheduled at
    // all (restartPlaylistScheduler) -- restart so configuring AI picks
    // previously-skipped ai_prompt rows back up immediately.
    if (
      incomingPrefs?.playlistSchedule !== undefined ||
      globalFields.aiProvider !== undefined ||
      globalFields.aiModel !== undefined
    ) {
      await deps.restartPlaylistScheduler()
    }

    if (typeof sanitized.librarySyncIntervalHours === 'number') {
      deps.restartLibraryMaintenanceScheduler?.(sanitized.librarySyncIntervalHours)
    }

    const response = await buildSettingsResponse(deps, userId, isAdmin)
    if (!response) {
      return c.json({ error: 'Settings not found' }, 404)
    }
    return c.json(maskSecrets(response))
  })

  router.post('/api/v1/settings/test/:service', async (c) => {
    const service = c.req.param('service')
    const isAdmin = await resolveAdmin(
      c.get('userId'),
      deps.getUserById,
      c.get('authSkipped'),
      c.get('legacyTokenAuth'),
    )
    if (!isAdmin) {
      return problem(
        c,
        'admin-required',
        'Admin access required',
        403,
        undefined,
        undefined,
        'common.adminAccessRequired',
      )
    }

    const body = await c.req.json()
    const testUserId = c.get('userId')

    // Fall back to stored credentials when the request sends empty keys
    const stored = await deps.getSettings()
    const userConns = testUserId ? await getUserConnections(deps.db, testUserId) : null

    const missingInput = (message: string) =>
      problem(c, 'probe-missing-input', 'Missing probe input', 400, message)

    switch (service) {
      case 'lidarr': {
        const url = body.url || (stored?.lidarrUrl as string) || ''
        const apiKey = body.apiKey || (stored?.lidarrApiKey as string) || ''
        if (!url || !apiKey) {
          return missingInput(`Missing ${!url ? 'URL' : 'API key'}`)
        }
        const client = createLidarrClient(url, apiKey, body.skipTlsVerify)
        return runProbe(c, () => client.testConnection(), 'Unknown error')
      }
      case 'ai': {
        try {
          // Admin check above gates the stored-apiKey fallback: legacy tokens
          // and non-admin sessions cannot reach this branch, so we will never
          // leak a stored credential to a lower-privilege caller.
          const effectiveProvider = body.provider || (stored?.aiProvider as string) || ''
          const effectiveBaseUrl = body.baseUrl || (stored?.aiBaseUrl as string) || ''
          if (effectiveBaseUrl) {
            const validation = await validateAiBaseUrl(
              effectiveBaseUrl,
              effectiveProvider,
              'AI base URL',
            )
            if (!validation.ok) {
              return problem(c, 'invalid-base-url', 'Invalid AI base URL', 400, validation.message)
            }
          }
          const provider = await deps.providerRegistry.create(effectiveProvider, {
            apiKey: body.apiKey || (stored?.aiApiKey as string) || null,
            model: body.model || (stored?.aiModel as string) || '',
            baseUrl: effectiveBaseUrl || null,
            timeoutSeconds: envConfig.aiTimeoutSeconds ?? null,
          })
          return runProbe(c, () => provider.testConnection(), 'Unknown error')
        } catch (_err: unknown) {
          return problem(
            c,
            'probe-failed',
            'Probe failed',
            502,
            'Unknown error',
            undefined,
            'common.unknownError',
          )
        }
      }
      case 'ai-ollama-models': {
        const effectiveBaseUrl = body.baseUrl || (stored?.aiBaseUrl as string) || ''
        if (!effectiveBaseUrl) return missingInput('Missing base URL')
        const validation = await validateAiBaseUrl(effectiveBaseUrl, 'ollama', 'AI base URL')
        if (!validation.ok) {
          return problem(c, 'invalid-base-url', 'Invalid AI base URL', 400, validation.message)
        }
        const { probeOllamaModels } = await import('@/core/providers/ollama')
        return runProbe(
          c,
          async () => {
            const result = await probeOllamaModels(effectiveBaseUrl)
            return {
              success: result.success,
              message: result.message,
              details: { models: result.models },
            }
          },
          'Unknown error',
        )
      }
      case 'plex': {
        const url = body.url || userConns?.plexUrl || ''
        const token = body.token || userConns?.plexToken || ''
        // sectionId: '' in the body means "auto-detect" (do not fall back to
        // the stored value, the user is explicitly clearing it in the picker).
        const sectionId =
          typeof body.sectionId === 'string' ? body.sectionId : (userConns?.plexSectionId ?? null)
        if (!url || !token) {
          return missingInput(`Missing ${!url ? 'URL' : 'token'}`)
        }
        const { createPlexClient } = await import('@/core/clients/plex')
        const client = createPlexClient(url, token, { sectionId })
        return runProbe(c, () => client.testConnection(), 'Unknown error')
      }
      case 'lastfm': {
        const apiKey = body.apiKey || (stored?.lastfmApiKey as string) || ''
        if (!apiKey) return missingInput('Missing API key')
        const { createLastFmClient } = await import('@/core/clients/lastfm')
        return runProbe(c, () => createLastFmClient(apiKey).testConnection(), 'Unknown error')
      }
      default:
        return problem(c, 'unknown-service', `Unknown service: ${service}`, 400)
    }
  })

  router.post('/api/v1/settings/test-webhook', async (c) => {
    const userId = c.get('userId')
    if (
      !(await resolveAdmin(
        userId,
        deps.getUserById,
        c.get('authSkipped'),
        c.get('legacyTokenAuth'),
      ))
    ) {
      return problem(
        c,
        'admin-required',
        'Admin access required',
        403,
        undefined,
        undefined,
        'common.adminAccessRequired',
      )
    }

    const stored = await deps.getSettings()
    const merged = mergePreferences(stored?.preferences)
    const storedChannels = merged.channels ?? []
    const byId = new Map(storedChannels.map((ch) => [ch.id, ch]))

    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    const requestedId =
      c.req.query('id') ?? (typeof body.id === 'string' ? (body.id as string) : undefined)

    // Resolve the channel under test: an inline config posted from the editor
    // (may carry '***' placeholders to restore from the stored channel), an
    // explicit id, or the first stored channel as a fallback.
    let resolved: NotificationChannel | undefined
    if (typeof body.type === 'string' && typeof body.id === 'string') {
      const parsed = notificationChannel.safeParse(body)
      if (!parsed.success) {
        return problem(
          c,
          'invalid-channel',
          'Invalid notification channel',
          400,
          undefined,
          undefined,
          'common.unknownError',
        )
      }
      const [restored] = restoreMaskedChannelSecrets([parsed.data], byId)
      resolved = restored
    } else if (requestedId) {
      resolved = byId.get(requestedId)
    } else {
      resolved = storedChannels[0]
    }

    if (!resolved) {
      return problem(
        c,
        'webhook-not-configured',
        'No notification channel configured',
        400,
        undefined,
        undefined,
        'common.unknownError',
      )
    }

    // Decrypt stored/restored ciphertext (plaintext inline values pass through),
    // then force enabled + batch_complete so a Test button works even on a
    // disabled or not-yet-subscribed channel.
    const [decrypted] = decryptChannelSecrets([resolved])
    const testEvents: NotificationEvent[] = ['batch_complete']
    const channel = { ...decrypted, enabled: true, events: testEvents } as NotificationChannel

    const [result] = await dispatch([channel], 'batch_complete', {
      event: 'batch_complete',
      batchId: 0,
      stats: { discovered: 3, added: 3, failed: 0 },
      message: 'Test notification from DJ Llama.',
      timestamp: new Date().toISOString(),
    })
    if (result?.ok) {
      return c.body(null, 204)
    }
    const detail =
      redactSecrets(result?.error ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 300) || 'Notification test failed'
    return problem(
      c,
      'webhook-test-failed',
      'Webhook test failed',
      502,
      detail,
      undefined,
      'common.unknownError',
    )
  })

  return router
}
