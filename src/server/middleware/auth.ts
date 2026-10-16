import { getCookie } from 'hono/cookie'
import { createMiddleware } from 'hono/factory'
import { envConfig } from '@/config/env'
import { safeCompare } from '@/core/crypto'
import { getSession } from '@/core/sessions'
import { notAuthenticated } from '@/server/helpers/auth-problems'
import { problem } from '@/server/helpers/problem'
import { SESSION_COOKIE_NAME } from '@/server/middleware/session-cookie'
import type { AuthMethod, HonoEnv } from '@/server/types'

type Credential = {
  token: string
  source: 'bearer' | 'query' | 'cookie'
}

const SESSION_AUTH_METHODS = {
  bearer: 'session-bearer',
  query: 'session-query',
  cookie: 'session-cookie',
} as const satisfies Record<Credential['source'], AuthMethod>

// Paths that never require authentication
const PUBLIC_PATHS = new Set([
  '/health',
  '/api/v1/setup/status',
  '/api/v1/setup/complete',
  '/api/v1/auth/status',
  '/api/v1/auth/login',
  '/api/v1/auth/register',
  '/api/v1/auth/plex/start',
  '/api/v1/auth/plex/poll',
  '/api/v1/auth/plex/select-library',
  '/api/v1/docs',
  '/api/v1/docs/openapi.json',
  // Machine-to-machine, not session/legacy-token based -- validates its own
  // Authorization: Bearer against envConfig.integrationsToken internally
  // (see recommendations.ts). Public here just means "skip the session
  // guard," not "no auth."
  '/api/v1/integrations/recommendations',
  // Plex's native Webhooks feature POSTs here with no auth token of any kind
  // (same as an OAuth callback redirect can't carry one either) -- the
  // handler itself cross-checks every event against a real registered
  // user's plex.tv Account.id before recording anything and always returns
  // 200, so "public" here means "skip the session guard," not "no auth."
  // See server/routes/webhooks.ts's own doc comment.
  '/api/v1/webhooks/plex',
])

const OPTIONAL_AUTH_PATHS = new Set([
  '/api/v1/setup/status',
  '/api/v1/setup/complete',
  '/api/v1/auth/status',
])

// Only SSE/audio flows are allowed to use query-param auth tokens.
const QUERY_TOKEN_PATHS = new Set([
  '/api/v1/pipeline/events',
  '/api/v1/preview/audio',
  '/api/v1/realtime/events',
])

export function authGuard(options: {
  hasUsers: () => Promise<boolean>
  isSetupComplete: () => Promise<boolean>
}) {
  return createMiddleware<HonoEnv>(async (c, next) => {
    const publicPath =
      !c.req.path.startsWith('/api/v1/') ||
      PUBLIC_PATHS.has(c.req.path) ||
      /^\/api\/v1\/auth\/oauth\/[^/]+\/callback$/.test(c.req.path)

    // Skip auth for non-API paths (static assets, SPA routes), public API paths, and OAuth callbacks
    // Only the callback path is public (browser redirect from provider, no auth header).
    // Other OAuth paths (initiate, status, delete) need auth so userId is set on context.
    if (publicPath && !OPTIONAL_AUTH_PATHS.has(c.req.path)) return next()

    // Extract one credential and retain its source through verification.
    // Any Authorization header suppresses query/cookie fallback, including a
    // malformed or unverified header.
    const header = c.req.header('Authorization')
    let credential: Credential | undefined
    if (header !== undefined) {
      if (header.startsWith('Bearer ')) {
        credential = { token: header.slice(7), source: 'bearer' }
      }
    } else {
      const qp = c.req.query('token')
      if (qp && QUERY_TOKEN_PATHS.has(c.req.path)) {
        credential = { token: qp, source: 'query' }
      } else {
        const cookieToken = getCookie(c, SESSION_COOKIE_NAME)
        if (cookieToken) credential = { token: cookieToken, source: 'cookie' }
      }
    }

    // Try session token first
    if (credential?.token) {
      const session = await getSession(credential.token)
      if (session) {
        c.set('userId', session.userId)
        c.set('authMethod', SESSION_AUTH_METHODS[credential.source])
        return next()
      }
    }

    // Fall back to legacy DJLLAMA_AUTH_TOKEN (read-only, first user, no admin)
    const legacyToken = envConfig.authToken
    if (
      legacyToken &&
      credential &&
      credential.source !== 'cookie' &&
      safeCompare(credential.token, legacyToken)
    ) {
      console.warn(
        `[auth] DEPRECATED: Legacy token auth from ${c.req.header('x-forwarded-for') ?? 'direct'} - no admin access, no per-user features. Migrate to user sessions.`,
      )
      // Assign userId=1 (first user) so downstream queries scope correctly
      // instead of matching NULL userId records
      c.set('userId', 1)
      c.set('legacyTokenAuth', true)
      c.set('authMethod', credential.source === 'bearer' ? 'legacy-bearer' : 'legacy-query')
      return next()
    }

    if (publicPath) return next()

    // DJ Llama fork: no anonymous bootstrap window. Plex sign-in (public
    // path, handled above) is the only way to get a session, for the very
    // first user same as any other -- so a non-public path with no valid
    // credential always falls through to notAuthenticated below, even
    // before anyone exists yet.
    //
    // Degenerate-state check kept: setup marked complete but no admin
    // exists indicates orphaned DB state (admin record deleted while the
    // setup flag stayed true, or an interrupted migration) -- surfaced as
    // 503 so ops notice, rather than a 401 that would retry forever.
    if (!legacyToken && (await options.isSetupComplete()) && !(await options.hasUsers())) {
      return problem(
        c,
        'setup-admin-missing',
        'Setup admin user missing',
        503,
        'Setup is complete but no admin user exists; re-run setup.',
      )
    }

    // RFC 7235: unauthenticated responses should advertise an auth scheme.
    // `realm` is an opaque client-facing tag; kept stable so automated probes
    // can key on it without parsing our domain name out.
    return notAuthenticated(c)
  })
}
