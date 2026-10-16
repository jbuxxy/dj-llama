import type { Context } from 'hono'
import { Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import * as z from 'zod'
import { envConfig } from '@/config/env'
import { hashPassword } from '@/core/auth'
import {
  buildPlexAuthAppUrl,
  checkPlexPin,
  createPlexPin,
  getPlexAccount,
  getPlexLibrarySections,
  listOwnedPlexServers,
  type OwnedPlexServer,
  type PlexAccount,
  type PlexLibrarySection,
  type ResolvedPlexServer,
  resolvePlexServerConnection,
} from '@/core/auth/plex'
import { isSingleOwnerCollision } from '@/core/db-errors'
import type { Database } from '@/db'
import { getSettings, updateSettings } from '@/db/queries/settings'
import {
  createUser,
  getUserByPlexAccountId,
  markUserAsOwner,
  updateUser,
  updateUserConnections,
} from '@/db/queries/users'
import { problem } from '@/server/helpers/problem'
import { issueSession, prepareSessionCookie } from '@/server/helpers/session-auth'
import { browserCookieSecure, SESSION_COOKIE_NAME } from '@/server/middleware/session-cookie'
import { zJson } from '@/server/schemas/validator'
import type { HonoEnv } from '@/server/types'

const PIN_COOKIE = 'djllama_plex_pin'
const BOOTSTRAP_COOKIE = 'djllama_plex_bootstrap'
// A Plex sign-in tab left idle shouldn't leave a pin usable indefinitely.
const PIN_COOKIE_MAX_AGE_S = 10 * 60
const BOOTSTRAP_TTL_MS = 10 * 60 * 1000

// Holds identity + resolved server between "finished Plex login" and
// "picked which library section(s) count as Music" for the very first
// (admin) login on this install. Deliberately in-memory only, same pattern
// as DJ Llama's own OIDC pending-transaction state (core/auth/oidc.ts) --
// this is a few-seconds-long UI step, not something that needs to survive
// a restart. Nothing is written to the database until select-library
// actually completes. Two stages: an owner who owns 2+ servers picks one
// first (select-server), then everyone lands on the library picker
// (select-library) same as before.
type PendingBootstrap =
  | {
      stage: 'select-server'
      account: PlexAccount
      identityToken: string
      servers: OwnedPlexServer[]
      createdAt: number
    }
  | {
      stage: 'select-library'
      account: PlexAccount
      server: ResolvedPlexServer
      sections: PlexLibrarySection[]
      createdAt: number
    }
const pendingBootstraps = new Map<string, PendingBootstrap>()

function sweepExpiredBootstraps() {
  const cutoff = Date.now() - BOOTSTRAP_TTL_MS
  for (const [id, entry] of pendingBootstraps) {
    if (entry.createdAt < cutoff) pendingBootstraps.delete(id)
  }
}

async function resolveBootstrapLibraryStage(
  identityToken: string,
  machineIdentifier: string,
): Promise<{ server: ResolvedPlexServer; sections: PlexLibrarySection[] } | null> {
  const server = await resolvePlexServerConnection(identityToken, machineIdentifier)
  if (!server) return null
  const sections = await getPlexLibrarySections(server.url, server.accessToken)
  return { server, sections }
}

const selectServerSchema = z.object({
  machineIdentifier: z.string().min(1),
})

const selectLibrarySchema = z.object({
  sectionIds: z.array(z.string()).min(1),
})

export function plexAuthRoutes(deps: { db: Database }) {
  const router = new Hono<HonoEnv>()

  router.post('/api/v1/auth/plex/start', async (c) => {
    const pin = await createPlexPin()
    setCookie(c, PIN_COOKIE, String(pin.id), {
      httpOnly: true,
      secure: browserCookieSecure(c),
      sameSite: 'Lax',
      path: '/api/v1/auth/plex',
      maxAge: PIN_COOKIE_MAX_AGE_S,
    })
    // Marks the tab Plex redirects back to as "just here to finish the OAuth
    // handshake" so the frontend can self-close it instead of showing the
    // sign-in screen again -- the ORIGINAL tab's poll loop is what actually
    // completes the login.
    const origin = envConfig.allowedOrigin || new URL(c.req.url).origin
    // ?sameTab=1: browsers without real popups (car browsers) or a framed app
    // send the whole tab to Plex; Plex then returns here and the page resumes
    // polling from the PIN cookie instead of self-closing.
    const sameTab = c.req.query('sameTab') === '1'
    const forwardUrl = sameTab ? `${origin}/?plexAuthReturn=1` : `${origin}/?plexAuthWindow=1`
    return c.json({ authAppUrl: buildPlexAuthAppUrl(pin.code, forwardUrl) })
  })

  router.get('/api/v1/auth/plex/poll', async (c) => {
    const pinId = getCookie(c, PIN_COOKIE)
    if (!pinId) return problem(c, 'plex-no-pin', 'No Plex sign-in in progress', 400)

    let identityToken: string | null
    try {
      identityToken = await checkPlexPin(Number(pinId))
    } catch {
      return problem(c, 'plex-unreachable', 'Could not reach Plex', 502)
    }
    if (!identityToken) return c.json({ status: 'pending' })
    deleteCookie(c, PIN_COOKIE, { path: '/api/v1/auth/plex' })

    try {
      const account = await getPlexAccount(identityToken)
      const settings = await getSettings(deps.db)
      const isBootstrap = !settings?.plexAdminToken

      const existingRow = await getUserByPlexAccountId(deps.db, account.id)
      const existing = existingRow
        ? { id: existingRow.id, isAdmin: existingRow.isAdmin, isOwner: existingRow.isOwner }
        : null

      if (isBootstrap) {
        // First-ever Plex login on this install. Verify this identity
        // actually OWNS a Plex server before granting anything -- previously
        // whoever's login landed here first became admin unconditionally,
        // regardless of whether they owned the server DJ Llama should
        // connect to (a real gap: a user merely shared onto someone else's
        // server, who happened to own some unrelated server, could complete
        // this flow). Plex's own `owned: true` resource flag is the correct
        // signal, not comparing account IDs (an earlier version of this
        // check compared the identity's *global* plex.tv account ID to the
        // literal number 1, which essentially never matches a real account).
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

        sweepExpiredBootstraps()
        const bootstrapId = crypto.randomUUID()

        if (owned.length > 1) {
          pendingBootstraps.set(bootstrapId, {
            stage: 'select-server',
            account,
            identityToken,
            servers: owned,
            createdAt: Date.now(),
          })
          setCookie(c, BOOTSTRAP_COOKIE, bootstrapId, {
            httpOnly: true,
            secure: browserCookieSecure(c),
            sameSite: 'Lax',
            path: '/api/v1/auth/plex',
            maxAge: BOOTSTRAP_TTL_MS / 1000,
          })
          return c.json({ status: 'select-server', servers: owned })
        }

        // Exactly one owned server -- resolve it and hand the section list
        // back to the frontend so the admin picks which one(s) are Music --
        // never auto-guessed, since Plex types audiobook libraries as
        // "artist" too, same as real music libraries.
        const firstOwned = owned[0]
        if (!firstOwned) throw new Error('unreachable: owned.length === 1')
        const resolved = await resolveBootstrapLibraryStage(
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
        pendingBootstraps.set(bootstrapId, {
          stage: 'select-library',
          account,
          server: resolved.server,
          sections: resolved.sections,
          createdAt: Date.now(),
        })
        setCookie(c, BOOTSTRAP_COOKIE, bootstrapId, {
          httpOnly: true,
          secure: browserCookieSecure(c),
          sameSite: 'Lax',
          path: '/api/v1/auth/plex',
          maxAge: BOOTSTRAP_TTL_MS / 1000,
        })
        return c.json({
          status: 'select-library',
          sections: resolved.sections.map((s) => ({ id: s.id, title: s.title, type: s.type })),
        })
      }

      // Normal path: admin server is already configured. Resolve this
      // identity's own access to that specific server.
      const server = await resolvePlexServerConnection(
        identityToken,
        settings?.plexMachineIdentifier ?? undefined,
      )
      if (!server) {
        return problem(
          c,
          'plex-no-access',
          'No access to this Plex server',
          403,
          'This Plex account does not have access to the configured Plex server.',
        )
      }

      // Music-library access, checked with the LOGGING-IN user's own token
      // (not the admin's), so it reflects exactly what Plex itself would show
      // them. This does NOT block login -- everyone with server access gets a
      // DJ Llama account; hasMusicAccess just decides whether the frontend
      // shows the app or a "contact your admin" screen (see auth-gate.tsx).
      // The owner is always treated as having access, so they can never lock
      // themselves out by mis-picking sections. Owner status is read from the
      // DB (existing.isOwner), never re-derived here -- it's set exactly once,
      // at bootstrap, after a real Plex ownership check (see the isBootstrap
      // branch above). A brand-new account created through this normal path
      // is by definition not the owner: the owner is always created through
      // bootstrap, before this path can ever run for the first time.
      const musicSectionIds = settings?.plexMusicSectionIds ?? []
      const isOwner = existing?.isOwner ?? false
      let hasMusicAccess = isOwner || musicSectionIds.length === 0
      if (!hasMusicAccess) {
        const theirSections = await getPlexLibrarySections(server.url, server.accessToken)
        hasMusicAccess = theirSections.some((s) => musicSectionIds.includes(s.id))
      }

      let user = existing
      if (!user) {
        user = await createUser(deps.db, {
          username: account.username,
          passwordHash: hashPassword(crypto.randomUUID()),
          isAdmin: false,
          email: account.email ?? undefined,
          plexAccountId: account.id,
          authProvider: 'plex',
          hasMusicAccess,
        })
      } else {
        await updateUser(deps.db, user.id, {
          hasMusicAccess,
          plexAccessRevokedAt: null,
          // Self-heal: the owner should always be admin even if this got out
          // of sync somehow. Non-owners are never auto-promoted here.
          ...(isOwner && !user.isAdmin ? { isAdmin: true } : {}),
        })
      }
      await updateUserConnections(deps.db, user.id, {
        plexUrl: server.url,
        plexToken: server.accessToken,
        // Section IDs are server-wide (admin-picked), so the first one the
        // admin designated as Music is correct for every user -- no need to
        // re-derive per person. Without this, section-scoped queries (top
        // artists, listening history) fall back to Plex's arbitrary first
        // 'artist'-typed section, which may be an audiobook library.
        plexSectionId: musicSectionIds[0] ?? null,
      })
      return finishLogin(c, user.id)
    } catch (err) {
      console.warn('[auth/plex] login failed:', err)
      return problem(c, 'plex-login-failed', 'Plex sign-in failed', 502)
    }
  })

  router.post('/api/v1/auth/plex/select-server', zJson(selectServerSchema), async (c) => {
    const bootstrapId = getCookie(c, BOOTSTRAP_COOKIE)
    if (!bootstrapId) {
      return problem(c, 'plex-no-bootstrap', 'No Plex sign-in in progress', 400)
    }
    sweepExpiredBootstraps()
    const pending = pendingBootstraps.get(bootstrapId)
    if (pending?.stage !== 'select-server') {
      return problem(
        c,
        'plex-bootstrap-expired',
        'Plex sign-in expired',
        400,
        'Sign in with Plex again.',
      )
    }

    const { machineIdentifier } = c.req.valid('json')
    const chosen = pending.servers.find((s) => s.machineIdentifier === machineIdentifier)
    if (!chosen) {
      return problem(c, 'plex-invalid-server', 'Invalid server selection', 400)
    }

    const resolved = await resolveBootstrapLibraryStage(pending.identityToken, machineIdentifier)
    if (!resolved) {
      return problem(
        c,
        'plex-no-server',
        'No Plex server found',
        403,
        'Could not connect to that Plex server. It may be offline.',
      )
    }

    pendingBootstraps.set(bootstrapId, {
      stage: 'select-library',
      account: pending.account,
      server: resolved.server,
      sections: resolved.sections,
      createdAt: Date.now(),
    })
    return c.json({
      status: 'select-library',
      sections: resolved.sections.map((s) => ({ id: s.id, title: s.title, type: s.type })),
    })
  })

  router.post('/api/v1/auth/plex/select-library', zJson(selectLibrarySchema), async (c) => {
    const bootstrapId = getCookie(c, BOOTSTRAP_COOKIE)
    if (!bootstrapId) {
      return problem(c, 'plex-no-bootstrap', 'No Plex sign-in in progress', 400)
    }
    sweepExpiredBootstraps()
    const pending = pendingBootstraps.get(bootstrapId)
    if (pending?.stage !== 'select-library') {
      return problem(
        c,
        'plex-bootstrap-expired',
        'Plex sign-in expired',
        400,
        'Sign in with Plex again.',
      )
    }

    const { sectionIds } = c.req.valid('json')
    const validIds = new Set(pending.sections.map((s) => s.id))
    if (!sectionIds.every((id) => validIds.has(id))) {
      return problem(c, 'plex-invalid-section', 'Invalid library section', 400)
    }

    pendingBootstraps.delete(bootstrapId)
    deleteCookie(c, BOOTSTRAP_COOKIE, { path: '/api/v1/auth/plex' })

    const { account, server } = pending
    await updateSettings(deps.db, {
      plexAdminUrl: server.url,
      plexAdminToken: server.accessToken,
      plexMachineIdentifier: server.machineIdentifier,
      plexMusicSectionIds: sectionIds,
    })

    const existingRow = await getUserByPlexAccountId(deps.db, account.id)
    let userId = existingRow?.id
    if (!userId) {
      try {
        const user = await createUser(deps.db, {
          username: account.username,
          passwordHash: hashPassword(crypto.randomUUID()),
          isAdmin: true,
          isOwner: true,
          email: account.email ?? undefined,
          plexAccountId: account.id,
          authProvider: 'plex',
          hasMusicAccess: true,
        })
        userId = user.id
      } catch (err) {
        // Two bootstrap attempts racing to be first -- the DB's single-owner
        // constraint lets exactly one win. The loser isn't treated as owner
        // here; ownership for this install is whichever settings write
        // ultimately lands (an inherent, rare edge case, not fully solved).
        if (!isSingleOwnerCollision(err)) throw err
        const user = await createUser(deps.db, {
          username: account.username,
          passwordHash: hashPassword(crypto.randomUUID()),
          isAdmin: false,
          email: account.email ?? undefined,
          plexAccountId: account.id,
          authProvider: 'plex',
          hasMusicAccess: true,
        })
        userId = user.id
      }
    } else {
      // Account already exists (e.g. re-running bootstrap to recover from an
      // earlier partial setup) -- isOwner still needs backfilling the first
      // time an already-existing account completes a verified bootstrap.
      await updateUser(deps.db, userId, {
        hasMusicAccess: true,
        plexAccessRevokedAt: null,
        isAdmin: true,
      })
      await markUserAsOwner(deps.db, userId)
    }
    await updateUserConnections(deps.db, userId, {
      plexUrl: server.url,
      plexToken: server.accessToken,
      plexSectionId: sectionIds[0] ?? null,
    })
    return finishLogin(c, userId)
  })

  async function finishLogin(c: Context<HonoEnv>, userId: number) {
    const sessionCookie = prepareSessionCookie(c)
    const oldCookie = getCookie(c, SESSION_COOKIE_NAME)
    await issueSession(c, userId, {
      kind: 'create',
      cookie: sessionCookie,
      revokeTokens: oldCookie ? [oldCookie] : [],
    })
    return c.json({ status: 'complete' })
  }

  return router
}
