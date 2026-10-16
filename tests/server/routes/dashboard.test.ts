// @vitest-environment node

import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SettingsRow } from '@/db/queries/settings'
import type { AppDependencies } from '@/server'
import { dashboardRoutes } from '@/server/routes/dashboard'

const USER_ID = 42

function makeDeps(overrides: Partial<AppDependencies> = {}): AppDependencies {
  return {
    db: { execute: vi.fn(async () => []) } as unknown as AppDependencies['db'],
    storeDb: {} as unknown as AppDependencies['storeDb'],
    orchestrator: {} as unknown as AppDependencies['orchestrator'],
    scheduler: {
      schedule: vi.fn(),
      remove: vi.fn(),
      has: vi.fn(() => false),
      listJobs: vi.fn(() => []),
      stopAll: vi.fn(),
      nextRun: vi.fn(() => null),
    } as unknown as AppDependencies['scheduler'],
    providerRegistry: {} as unknown as AppDependencies['providerRegistry'],
    isSetupComplete: async () => true,
    getSettings: vi.fn(
      async () =>
        ({
          id: 1,
          lidarrUrl: 'http://lidarr:8686',
          lidarrApiKey: 'key',
          preferences: {},
        }) as SettingsRow,
    ),
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
    createUser: vi.fn(async () => ({
      id: 1,
      username: 'test',
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
    getUserByUsername: vi.fn(async () => null),
    getUserById: vi.fn(async (id: number) =>
      id === USER_ID
        ? {
            id: USER_ID,
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
          }
        : null,
    ),
    getUserCount: vi.fn(async () => 0),
    genreService: {
      getLibraryGenres: vi.fn(async () => []),
      search: vi.fn(async () => []),
      getOrFetchGenre: vi.fn(async () => null),
      getSubGenres: vi.fn(async () => []),
      seedFromLibrary: vi.fn(async () => {}),
      slugify: vi.fn((name: string) => name.toLowerCase()),
      isStale: vi.fn(() => false),
    } as unknown as AppDependencies['genreService'],
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

function createTestApp(deps: AppDependencies, userId: number | undefined) {
  const app = new Hono()
  app.use('*', async (c, next) => {
    if (userId !== undefined) {
      c.set('userId' as never, userId as never)
    }
    return next()
  })
  app.route('/', dashboardRoutes(deps))
  return app
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  delete process.env.DJLLAMA_AUTH_TOKEN
})

async function createMountedAppWithLegacyToken(
  token: string,
  overrides: Partial<AppDependencies> = {},
) {
  vi.resetModules()
  process.env.DJLLAMA_AUTH_TOKEN = token
  const { createApp } = await import('@/server')
  return createApp(makeDeps(overrides))
}

describe('GET /api/v1/dashboard/taste', () => {
  it('returns array of taste genres', async () => {
    const mockResult = {
      genres: [{ genre: 'post-rock', count: 5, percentage: 32 }],
      title: 'Basement Show Regular',
      reasoning: 'You keep coming back to post-rock.',
    }
    const deps = makeDeps({
      dashboardQueries: {
        getTasteProfile: vi.fn(async () => mockResult),
        getLatestGenreCoverage: vi.fn(async () => null),
        getRecentActivity: vi.fn(async () => []),
      },
    })
    const app = createTestApp(deps, USER_ID)
    const res = await app.request('/api/v1/dashboard/taste')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject(mockResult)
    expect(deps.dashboardQueries.getTasteProfile).toHaveBeenCalledWith(USER_ID)
  })

  it('passes undefined userId when not authenticated', async () => {
    const deps = makeDeps()
    const app = createTestApp(deps, undefined)
    const res = await app.request('/api/v1/dashboard/taste')
    expect(res.status).toBe(200)
    expect(deps.dashboardQueries.getTasteProfile).toHaveBeenCalledWith(undefined)
  })
})

describe('GET /api/v1/dashboard/genre-coverage', () => {
  it('returns the latest user-scoped pipeline coverage', async () => {
    const coverage = { coveredArtists: 18, pendingArtists: 4, totalArtists: 25 }
    const getLatestGenreCoverage = vi.fn(async () => coverage)
    const deps = makeDeps({
      dashboardQueries: {
        getTasteProfile: vi.fn(async () => ({ genres: [] })),
        getRecentActivity: vi.fn(async () => []),
        getLatestGenreCoverage,
      },
    })
    const app = createTestApp(deps, USER_ID)

    const res = await app.request('/api/v1/dashboard/genre-coverage')

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual(coverage)
    expect(getLatestGenreCoverage).toHaveBeenCalledWith(USER_ID)
  })

  it('returns null before a pipeline has recorded coverage', async () => {
    const deps = makeDeps({
      dashboardQueries: {
        getTasteProfile: vi.fn(async () => ({ genres: [] })),
        getRecentActivity: vi.fn(async () => []),
        getLatestGenreCoverage: vi.fn(async () => null),
      },
    })
    const app = createTestApp(deps, USER_ID)

    const res = await app.request('/api/v1/dashboard/genre-coverage')

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toBeNull()
  })
})

describe('GET /api/v1/dashboard/activity', () => {
  it('returns array of activity entries', async () => {
    const mockActivity = [
      {
        type: 'approved' as const,
        timestamp: '2026-03-21T10:00:00Z',
        data: { artistName: 'Slowdive' },
      },
    ]
    const deps = makeDeps({
      dashboardQueries: {
        getTasteProfile: vi.fn(async () => ({ genres: [] })),
        getLatestGenreCoverage: vi.fn(async () => null),
        getRecentActivity: vi.fn(async () => mockActivity),
      },
    })
    const app = createTestApp(deps, USER_ID)
    const res = await app.request('/api/v1/dashboard/activity')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
    expect(body).toHaveLength(1)
    expect(body[0]).toMatchObject({ type: 'approved', data: { artistName: 'Slowdive' } })
  })

  it('passes limit from query param', async () => {
    const deps = makeDeps()
    const app = createTestApp(deps, USER_ID)
    const res = await app.request('/api/v1/dashboard/activity?limit=3')
    expect(res.status).toBe(200)
    expect(deps.dashboardQueries.getRecentActivity).toHaveBeenCalledWith(
      USER_ID,
      expect.any(Boolean),
      3,
    )
  })

  it('caps limit at 20', async () => {
    const deps = makeDeps()
    const app = createTestApp(deps, USER_ID)
    const res = await app.request('/api/v1/dashboard/activity?limit=100')
    expect(res.status).toBe(200)
    expect(deps.dashboardQueries.getRecentActivity).toHaveBeenCalledWith(
      USER_ID,
      expect.any(Boolean),
      20,
    )
  })

  it('returns 400 when limit is not an integer', async () => {
    const deps = makeDeps()
    const app = createTestApp(deps, USER_ID)
    const res = await app.request('/api/v1/dashboard/activity?limit=abc')
    expect(res.status).toBe(400)
    expect(deps.dashboardQueries.getRecentActivity).not.toHaveBeenCalled()
  })

  it('treats legacy-token auth as non-admin even when user 1 is admin', async () => {
    const token = 'legacy-dashboard-token'
    const getRecentActivity = vi.fn(async () => [])
    const app = await createMountedAppWithLegacyToken(token, {
      getUserById: vi.fn(async () => ({
        id: 1,
        username: 'admin',
        isAdmin: true,
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
      })) as unknown as AppDependencies['getUserById'],
      dashboardQueries: {
        getTasteProfile: vi.fn(async () => ({ genres: [] })),
        getLatestGenreCoverage: vi.fn(async () => null),
        getRecentActivity,
      },
    })

    const res = await app.request('/api/v1/dashboard/activity', {
      headers: { Authorization: `Bearer ${token}` },
    })

    expect(res.status).toBe(200)
    expect(getRecentActivity).toHaveBeenCalledWith(1, false, 5)
  }, 15_000)
})
