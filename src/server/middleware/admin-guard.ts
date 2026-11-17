import { createMiddleware } from 'hono/factory'
import { adminRequired } from '@/server/helpers/auth-problems'
import type { HonoEnv } from '@/server/types'

type GetUserById = (id: number) => Promise<{ isAdmin: boolean } | null>

/**
 * Middleware that rejects non-admin users with 403.
 * Legacy token auth (no userId) is NOT admin - users should migrate to session auth.
 */
export function adminGuard(getUserById: GetUserById) {
  return createMiddleware<HonoEnv>(async (c, next) => {
    if (c.get('legacyTokenAuth')) return adminRequired(c)
    const uid = c.get('userId')
    if (!uid) return adminRequired(c)
    const u = await getUserById(uid)
    if (!u?.isAdmin) return adminRequired(c)
    await next()
  })
}

/** Inline admin check for routes that need the isAdmin boolean for branching. */
export async function resolveAdmin(
  userId: number | undefined,
  getUserById: GetUserById,
  legacyTokenAuth?: boolean,
): Promise<boolean> {
  if (legacyTokenAuth) return false
  if (!userId) return false
  const user = await getUserById(userId)
  return user?.isAdmin ?? false
}
