import { createMiddleware } from 'hono/factory'
import { problem } from '@/server/helpers/problem'
import type { HonoEnv } from '@/server/types'

type AccessUser = {
  isAdmin: boolean
  hasMusicAccess: boolean
  plexAccessRevokedAt: Date | null
}

/**
 * Whether a signed-in account may use the app. Admins don't need to be
 * shared on Music themselves (they still need Settings), but anyone the
 * Plex sync found removed from the server is locked out, admin or not.
 */
export function canUseApp(user: AccessUser): boolean {
  if (user.plexAccessRevokedAt) return false
  return user.isAdmin || user.hasMusicAccess
}

// What a locked-out session may still call: enough for the "no access"
// screen to recheck its status and sign out.
const ALLOWED_PATHS = new Set([
  '/api/v1/auth/status',
  '/api/v1/auth/logout',
  '/api/v1/auth/me',
  '/api/v1/setup/status',
])

/**
 * Server-side half of the "no music access" screen. Sign-in deliberately
 * creates sessions for every Plex identity shared on the server, so the
 * API itself has to refuse the ones without Music access.
 */
export function musicAccessGuard(getUserById: (id: number) => Promise<AccessUser | null>) {
  return createMiddleware<HonoEnv>(async (c, next) => {
    const userId = c.get('userId')
    if (
      !userId ||
      c.get('legacyTokenAuth') ||
      !c.req.path.startsWith('/api/v1/') ||
      ALLOWED_PATHS.has(c.req.path) ||
      c.req.path.startsWith('/api/v1/auth/plex/')
    ) {
      return next()
    }
    const user = await getUserById(userId)
    if (user && !canUseApp(user)) {
      return problem(
        c,
        'music-access-required',
        'Music library access required',
        403,
        'Your Plex account does not have access to the Music library on this server.',
      )
    }
    return next()
  })
}
