import { resolve } from 'node:path'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { HTTPException } from 'hono/http-exception'
import { secureHeaders } from 'hono/secure-headers'
import { envConfig } from '@/config/env'
import { VERSION } from '@/version'
import { openapiDoc } from './helpers/openapi-doc'
import { problem } from './helpers/problem'
import { maintenanceMiddleware } from './maintenance'
import { adminGuard } from './middleware/admin-guard'
import { apiVersionRedirect } from './middleware/api-version'
import { authGuard } from './middleware/auth'
import { csrfGuard } from './middleware/csrf'
import { requestLogger } from './middleware/logger'
import { rateLimiter } from './middleware/rate-limit'
import { setupGuard } from './middleware/setup-guard'
import { adminRoutes } from './routes/admin'
import { albumBlocksRoutes } from './routes/album-blocks'
import { analyticsRoutes } from './routes/analytics'
import { artistBlocksRoutes } from './routes/artist-blocks'
import { artistRoutes } from './routes/artists'
import { authRoutes } from './routes/auth'
import { plexAuthRoutes } from './routes/auth-plex'
import { batchRoutes } from './routes/batches'
import { dashboardRoutes } from './routes/dashboard'
import { exportRoutes } from './routes/exports'
import { genreRoutes } from './routes/genres'
import { healthRoutes } from './routes/health'
import { identifyRoutes } from './routes/identify'
import { jobRoutes } from './routes/jobs'
import { libraryRoutes } from './routes/library'
import { lidarrRoutes } from './routes/lidarr'
import { listeningRoutes } from './routes/listening'
import { mediaRoutes } from './routes/media'
import { moodRoutes } from './routes/mood'
import { oauthRoutes } from './routes/oauth'
import { pipelineRoutes } from './routes/pipeline'
import { playlistRoutes } from './routes/playlists'
import { realtimeRoutes } from './routes/realtime'
import { recommendationRoutes } from './routes/recommendations'
import { requestRoutes } from './routes/requests'
import { settingsRoutes } from './routes/settings'
import { setupRoutes } from './routes/setup'
import { targetRoutes } from './routes/targets'
import { testSeedRoutes } from './routes/test-seed'
import { userRoutes } from './routes/users'
import { webhookRoutes } from './routes/webhooks'
import type { HonoEnv } from './types'

// AppDependencies is the intersection of every per-domain slice in deps.ts.
// Route files that only need a subset (see TargetDeps / LibraryDeps / etc.
// already defined locally in some routes) can import from `./deps` instead
// of accepting the full bag. Keeping this re-export stable avoids breaking
// every caller.
export type { AppDependencies } from './deps'

import type { AppDependencies } from './deps'

const SPOTIFY_BRIDGE_CSP = [
  "default-src 'none'",
  "script-src 'self' https://open.spotify.com/embed/iframe-api/v1 https://embed-cdn.spotifycdn.com/_next/static/",
  "style-src 'unsafe-inline'",
  'img-src data: https://i.scdn.co https://*.spotifycdn.com',
  'connect-src https://*.spotify.com https://*.spotifycdn.com',
  'frame-src https://open.spotify.com',
  "frame-ancestors 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

export function createApp(deps: AppDependencies) {
  const app = new Hono<HonoEnv>()

  // Central error handler: maps HTTPException (including zJson's hook failures
  // when a handler throws one) and unknown errors to RFC 9457 problem+json.
  // Zod/validator hooks still return their {error, code, details} shape
  // directly so existing clients keep working; only unhandled throws flow here.
  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      const res = err.getResponse()
      // If the exception already carries a fully-formed response (e.g. from a
      // middleware that built its own body), prefer it over the problem+json
      // envelope to avoid clobbering specialised payloads.
      if (res.headers.get('content-type')?.includes('application/json')) return res
      return problem(c, `http-${err.status}`, err.message || 'HTTP Error', err.status, undefined)
    }
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[server] unhandled error:', msg, err instanceof Error ? err.stack : '')
    return problem(c, 'internal-error', 'Internal Server Error', 500)
  })

  // 404 for unmatched /api/* requests. Non-API paths fall through to the SPA
  // static serving in production, so we only intercept API routes here.
  app.notFound((c) => {
    if (c.req.path.startsWith('/api/')) {
      return problem(c, 'not-found', 'Not Found', 404, `No route for ${c.req.method} ${c.req.path}`)
    }
    return c.text('Not Found', 404)
  })

  // Log all requests first - before auth/cors so we capture everything
  app.use('*', requestLogger())

  // 308-redirect legacy /api/* to /api/v1/*. Must run before any route is
  // mounted so a legacy request never reaches a handler mounted under
  // /api/v1/*. Emits Deprecation + Sunset headers for RFC 9745/8594 clients.
  app.use('*', apiVersionRedirect)

  if (!envConfig.allowedOrigin && process.env.NODE_ENV === 'production') {
    console.warn(
      'ALLOWED_ORIGIN is not set in production - CORS will reject cross-origin requests. Set ALLOWED_ORIGIN to your app URL.',
    )
  }
  if (process.env.NODE_ENV === 'production' && envConfig.allowInsecureCookies) {
    console.warn(
      'DJLLAMA_ALLOW_INSECURE_COOKIES=true permits plaintext browser session cookies for HTTP origins.',
    )
  }
  app.use(
    '*',
    cors({
      origin:
        envConfig.allowedOrigin ?? (process.env.NODE_ENV === 'production' ? () => undefined : '*'),
      allowHeaders: ['Authorization', 'Content-Type', 'X-DJLlama-CSRF', 'X-DJLlama-Auth-Mode'],
    }),
  )
  app.use('/spotify-embed-bridge.html', async (c, next) => {
    await next()
    c.header('Content-Security-Policy', SPOTIFY_BRIDGE_CSP)
    c.header('X-Frame-Options', 'SAMEORIGIN')
  })
  app.use(
    '*',
    secureHeaders({
      // X-Frame-Options can only say DENY/SAMEORIGIN; when outside origins are
      // allowed to frame the app, CSP frame-ancestors carries the rule instead.
      xFrameOptions: envConfig.frameAncestors.length ? false : 'DENY',
      xContentTypeOptions: 'nosniff',
      referrerPolicy: 'strict-origin-when-cross-origin',
      crossOriginOpenerPolicy: 'same-origin',
      strictTransportSecurity: 'max-age=31536000; includeSubDomains',
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        // The hash allows index.html's inline pre-mount theme script (prevents
        // a flash of the wrong theme before React hydrates). It must be
        // recomputed if that script's contents ever change --
        // tests/server/security-headers.test.ts hashes the real index.html
        // and fails when this goes stale:
        //   node -e "const{createHash}=require('crypto');console.log(createHash('sha256').update(SCRIPT_TEXT).digest('base64'))"
        scriptSrc: ["'self'", "'sha256-kTA+9QomyBhfk+chg8ir1+hbF0kvnD5euA5yfp0Lt9E='"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'", 'https:'],
        fontSrc: ["'self'"],
        frameSrc: ["'self'", 'https://open.spotify.com'],
        ...(envConfig.frameAncestors.length
          ? { frameAncestors: ["'self'", ...envConfig.frameAncestors] }
          : {}),
      },
    }),
  )
  app.use(
    '*',
    authGuard({
      hasUsers: async () => (await deps.getUserCount()) > 0,
      isSetupComplete: deps.isSetupComplete,
    }),
  )
  app.use('*', csrfGuard)
  app.use('*', setupGuard(deps.isSetupComplete))
  app.use('*', maintenanceMiddleware)

  // Auth status (optional auth - tells the frontend whether auth is required
  // AND whether the caller is already authenticated via session cookie / bearer
  // token. Never returns a raw session token: the cookie handles
  // authentication on subsequent requests.
  //
  // Deployment-fingerprint fields (version) live on `/api/v1/auth/meta`
  // behind auth so an unauthenticated attacker cannot enumerate the build or
  // infer deployment topology.
  app.get('/api/v1/auth/status', async (c) => {
    const userCount = await deps.getUserCount()
    const userId = c.get('userId')
    const user = typeof userId === 'number' ? await deps.getUserById(userId) : null
    const settings = await deps.getSettings()

    return c.json({
      authenticated: !!user,
      userId: user?.id,
      isAdmin: user?.isAdmin ?? false,
      // Whether this Plex identity has access to the admin-picked Music
      // library section(s) -- admins always read as true regardless of the
      // stored flag, since they need Settings access even if they aren't
      // personally shared on Music. See routes/auth-plex.ts and
      // core/auth/plex-user-sync.ts for how this gets kept fresh.
      hasMusicAccess: user ? user.isAdmin || user.hasMusicAccess : false,
      // True until the very first (owner) Plex login completes bootstrap --
      // the frontend shows a distinct welcome screen ("sign in with the
      // account that owns this server") instead of the normal sign-in screen
      // while this is true. See routes/auth-plex.ts.
      bootstrapRequired: !settings?.plexAdminToken,
      // Live check, not just "was setup ever completed" -- Lidarr is
      // required (there's nothing to dispatch requests/recommendations to
      // without it) and unlike every other connection it can't be toggled
      // off in Settings, so if it's ever unset (setup never finished it, or
      // it was cleared some other way) the whole app gates behind fixing it
      // rather than silently running with a broken core feature.
      lidarrRequired: !(settings?.lidarrUrl && settings.lidarrApiKey),
      // Recommendations need AI to turn raw listening signal into curated,
      // album-level suggestions -- unlike Lidarr this is a single feature
      // gate, not a whole-app gate (see AiRequiredRoute in App.tsx), but the
      // predicate is the same "is AI configured" check used in Settings and
      // the pipeline route.
      aiRequired: !(settings?.aiProvider && settings.aiModel),
      // DJ Llama fork: always required, even with zero users -- there's no
      // "no auth configured yet" bootstrap window, since Plex sign-in (not
      // an unauthenticated first-run wizard) is what creates the first
      // (admin) account. See routes/auth-plex.ts.
      required: true,
      hasUsers: userCount > 0,
      registrationOpen: false,
    })
  })

  // Authenticated-only deployment metadata. Splits fingerprint-sensitive
  // fields off the public /api/auth/status surface. Not listed in
  // PUBLIC_PATHS / OPTIONAL_AUTH_PATHS, so authGuard enforces a 401 for
  // unauthenticated callers.
  app.get('/api/v1/auth/meta', async (c) => {
    return c.json({ version: VERSION })
  })

  // OpenAPI 3.1 spec. Intentionally public so integrators can read the
  // contract without credentials. The spec is a skeleton today - see
  // src/server/helpers/openapi-doc.ts. `/api/v1/docs` returns a tiny
  // no-external-JS landing page pointing at the spec; rendering with
  // Scalar/Swagger is deferred to keep the CSP strict.
  app.get('/api/v1/docs/openapi.json', (c) =>
    c.json(openapiDoc, 200, { 'cache-control': 'public, max-age=60' }),
  )
  app.get(
    '/api/v1/docs',
    (_c) =>
      new Response(
        `<!doctype html><html><head><meta charset="utf-8"><title>DJ Llama API</title>
<style>body{font-family:system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem;line-height:1.5}code{background:#f4f4f4;padding:.1rem .3rem;border-radius:.2rem}</style>
</head><body>
<h1>DJ Llama API</h1>
<p>The machine-readable OpenAPI 3.1 specification is served at
<a href="/api/v1/docs/openapi.json"><code>/api/v1/docs/openapi.json</code></a>.</p>
<p>Paste the URL into your favourite viewer (Scalar, Swagger UI, Redoc, Insomnia, Bruno, Postman) to browse it interactively.</p>
</body></html>`,
        { headers: { 'content-type': 'text/html; charset=utf-8' } },
      ),
  )

  app.use(
    '/api/v1/auth/plex/start',
    rateLimiter({ windowMs: 60_000, max: 10, keyPrefix: 'plex-start' }),
  )
  app.use(
    '/api/v1/auth/plex/poll',
    rateLimiter({ windowMs: 10_000, max: 10, keyPrefix: 'plex-poll' }),
  )
  app.use(
    '/api/v1/auth/plex/select-library',
    rateLimiter({ windowMs: 60_000, max: 10, keyPrefix: 'plex-lib' }),
  )
  app.route('/', plexAuthRoutes({ db: deps.db }))
  // Rate limit auth endpoints: 10 attempts per minute for login/register
  app.use('/api/v1/auth/login', rateLimiter({ windowMs: 60_000, max: 10, keyPrefix: 'auth' }))
  app.use('/api/v1/auth/register', rateLimiter({ windowMs: 60_000, max: 5, keyPrefix: 'reg' }))
  app.use(
    '/api/v1/auth/change-password',
    rateLimiter({ windowMs: 60_000, max: 5, keyPrefix: 'chpw' }),
  )
  // Throttle email writes so the email-collision 409 cannot be used as a fast
  // enumeration oracle against the user list.
  app.use('/api/v1/auth/me/email', rateLimiter({ windowMs: 60_000, max: 5, keyPrefix: 'email' }))
  // Rate limit AI-consuming endpoints to prevent API budget exhaustion
  app.use('/api/v1/mood/discover', rateLimiter({ windowMs: 60_000, max: 10, keyPrefix: 'mood' }))
  app.use(
    '/api/v1/pipeline/quick-discover',
    rateLimiter({ windowMs: 60_000, max: 5, keyPrefix: 'qdsc' }),
  )
  app.use('/api/v1/pipeline/rescan', rateLimiter({ windowMs: 60_000, max: 2, keyPrefix: 'rscn' }))
  app.route('/', authRoutes(deps))
  app.route('/', oauthRoutes(deps))
  app.route('/', webhookRoutes(deps))
  app.route('/', healthRoutes({ db: deps.db }))
  app.route('/', setupRoutes(deps))
  app.route('/', settingsRoutes(deps))
  app.route('/', pipelineRoutes(deps))
  app.route('/', realtimeRoutes())
  app.route('/', recommendationRoutes(deps))
  app.route('/', requestRoutes(deps))
  app.route('/', identifyRoutes(deps))
  app.route('/', batchRoutes(deps))
  app.use('/api/v1/admin/*', adminGuard(deps.getUserById))
  app.use('/api/v1/analytics/*', adminGuard(deps.getUserById))

  app.route(
    '/',
    adminRoutes({
      db: deps.db,
      isPipelineRunning: () => deps.orchestrator.isRunning,
      getUserById: deps.getUserById,
      getSettings: deps.getSettings,
    }),
  )
  app.route('/', analyticsRoutes(deps))
  app.route('/', artistRoutes(deps))
  app.route('/', mediaRoutes(deps))
  app.route('/', lidarrRoutes(deps))
  app.route('/', listeningRoutes(deps))
  app.route('/', genreRoutes(deps))
  app.route('/', userRoutes(deps))
  app.route('/', targetRoutes(deps))
  app.route('/', dashboardRoutes(deps))
  app.route(
    '/',
    artistBlocksRoutes({
      listArtistBlocks: deps.listArtistBlocks,
      removeArtistBlock: deps.removeArtistBlock,
      addArtistBlock: deps.addArtistBlock,
    }),
  )
  app.route(
    '/',
    albumBlocksRoutes({
      listAlbumBlocks: deps.listAlbumBlocks,
      removeAlbumBlock: deps.removeAlbumBlock,
    }),
  )
  app.route(
    '/',
    jobRoutes({
      getUserById: deps.getUserById,
      jobQueries: deps.jobQueries,
      scheduler: {
        get nextRun() {
          return deps.scheduler.nextRun('main-pipeline')
        },
      },
    }),
  )
  app.route('/', exportRoutes(deps))
  if (deps.playlistDeps) {
    app.route('/', playlistRoutes(deps.playlistDeps))
  }
  app.route(
    '/',
    moodRoutes({
      getSettings: deps.getSettings,
      providerRegistry: deps.providerRegistry,
    }),
  )
  app.route(
    '/',
    libraryRoutes({
      db: deps.db,
      libraryHealth: deps.libraryHealth,
      skyhookWarmer: deps.skyhookWarmer,
      librarySync: deps.librarySync,
      librarySyncStore: deps.librarySyncStore,
      getSettings: deps.getSettings,
      albumCoverage: deps.albumCoverage ?? {
        getCoverageForArtist: async () => {
          throw new Error('Album coverage service not configured')
        },
      },
      getUserById: deps.getUserById,
    }),
  )

  // Test-only seed routes. The `=== 'test'` guard is inlined to `false` by Bun
  // at production build time (Dockerfile sets NODE_ENV=production), so this
  // branch and the imported module are tree-shaken out of the prod bundle.
  if (process.env.NODE_ENV === 'test') {
    app.route('/', testSeedRoutes(deps))
  }

  // Serve built SPA in production (dev uses Vite's dev server with proxy)
  // Absolute path required: @hono/node-server serveStatic resolves relative
  // to the module directory (dist/server/), not process.cwd()
  if (process.env.NODE_ENV === 'production') {
    const webRoot = resolve(process.cwd(), 'dist/web')
    // Hashed filenames (app-<hash>.js) make /assets/* safe to cache forever,
    // but index.html must always be revalidated -- otherwise browsers/PWAs
    // can keep serving a stale shell (and the old hashed bundle it points
    // to) indefinitely after a deploy, with no explicit header to override.
    app.use('/*', async (c, next) => {
      await next()
      c.header(
        'Cache-Control',
        c.req.path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      )
    })
    app.use('/*', serveStatic({ root: webRoot }))
    app.get('*', serveStatic({ root: webRoot, path: 'index.html' }))
  }

  return app
}
