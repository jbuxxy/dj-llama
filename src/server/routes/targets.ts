import { Hono } from 'hono'
import type { AppDependencies } from '@/server'
import { notAuthenticated } from '@/server/helpers/auth-problems'
import type { HonoEnv } from '@/server/types'

/**
 * Read-only list of targets (Lidarr) currently available to dispatch a
 * recommendation/request to -- powers the approve-to-target dropdown. Lidarr
 * is a global system connection now (db/queries/targets.ts), so there's no
 * more per-user CRUD; this sources directly from getEnabledTargetsForUser,
 * the same function real dispatch uses, so the dropdown can never drift from
 * what approving would actually do.
 *
 * `id` is the numeric system-target row id (parsed back out of
 * DestinationTarget.id, which is always `${type}-${rowId}` -- see
 * core/targets/lidarr.ts) to match the shape the frontend's approve-to-target
 * UI already expects. `enabled`/`owned` are always true here:
 * getEnabledTargetsForUser already filters to enabled targets, and "owned"
 * has no meaning for a global connection everyone shares.
 */
export function targetRoutes(deps: AppDependencies) {
  const router = new Hono<HonoEnv>()

  router.get('/api/v1/targets', async (c) => {
    const userId = c.get('userId')
    if (!userId) return notAuthenticated(c)
    const targets = await deps.getEnabledTargetsForUser(userId)
    return c.json(
      targets.map((t) => ({
        id: Number(t.id.slice(t.type.length + 1)),
        type: t.type,
        name: t.name,
        enabled: true,
        owned: true,
      })),
    )
  })

  return router
}
