import { Hono } from 'hono'
import type { AlbumCoverage } from '@/core/library/album-coverage'
import type { LibraryHealthService } from '@/core/library/health'
import { reconcileFulfillment } from '@/core/library/reconcile-fulfillment'
import type { SkyHookWarmer } from '@/core/library/skyhook-warmer'
import type { LibrarySyncStore } from '@/core/library/store'
import { SOURCE_NOT_CONFIGURED_ERROR, type SyncOrchestrator } from '@/core/library/sync'
import type { HealthCheckId } from '@/core/library/types'
import { errMsg, logAndSanitize } from '@/core/validation'
import type { Database } from '@/db'
import { requireAdmin, requireSessionUser } from '@/server/helpers/require-user'
import { rateLimiter } from '@/server/middleware/rate-limit'
import {
  libraryAlbumOverrideSchema,
  libraryOverrideSchema,
  librarySyncSchema,
  libraryWarmSchema,
} from '@/server/schemas/library'
import { zJson } from '@/server/schemas/validator'
import type { HonoEnv } from '@/server/types'

const VALID_CHECK_IDS: Set<string> = new Set(['missing-albums', 'genre-gaps'])
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type LibraryRouteDeps = {
  db: Database
  libraryHealth: LibraryHealthService
  skyhookWarmer?: SkyHookWarmer | null
  librarySync: SyncOrchestrator
  librarySyncStore: LibrarySyncStore
  getSettings: () => Promise<{ librarySyncIntervalHours?: number } | null>
  albumCoverage: {
    getCoverageForArtist: (userId: number, artistMbid: string) => Promise<AlbumCoverage>
  }
  getUserById: (id: number) => Promise<{ isAdmin: boolean } | null>
}

export function libraryRoutes(deps: LibraryRouteDeps) {
  const app = new Hono<HonoEnv>()

  const adminGate = (c: Parameters<typeof requireAdmin>[0]) => requireAdmin(c, deps.getUserById)

  app.get('/api/v1/library/health', async (c) => {
    const auth = await adminGate(c)
    if (!auth.ok) return auth.response
    const [state, settings] = await Promise.all([deps.libraryHealth.getState(), deps.getSettings()])
    return c.json({
      // Saved results can predate a check's removal; show only current ones.
      checks: (state?.checks ?? []).filter((check) => VALID_CHECK_IDS.has(check.id)),
      scanning: deps.libraryHealth.scanning,
      lastStartedAt: state?.lastStartedAt?.toISOString() ?? null,
      lastCompletedAt: state?.lastCompletedAt?.toISOString() ?? null,
      lastError: state?.lastError ?? null,
      syncIntervalHours: settings?.librarySyncIntervalHours ?? 6,
    })
  })

  app.post('/api/v1/library/health/scan', async (c) => {
    const auth = await adminGate(c)
    if (!auth.ok) return auth.response
    deps.libraryHealth.startScan()
    return c.json({ scanning: true }, 202)
  })

  app.post('/api/v1/library/health/:checkId/fix', async (c) => {
    const auth = await adminGate(c)
    if (!auth.ok) return auth.response
    const checkId = c.req.param('checkId')
    if (!VALID_CHECK_IDS.has(checkId)) {
      return c.json({ error: 'Invalid check ID' }, 400)
    }
    try {
      const progress = await deps.libraryHealth.fixCheck(checkId as HealthCheckId)
      return c.json(progress)
    } catch (err: unknown) {
      return c.json({ error: logAndSanitize(err, 'library-health-fix') }, 400)
    }
  })

  app.get('/api/v1/library/stats', async (c) => {
    const auth = await adminGate(c)
    if (!auth.ok) return auth.response
    const stats = await deps.libraryHealth.getStats()
    return c.json(stats)
  })

  app.post('/api/v1/library/warm', zJson(libraryWarmSchema), async (c) => {
    const auth = await adminGate(c)
    if (!auth.ok) return auth.response
    if (!deps.skyhookWarmer) {
      return c.json({ error: 'SkyHook warming not available (Lidarr not configured)' }, 400)
    }
    const { mbids } = c.req.valid('json')
    const batch = mbids.slice(0, 50) // Runtime cap; schema allows up to 200 for future use.
    for (const mbid of batch) {
      deps.skyhookWarmer.warmInBackground(mbid)
    }
    return c.json({ queued: batch.length }, 202)
  })

  app.get('/api/v1/library/warm/status', async (c) => {
    const auth = await adminGate(c)
    if (!auth.ok) return auth.response
    if (!deps.skyhookWarmer) {
      return c.json({ statuses: {} })
    }
    const mbidsParam = c.req.query('mbids') ?? ''
    const mbids = mbidsParam.split(',').filter(Boolean).slice(0, 100)
    const statuses: Record<string, string> = {}
    for (const mbid of mbids) {
      statuses[mbid] = deps.skyhookWarmer.getStatus(mbid)
    }
    return c.json({ statuses })
  })

  // Per-source sync state for current user + global rows.
  app.get('/api/v1/library/sources', async (c) => {
    const auth = requireSessionUser(c)
    if (!auth.ok) return auth.response
    const sources = await deps.librarySyncStore.listSyncStateForUser(auth.userId)
    return c.json({ sources })
  })

  app.use('/api/v1/library/sync', rateLimiter({ windowMs: 60_000, max: 5, keyPrefix: 'libsync' }))
  app.post('/api/v1/library/sync', zJson(librarySyncSchema), async (c) => {
    const auth = await adminGate(c)
    if (!auth.ok) return auth.response
    const { source } = c.req.valid('json')
    if (source) {
      let result = await deps.librarySync.syncSpecificSource(auth.userId, source, { force: true })
      // Per-user source not configured - retry as a global source. This is safe today because
      // (a) the route is admin-gated and (b) per-user/global source IDs do not overlap. If a
      // future source becomes both per-user AND global, restrict this fallback to known-global
      // IDs to avoid letting per-user calls trigger global syncs they shouldn't reach.
      if (result.status === 'failed' && result.error.includes(SOURCE_NOT_CONFIGURED_ERROR)) {
        result = await deps.librarySync.syncSpecificSource(null, source, { force: true })
      }
      // Manual "Sync now" is also the fastest way for an admin to correct a
      // request/recommendation that got mislabeled "failed" by a client
      // timeout when Lidarr actually finished the add moments later (see
      // reconcileFulfillment) -- otherwise that only self-corrects on the
      // next scheduled library sync or Plex webhook, which can be hours
      // away. Best-effort: a reconcile failure shouldn't fail the sync response.
      await reconcileFulfillment(deps.db, auth.userId).catch((err) =>
        console.error('[library-sync] reconcileFulfillment failed:', err),
      )
      const status = result.status === 'completed' ? 200 : result.status === 'failed' ? 502 : 202
      return c.json(result, status)
    } else {
      await deps.librarySync.syncGlobal({ force: true })
      const summary = await deps.librarySync.syncForUser(auth.userId, { force: true })
      await reconcileFulfillment(deps.db, auth.userId).catch((err) =>
        console.error('[library-sync] reconcileFulfillment failed:', err),
      )
      return c.json(summary, 202)
    }
  })

  // "Unreconciled" = rows where mbid IS NULL, for current user + global.
  app.get('/api/v1/library/unreconciled', async (c) => {
    const auth = await adminGate(c)
    if (!auth.ok) return auth.response
    const items = await deps.librarySyncStore.listUnreconciledForUser(auth.userId)
    return c.json({ items })
  })

  app.get('/api/v1/library/album-coverage/:artistMbid', async (c) => {
    const auth = requireSessionUser(c)
    if (!auth.ok) return auth.response
    const artistMbid = c.req.param('artistMbid')
    if (!UUID_RE.test(artistMbid)) {
      return c.json({ error: 'artistMbid must be a valid UUID' }, 400)
    }
    const coverage = await deps.albumCoverage.getCoverageForArtist(auth.userId, artistMbid)
    return c.json(coverage)
  })

  app.get('/api/v1/library/unreconciled-albums', async (c) => {
    const auth = await adminGate(c)
    if (!auth.ok) return auth.response
    const items = await deps.librarySyncStore.listUnreconciledAlbumsForUser(auth.userId)
    return c.json({ items })
  })

  app.post('/api/v1/library/overrides', zJson(libraryOverrideSchema), async (c) => {
    const auth = await adminGate(c)
    if (!auth.ok) return auth.response
    const { source, sourceArtistId, correctMbid, note } = c.req.valid('json')
    const mbid = !correctMbid ? null : correctMbid
    await deps.librarySyncStore.upsertOverride(auth.userId, source, sourceArtistId, mbid, note)
    return c.body(null, 204)
  })

  app.post('/api/v1/library/album-overrides', zJson(libraryAlbumOverrideSchema), async (c) => {
    const auth = await adminGate(c)
    if (!auth.ok) return auth.response
    const { source, sourceAlbumId, correctAlbumMbid, note } = c.req.valid('json')
    const albumMbid = !correctAlbumMbid ? null : correctAlbumMbid
    await deps.librarySyncStore.upsertAlbumOverride(
      auth.userId,
      source,
      sourceAlbumId,
      albumMbid,
      note,
    )
    return c.body(null, 204)
  })

  app.delete('/api/v1/library/overrides/:source/:sourceArtistId', async (c) => {
    const auth = await adminGate(c)
    if (!auth.ok) return auth.response
    const source = c.req.param('source')
    const sourceArtistId = c.req.param('sourceArtistId')
    await deps.librarySyncStore.deleteOverride(auth.userId, source, sourceArtistId)
    return c.body(null, 204)
  })

  // Note: a "reconcile only without re-fetch" path is a follow-up task.
  app.post('/api/v1/library/reconcile', async (c) => {
    const auth = await adminGate(c)
    if (!auth.ok) return auth.response
    deps.librarySync.syncForUser(auth.userId, { force: true }).catch((err: unknown) => {
      console.error('[library/reconcile] sync error:', errMsg(err))
    })
    return c.body(null, 202)
  })

  return app
}
