import { Hono } from 'hono'
import { syncPlexServerUsers } from '@/core/auth/plex-user-sync'
import type { UserPublic } from '@/db/queries/users'
import type { AppDependencies } from '@/server'
import { adminRequired } from '@/server/helpers/auth-problems'
import { readPagination } from '@/server/helpers/pagination'
import { encodeCursor } from '@/server/helpers/pagination-cursor'
import { requireAdmin as requireAdminShared } from '@/server/helpers/require-user'
import { updateUserSchema, userIdParamSchema } from '@/server/schemas/users'
import { zJson, zParam } from '@/server/schemas/validator'
import type { HonoEnv } from '@/server/types'

// Only what the admin Users page needs -- UserPublic also carries each user's
// Plex token/URL, preferences and taste cache, none of which belong here.
function toAdminUserView(u: UserPublic, lastSignInAt: Date | undefined) {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    isAdmin: u.isAdmin,
    isOwner: u.isOwner,
    autoApproveRequests: u.autoApproveRequests,
    authProvider: u.authProvider,
    hasMusicAccess: u.hasMusicAccess,
    createdAt: u.createdAt,
    // plexToken is only stored when the person completes a sign-in themselves
    // (auth-plex.ts) -- the background Plex sync never sets it.
    hasSignedIn: u.plexToken != null || lastSignInAt != null,
    lastSignInAt: lastSignInAt ?? null,
  }
}

export function userRoutes(deps: AppDependencies) {
  const router = new Hono<HonoEnv>()

  /** Check if removing admin from targetId would leave zero admins. */
  async function isLastAdmin(targetId: number): Promise<boolean> {
    const all = await deps.listUsers()
    const otherAdmins = all.filter((u) => u.isAdmin && u.id !== targetId)
    return otherAdmins.length === 0
  }

  const requireAdmin = (c: Parameters<typeof requireAdminShared>[0]) =>
    requireAdminShared(c, deps.getUserById)

  router.get('/api/v1/users', async (c) => {
    const auth = await requireAdmin(c)
    if (!auth.ok) return auth.response

    const page = readPagination(c)
    const lastSignIns = (await deps.getLastSignInByUser?.()) ?? new Map<number, Date>()
    const view = (u: UserPublic) => toAdminUserView(u, lastSignIns.get(u.id))
    if (page === null) {
      const userList = await deps.listUsers()
      return c.json(userList.map(view))
    }
    const rows = await deps.listUsers({ limit: page.limit + 1, cursor: page.cursor })
    const hasMore = rows.length > page.limit
    const data = hasMore ? rows.slice(0, page.limit) : rows
    const last = data[data.length - 1]
    const nextCursor =
      hasMore && last ? encodeCursor({ id: last.id, ts: last.createdAt.toISOString() }) : null
    return c.json({ data: data.map(view), meta: { limit: page.limit, nextCursor } })
  })

  // Reconciles DJ Llama accounts against everyone Plex currently shares this
  // server with. Accounts are otherwise added/removed automatically by a
  // background schedule; this is the on-demand "don't make me wait for the
  // next tick" trigger.
  router.post('/api/v1/users/sync-plex', async (c) => {
    const auth = await requireAdmin(c)
    if (!auth.ok) return auth.response

    const result = await syncPlexServerUsers(deps.db)
    return c.json(result)
  })

  router.patch(
    '/api/v1/users/:id',
    zParam(userIdParamSchema),
    zJson(updateUserSchema),
    async (c) => {
      const auth = await requireAdmin(c)
      if (!auth.ok) return auth.response
      const caller = await deps.getUserById(auth.userId)
      if (!caller) return adminRequired(c)

      const { id: targetId } = c.req.valid('param')
      const body = c.req.valid('json')

      const target = await deps.getUserById(targetId)
      if (!target) return c.json({ error: 'User not found' }, 404)

      // Guard: the Plex server owner is permanently admin -- nobody, not
      // even another admin, can demote them. Distinct from the self/last-
      // admin guards below, which are about ordinary admins.
      if (body.isAdmin === false && target.isOwner) {
        return c.json({ error: 'The server owner cannot be removed as admin' }, 400)
      }

      // Guard: admin cannot remove their own admin role
      if (body.isAdmin === false && caller.id === targetId) {
        return c.json({ error: 'Cannot remove your own admin role' }, 400)
      }

      // Guard: can't remove admin from last admin user
      if (body.isAdmin === false && target.isAdmin && (await isLastAdmin(targetId))) {
        return c.json({ error: 'Cannot remove admin from the last admin user' }, 400)
      }

      await deps.updateUser(targetId, {
        ...(typeof body.isAdmin === 'boolean' ? { isAdmin: body.isAdmin } : {}),
        ...(typeof body.autoApproveRequests === 'boolean'
          ? { autoApproveRequests: body.autoApproveRequests }
          : {}),
      })
      return c.body(null, 204)
    },
  )

  router.delete('/api/v1/users/:id', zParam(userIdParamSchema), async (c) => {
    const auth = await requireAdmin(c)
    if (!auth.ok) return auth.response
    const caller = await deps.getUserById(auth.userId)
    if (!caller) return adminRequired(c)

    const { id: targetId } = c.req.valid('param')

    if (caller.id === targetId) {
      return c.json({ error: 'Cannot delete your own account' }, 400)
    }

    const target = await deps.getUserById(targetId)
    if (!target) return c.json({ error: 'User not found' }, 404)

    // Guard: the Plex server owner can never be deleted.
    if (target.isOwner) {
      return c.json({ error: 'The server owner cannot be deleted' }, 400)
    }

    // Guard: can't delete the last admin
    if (target.isAdmin && (await isLastAdmin(targetId))) {
      return c.json({ error: 'Cannot delete the last admin user' }, 400)
    }

    await deps.deleteUser(targetId)
    return c.body(null, 204)
  })

  return router
}
