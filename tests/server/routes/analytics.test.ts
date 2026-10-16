// @vitest-environment node

import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
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
    db: {
      execute: vi.fn(async () => ({ rows: [] })),
    } as unknown as AppDependencies['db'],
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
    getUserById: vi.fn(async () => ({
      id: 1,
      username: 'admin',
      isAdmin: true,
    })) as unknown as AppDependencies['getUserById'],
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

const SESSION_TOKEN = 'analytics-session-token'

async function authedRequest(
  app: ReturnType<typeof createApp>,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  await createSession(1, SESSION_TOKEN)
  return app.request(path, {
    ...init,
    headers: {
      Authorization: `Bearer ${SESSION_TOKEN}`,
      ...((init?.headers as Record<string, string> | undefined) ?? {}),
    },
  })
}

describe('GET /api/v1/analytics/overview', () => {
  it('returns 200 with expected shape on empty db', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [{ total_recs: 0, avg_score: 0, approved: 0, acted: 0 }],
      })
      .mockResolvedValueOnce({
        rows: [{ total: 0 }],
      })
    const app = createApp(makeDeps({ db: { execute } as unknown as AppDependencies['db'] }))
    const res = await authedRequest(app, '/api/v1/analytics/overview')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({
      totalRecs: 0,
      approvalRate: 0,
      avgScore: 0,
      totalBatches: 0,
    })
  })

  it('calculates approval rate correctly', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [{ total_recs: 10, avg_score: 0.75, approved: 3, acted: 5 }],
      })
      .mockResolvedValueOnce({
        rows: [{ total: 2 }],
      })
    const app = createApp(makeDeps({ db: { execute } as unknown as AppDependencies['db'] }))
    const res = await authedRequest(app, '/api/v1/analytics/overview')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.totalRecs).toBe(10)
    expect(body.approvalRate).toBeCloseTo(0.6)
    expect(body.avgScore).toBeCloseTo(0.75)
    expect(body.totalBatches).toBe(2)
  })
})

describe('GET /api/v1/analytics/batches', () => {
  it('returns 200 with empty array on empty db', async () => {
    const app = createApp(makeDeps())
    const res = await authedRequest(app, '/api/v1/analytics/batches')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual([])
  })

  it('returns batch data with counts', async () => {
    const execute = vi.fn().mockResolvedValueOnce({
      rows: [
        {
          id: 1,
          created_at: '2024-06-01T00:00:00Z',
          status: 'completed',
          stats: { discovered: 20, filtered: 5, added: 15, failed: 0 },
          total: 15,
          approved: 5,
          rejected: 3,
          pending: 7,
        },
      ],
    })
    const app = createApp(makeDeps({ db: { execute } as unknown as AppDependencies['db'] }))
    const res = await authedRequest(app, '/api/v1/analytics/batches')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveLength(1)
    expect(body[0].id).toBe(1)
    expect(body[0].approved).toBe(5)
    expect(body[0].rejected).toBe(3)
    expect(body[0].pending).toBe(7)
    expect(body[0].total).toBe(15)
  })
})

describe('GET /api/v1/analytics/genres', () => {
  it('returns 200 with empty array on empty db', async () => {
    const app = createApp(makeDeps())
    const res = await authedRequest(app, '/api/v1/analytics/genres')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual([])
  })

  it('returns genre stats with approval rate', async () => {
    const execute = vi.fn().mockResolvedValueOnce({
      rows: [
        { genre: 'rock', count: 10, approved: 4 },
        { genre: 'jazz', count: 5, approved: 3 },
      ],
    })
    const app = createApp(makeDeps({ db: { execute } as unknown as AppDependencies['db'] }))
    const res = await authedRequest(app, '/api/v1/analytics/genres')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveLength(2)
    expect(body[0].genre).toBe('rock')
    expect(body[0].approvalRate).toBeCloseTo(0.4)
    expect(body[1].genre).toBe('jazz')
    expect(body[1].approvalRate).toBeCloseTo(0.6)
  })
})
