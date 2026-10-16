import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { markShuttingDown, resetLifecycleForTests } from '@/core/lifecycle'
import { createSession } from '@/core/sessions'
import type { AppDependencies } from '@/server'
import { createApp } from '@/server'

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
    getUserById: vi.fn(async () => null),
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

describe('GET /health', () => {
  afterEach(() => {
    resetLifecycleForTests()
  })

  it('returns 200 with status ok', async () => {
    const app = createApp(makeDeps())
    const res = await app.request('/health')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('ok')
  })

  it('includes version, gitSha and channel in the ok body', async () => {
    const app = createApp(makeDeps())
    const res = await app.request('/health')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/)
    expect(body.gitSha).toBe('dev')
    expect(body.channel).toBe('local')
  })

  it('reports the active db backend', async () => {
    const app = createApp(makeDeps())
    const res = await app.request('/health')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(['pglite', 'postgres']).toContain(body.dbBackend)
  })

  it('returns 503 with status draining when shutting down', async () => {
    const app = createApp(makeDeps())
    markShuttingDown()
    const res = await app.request('/health')
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.status).toBe('draining')
  })

  it('short-circuits DB check when shutting down', async () => {
    const execute = vi.fn(async () => [])
    const deps = makeDeps({
      db: { execute } as unknown as AppDependencies['db'],
    })
    const app = createApp(deps)
    markShuttingDown()
    await app.request('/health')
    expect(execute).not.toHaveBeenCalled()
  })
})

describe('setup guard', () => {
  it('blocks /api/* with 403 when setup is not complete', async () => {
    const app = createApp(makeDeps({ isSetupComplete: async () => false }))
    await createSession(1, 'health-test-token')
    const res = await app.request('/api/v1/something', {
      headers: { Authorization: 'Bearer health-test-token' },
    })
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toBe('Setup not complete')
    expect(body.redirect).toBe('/setup')
  })

  it('allows /api/setup/* through when setup is not complete', async () => {
    const app = createApp(makeDeps({ isSetupComplete: async () => false }))
    const res = await app.request('/api/v1/setup/status')
    expect(res.status).not.toBe(403)
  })

  it('allows /health through when setup is not complete', async () => {
    const app = createApp(makeDeps({ isSetupComplete: async () => false }))
    const res = await app.request('/health')
    expect(res.status).toBe(200)
  })

  it('allows /api/* through when setup is complete', async () => {
    const app = createApp(makeDeps())
    // No route registered for this path - expect 404, not 403
    const res = await app.request('/api/v1/something')
    expect(res.status).not.toBe(403)
  })
})
