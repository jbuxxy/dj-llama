import { Hono } from 'hono'
import { errMsg } from '@/core/validation'
import type { AppDependencies } from '@/server'
import { parseOptionalClampedInt } from '@/server/helpers/parse-int-clamp'
import { apiError } from '@/server/helpers/problem'
import { resolveAdmin } from '@/server/middleware/admin-guard'
import type { HonoEnv } from '@/server/types'

// Embedding-backed views: "more like this" and the taste map. Both answer
// { available: false } when the configured AI provider can't embed, so the
// client can hide the feature instead of showing an error.
export function tasteMapRoutes(deps: AppDependencies) {
  const router = new Hono<HonoEnv>()
  let backfillRunning = false

  router.get('/api/v1/similar-artists', async (c) => {
    const userId = c.get('userId')
    if (userId == null) return apiError(c, 400, 'A user session is required')
    const mbid = c.req.query('mbid')?.trim() || null
    const name = c.req.query('name')?.trim() ?? ''
    if (!mbid && !name) return apiError(c, 400, 'mbid or name is required')
    const limit = parseOptionalClampedInt(c.req.query('limit'), { min: 1, max: 30, default: 12 })
    if (limit == null) return apiError(c, 400, 'limit must be an integer')
    const artists = await deps.embeddings?.similar(userId, { mbid, name }, limit)
    if (artists == null) return c.json({ available: false, artists: [] })
    return c.json({ available: true, artists })
  })

  router.get('/api/v1/taste-map', async (c) => {
    const userId = c.get('userId')
    if (userId == null) return apiError(c, 400, 'A user session is required')
    const map = await deps.embeddings?.tasteMap(userId)
    if (map == null) return c.json({ available: false, map: null })
    return c.json({ available: true, map })
  })

  // Embeds whatever isn't embedded yet, now instead of at the nightly run.
  router.post('/api/v1/taste-map/refresh', async (c) => {
    const userId = c.get('userId')
    const isAdmin = await resolveAdmin(userId, deps.getUserById, c.get('legacyTokenAuth'))
    if (!isAdmin) return apiError(c, 403, 'Only an admin can rebuild artist embeddings')
    if (!deps.embeddings) return apiError(c, 409, 'Embeddings are not available')
    if (backfillRunning) return c.json({ started: false, running: true }, 202)
    backfillRunning = true
    void deps.embeddings
      .backfill()
      .then((r) => {
        if (r.embedded > 0) console.log(`[embeddings] manual refresh embedded ${r.embedded}`)
      })
      .catch((err) => console.warn('[embeddings] manual refresh failed:', errMsg(err)))
      .finally(() => {
        backfillRunning = false
      })
    return c.json({ started: true, running: true }, 202)
  })

  return router
}
