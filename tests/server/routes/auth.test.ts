// @vitest-environment node

import { EventEmitter } from 'node:events'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { envConfig } from '@/config/env'
import { clearAllSessions, createSession, getSession } from '@/core/sessions'

import type { AppDependencies } from '@/server'
import { createApp } from '@/server'
import { authRoutes } from '@/server/routes/auth'
import type { HonoEnv } from '@/server/types'

const APP_ORIGIN = 'http://localhost'

function sessionCookieToken(response: Response): string {
  const setCookie = response.headers.get('set-cookie')
  const match = setCookie?.match(/(?:^|,\s*)djllama_session=([^;]+)/)
  if (!match?.[1]) throw new Error('session cookie missing')
  return match[1]
}

const sameOriginHeaders = {
  'X-DJLlama-CSRF': '1',
  Origin: APP_ORIGIN,
  'Sec-Fetch-Site': 'same-origin',
} as const

function makeMockOrchestrator() {
  const emitter = new EventEmitter()
  return Object.assign(emitter, {
    isRunning: false,
    run: vi.fn(async () => ({ batchId: 1 })),
  })
}

function makeDeps(overrides: Partial<AppDependencies> = {}): AppDependencies {
  return {
    db: { execute: vi.fn(async () => []) } as unknown as AppDependencies['db'],
    storeDb: {} as unknown as AppDependencies['storeDb'],
    orchestrator: makeMockOrchestrator() as unknown as AppDependencies['orchestrator'],
    scheduler: {} as AppDependencies['scheduler'],
    providerRegistry: {} as unknown as AppDependencies['providerRegistry'],
    isSetupComplete: async () => true,
    getSettings: vi.fn(async () => null),
    updateSettings: vi.fn(async () => {}),
    completeSetup: vi.fn(async () => ({ id: 1, setupComplete: true })),
    getLastBatch: vi.fn(async () => null),
    listRecommendations: vi.fn(async () => ({ items: [], total: 0 })),
    getRecommendation: vi.fn(async () => null),
    updateRecommendationStatus: vi.fn(async () => {}),
    rejectRecommendation: vi.fn(async () => 1),
    listArtistBlocks: vi.fn(async () => ({ items: [], nextCursor: null })),
    removeArtistBlock: vi.fn(async () => true),
    addArtistBlock: vi.fn(async () => {}),
    listAlbumBlocks: vi.fn(async () => []),
    removeAlbumBlock: vi.fn(async () => {}),
    bulkUpdateStatus: vi.fn(async () => {}),
    bulkDelete: vi.fn(async () => 0),
    filterOwnedIds: vi.fn(async (ids: number[]) => ids),
    listBatches: vi.fn(async () => []),
    getBatch: vi.fn(async () => null),
    getArtistById: vi.fn(async () => null),
    restartScheduler: vi.fn(),
    restartPlaylistScheduler: vi.fn(),
    createUser: vi.fn(async (data) => ({
      id: 1,
      username: data.username,
      isAdmin: data.isAdmin ?? false,
      preferences: null,
      email: null,
      authProvider: 'local',
      listenbrainzUsername: null,
      listenbrainzToken: null,
      lastfmUsername: null,
      lastfmApiKey: null,
      plexUrl: null,
      plexToken: null,
      plexSectionId: null,
      isOwner: false,
      hasMusicAccess: true,
      autoApproveRequests: false,
      plexAccessRevokedAt: null,
      plexAccountId: null,
      tasteProfileCache: null,
      tasteProfileCachedAt: null,
      createdAt: new Date(),
    })),
    getUserByUsername: vi.fn(async () => null),
    getUserById: vi.fn(async () => ({
      id: 1,
      username: 'testuser',
      isAdmin: false,
      preferences: null,
      email: null,
      authProvider: 'local',
      listenbrainzUsername: null,
      listenbrainzToken: null,
      lastfmUsername: null,
      lastfmApiKey: null,
      plexUrl: null,
      plexToken: null,
      plexSectionId: null,
      isOwner: false,
      hasMusicAccess: true,
      autoApproveRequests: false,
      plexAccessRevokedAt: null,
      plexAccountId: null,
      tasteProfileCache: null,
      tasteProfileCachedAt: null,
      createdAt: new Date(),
    })),
    getUserCount: vi.fn(async () => 0),
    genreService: {} as unknown as AppDependencies['genreService'],
    libraryHealth: {} as unknown as AppDependencies['libraryHealth'],
    librarySync: {} as unknown as AppDependencies['librarySync'],
    librarySyncStore: {} as unknown as AppDependencies['librarySyncStore'],
    getEnabledTargetsForUser: vi.fn().mockResolvedValue([]),
    updateUser: vi.fn(async () => {}),
    listUsers: vi.fn(async () => []),
    deleteUser: vi.fn(async () => {}),
    getFeedbackHistory: vi.fn(async () => new Map()),
    dashboardQueries: {
      getTasteProfile: vi.fn(async () => ({ genres: [] })),
      getLatestGenreCoverage: vi.fn(async () => null),
      getRecentActivity: vi.fn(async () => []),
    },
    jobRecorder: {
      start: vi.fn().mockResolvedValue(1),
      complete: vi.fn().mockResolvedValue(undefined),
      fail: vi.fn().mockResolvedValue(undefined),
      markStuck: vi.fn().mockResolvedValue(0),
      markInterrupted: vi.fn().mockResolvedValue(0),
    },
    jobQueries: {
      listJobs: vi.fn().mockResolvedValue({ items: [], total: 0 }),
      getJobById: vi.fn().mockResolvedValue(null),
      getJobHealth: vi.fn().mockResolvedValue({
        discovery: {
          status: 'ok',
          running: false,
          lastSuccessAt: null,
          lastProblem: null,
          nextRunAt: null,
        },
        playlists: {
          status: 'ok',
          running: false,
          lastSuccessAt: null,
          lastProblem: null,
          recentRuns: 0,
          recentFailures: 0,
        },
        librarySync: { status: 'ok', running: false, lastSuccessAt: null, lastProblem: null },
        sources: [],
      }),
    },
    ...overrides,
  }
}

beforeEach(async () => {
  await clearAllSessions()
})

afterEach(async () => {
  ;(envConfig as { allowedOrigin: string | undefined }).allowedOrigin = undefined
  delete process.env.DJLLAMA_AUTH_TOKEN
  await clearAllSessions()
  // Reset the shared in-memory rate-limit buckets so per-IP/user counts from one
  // test never bleed into the next (the rate-limited email/login/etc. endpoints
  // key on a module-global store).
  const { __shutdownRateLimiter } = await import('@/server/middleware/rate-limit')
  __shutdownRateLimiter()
})

describe('createApp insecure-cookie warning', () => {
  const INSECURE_WARNING = expect.stringContaining('DJLLAMA_ALLOW_INSECURE_COOKIES=true')
  let previousNodeEnv: string | undefined
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    previousNodeEnv = process.env.NODE_ENV
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
    ;(envConfig as { allowInsecureCookies: boolean }).allowInsecureCookies = false
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previousNodeEnv
  })

  it('warns when production explicitly permits insecure cookies', () => {
    process.env.NODE_ENV = 'production'
    ;(envConfig as { allowInsecureCookies: boolean }).allowInsecureCookies = true
    createApp(makeDeps())
    expect(warnSpy).toHaveBeenCalledWith(INSECURE_WARNING)
  })

  it('does not warn when production keeps secure cookies', () => {
    process.env.NODE_ENV = 'production'
    ;(envConfig as { allowInsecureCookies: boolean }).allowInsecureCookies = false
    createApp(makeDeps())
    expect(warnSpy).not.toHaveBeenCalledWith(INSECURE_WARNING)
  })

  it('does not warn outside production even when insecure cookies are allowed', () => {
    process.env.NODE_ENV = 'test'
    ;(envConfig as { allowInsecureCookies: boolean }).allowInsecureCookies = true
    createApp(makeDeps())
    expect(warnSpy).not.toHaveBeenCalledWith(INSECURE_WARNING)
  })
})

describe('session token authentication', () => {
  it('a valid session token grants access to protected routes', async () => {
    const app = createApp(makeDeps({ getUserCount: vi.fn(async () => 1) }))

    await createSession(1, 'session-token')

    const res = await app.request('/api/v1/settings', {
      headers: { Authorization: 'Bearer session-token' },
    })
    // Should not be 401 (may be 404 since getSettings returns null)
    expect(res.status).not.toBe(401)
  })

  it('invalid session token returns 401 when users exist', async () => {
    const app = createApp(
      makeDeps({
        getUserCount: vi.fn(async () => 1),
      }),
    )

    const res = await app.request('/api/v1/settings', {
      headers: { Authorization: 'Bearer invalid-token-here' },
    })
    expect(res.status).toBe(401)
  })
})

describe('POST /api/v1/auth/session/migrate', () => {
  it('atomically rotates a verified bearer into a cookie without leaking a token', async () => {
    const app = createApp(makeDeps({ getUserCount: vi.fn(async () => 1) }))
    await createSession(1, 'browser-bearer')
    await createSession(1, 'old-browser-cookie')
    await createSession(1, 'unrelated-device-session')

    const res = await app.request('/api/v1/auth/session/migrate', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer browser-bearer',
        Cookie: 'djllama_session=old-browser-cookie',
      },
    })

    expect(res.status).toBe(204)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.text()).toBe('')
    const newToken = sessionCookieToken(res)
    await expect(getSession(newToken)).resolves.toEqual({ userId: 1 })
    await expect(getSession('browser-bearer')).resolves.toBeNull()
    await expect(getSession('old-browser-cookie')).resolves.toBeNull()
    await expect(getSession('unrelated-device-session')).resolves.toEqual({ userId: 1 })

    const replay = await app.request('/api/v1/auth/session/migrate', {
      method: 'POST',
      headers: { Authorization: 'Bearer browser-bearer' },
    })
    expect(replay.status).toBe(401)
  })

  it('rejects the legacy bearer with a dedicated problem', async () => {
    const app = new Hono<HonoEnv>()
    app.use('*', async (c, next) => {
      c.set('userId', 1)
      c.set('legacyTokenAuth', true)
      c.set('authMethod', 'legacy-bearer')
      await next()
    })
    app.route('/', authRoutes(makeDeps()))

    const res = await app.request('/api/v1/auth/session/migrate', {
      method: 'POST',
      headers: { Authorization: 'Bearer legacy-token' },
    })

    expect(res.status).toBe(403)
    expect(res.headers.get('set-cookie')).toBeNull()
    await expect(res.json()).resolves.toMatchObject({
      type: '/problems/auth-session-migration-legacy-token',
      status: 403,
    })
  })

  it.each(['session-cookie', 'session-query'] as const)(
    'rejects verified %s auth because migration requires a bearer',
    async (authMethod) => {
      const app = new Hono<HonoEnv>()
      app.use('*', async (c, next) => {
        c.set('userId', 1)
        c.set('authMethod', authMethod)
        await next()
      })
      app.route('/', authRoutes(makeDeps()))

      const res = await app.request('/api/v1/auth/session/migrate', { method: 'POST' })

      expect(res.status).toBe(403)
      expect(res.headers.get('set-cookie')).toBeNull()
      await expect(res.json()).resolves.toMatchObject({
        type: '/problems/auth-session-migration-requires-bearer',
        status: 403,
      })
    },
  )

  it('leaves an invalid bearer to the auth middleware', async () => {
    const app = createApp(makeDeps({ getUserCount: vi.fn(async () => 1) }))

    const res = await app.request('/api/v1/auth/session/migrate', {
      method: 'POST',
      headers: { Authorization: 'Bearer invalid-session' },
    })

    expect(res.status).toBe(401)
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('maps rotation conflicts to a stable generic 409 problem', async () => {
    const app = new Hono<HonoEnv>()
    app.use('*', async (c, next) => {
      c.set('userId', 1)
      c.set('authMethod', 'session-bearer')
      await next()
    })
    app.route('/', authRoutes(makeDeps()))

    const res = await app.request('/api/v1/auth/session/migrate', {
      method: 'POST',
      headers: { Authorization: 'Bearer already-consumed-session' },
    })

    expect(res.status).toBe(409)
    expect(res.headers.get('set-cookie')).toBeNull()
    await expect(res.json()).resolves.toEqual({
      type: '/problems/auth-session-migration-conflict',
      title: 'Session migration conflict',
      status: 409,
    })
  })
})

describe('POST /api/v1/auth/logout', () => {
  it('invalidates the session token', async () => {
    const app = createApp(makeDeps({ getUserCount: vi.fn(async () => 1) }))
    await createSession(1, 'session-token')

    const logoutRes = await app.request('/api/v1/auth/logout', {
      method: 'POST',
      headers: { Authorization: 'Bearer session-token' },
    })
    expect(logoutRes.status).toBe(204)
    expect(await logoutRes.text()).toBe('')

    // Token should no longer work
    const res = await app.request('/api/v1/settings', {
      headers: { Authorization: 'Bearer session-token' },
    })
    expect(res.status).toBe(401)
  })

  it('clears the session cookie on logout', async () => {
    const app = createApp(makeDeps({ getUserCount: vi.fn(async () => 1) }))
    await createSession(1, 'session-token')

    const logoutRes = await app.request('/api/v1/auth/logout', {
      method: 'POST',
      headers: { Authorization: 'Bearer session-token' },
    })
    expect(logoutRes.status).toBe(204)
    // The response should include a Set-Cookie header clearing the session cookie
    const setCookie = logoutRes.headers.get('set-cookie')
    expect(setCookie).not.toBeNull()
    expect(setCookie).toContain('djllama_session=')
    expect(setCookie?.toLowerCase()).toContain('max-age=0')
  })

  it('deletes session from cookie when no Bearer header is present', async () => {
    const app = createApp(makeDeps({ getUserCount: vi.fn(async () => 1) }))
    await createSession(1, 'session-token')

    // Logout without Bearer header, using cookie instead
    const logoutRes = await app.request('/api/v1/auth/logout', {
      method: 'POST',
      headers: { Cookie: 'djllama_session=session-token', ...sameOriginHeaders },
    })
    expect(logoutRes.status).toBe(204)

    // Token should no longer work (session was deleted from DB)
    const res = await app.request('/api/v1/settings', {
      headers: { Authorization: 'Bearer session-token' },
    })
    expect(res.status).toBe(401)
  })

  it('invalidates distinct bearer and cookie sessions while preserving other devices', async () => {
    const app = createApp(makeDeps({ getUserCount: vi.fn(async () => 1) }))
    await createSession(1, 'bearer-session')
    await createSession(1, 'cookie-session')
    await createSession(1, 'unrelated-session')

    const res = await app.request('/api/v1/auth/logout', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer bearer-session',
        Cookie: 'djllama_session=cookie-session',
      },
    })

    expect(res.status).toBe(204)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('set-cookie')).toContain('djllama_session=;')
    expect(res.headers.get('set-cookie')).toContain('Path=/')
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0')
    await expect(getSession('bearer-session')).resolves.toBeNull()
    await expect(getSession('cookie-session')).resolves.toBeNull()
    await expect(getSession('unrelated-session')).resolves.toEqual({ userId: 1 })
  })

  it('does not interpret a malformed Authorization value as a session token', async () => {
    const app = new Hono<HonoEnv>()
    app.route('/', authRoutes(makeDeps()))
    await createSession(1, 'opaque-header-value')
    await createSession(1, 'cookie-session')

    const res = await app.request('/api/v1/auth/logout', {
      method: 'POST',
      headers: {
        Authorization: 'opaque-header-value',
        Cookie: 'djllama_session=cookie-session',
      },
    })

    expect(res.status).toBe(204)
    await expect(getSession('opaque-header-value')).resolves.toEqual({ userId: 1 })
    await expect(getSession('cookie-session')).resolves.toBeNull()
  })
})

describe('GET /api/v1/auth/me', () => {
  it('returns current user when authenticated via session', async () => {
    const app = createApp(
      makeDeps({
        getUserById: vi.fn(async () => ({
          id: 1,
          username: 'testuser',
          isAdmin: false,
          preferences: null,
          email: null,
          authProvider: 'local',
          listenbrainzUsername: null,
          listenbrainzToken: null,
          lastfmUsername: null,
          lastfmApiKey: null,
          plexUrl: null,
          plexToken: null,
          plexSectionId: null,
          isOwner: false,
          hasMusicAccess: true,
          autoApproveRequests: false,
          plexAccessRevokedAt: null,
          plexAccountId: null,
          tasteProfileCache: null,
          tasteProfileCachedAt: null,
          createdAt: new Date(),
        })),
        getUserCount: vi.fn(async () => 1),
      }),
    )

    await createSession(1, 'session-token')
    const res = await app.request('/api/v1/auth/me', {
      headers: { Authorization: 'Bearer session-token' },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.username).toBe('testuser')
  })
})

describe('GET /api/v1/auth/validate', () => {
  it('returns 204 for a valid session token', async () => {
    const app = createApp(makeDeps({ getUserCount: vi.fn(async () => 1) }))

    await createSession(1, 'session-token')
    const res = await app.request('/api/v1/auth/validate', {
      headers: { Authorization: 'Bearer session-token' },
    })

    expect(res.status).toBe(204)
  })

  it('returns 401 when unauthenticated', async () => {
    const app = createApp(makeDeps({ getUserCount: vi.fn(async () => 1) }))
    const res = await app.request('/api/v1/auth/validate')
    expect(res.status).toBe(401)
  })
})

describe('PATCH /api/v1/auth/me/preferences', () => {
  it('rejects legacy read-only token auth', async () => {
    const app = new Hono<HonoEnv>()
    app.use('*', async (c, next) => {
      c.set('userId', 1)
      c.set('legacyTokenAuth', true)
      await next()
    })
    app.route('/', authRoutes(makeDeps()))

    const res = await app.request('/api/v1/auth/me/preferences', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        scoreThreshold: 0.8,
      }),
    })

    expect(res.status).toBe(403)
    expect(res.headers.get('content-type')).toContain('application/problem+json')
    await expect(res.json()).resolves.toMatchObject({
      type: '/problems/session-auth-required',
      title: 'Session authentication required',
      status: 403,
      code: 'errors.auth.notAuthenticated',
    })
  })
})

describe('GET /api/v1/auth/status', () => {
  it('reports hasUsers: false when no users exist', async () => {
    const app = createApp(makeDeps({ getUserCount: vi.fn(async () => 0) }))
    const res = await app.request('/api/v1/auth/status')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.hasUsers).toBe(false)
    expect(body.required).toBe(true)
  })

  it('reports hasUsers: true and required: true when users exist', async () => {
    const app = createApp(makeDeps({ getUserCount: vi.fn(async () => 2) }))
    const res = await app.request('/api/v1/auth/status')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.hasUsers).toBe(true)
    expect(body.required).toBe(true)
  })
})
