// @vitest-environment node

import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearAllSessions, createSession } from '@/core/sessions'
import type { AppDependencies } from '@/server'
import { createApp } from '@/server'

function makeMockOrchestrator() {
  const emitter = new EventEmitter()
  return Object.assign(emitter, {
    isRunning: false,
    run: vi.fn(async () => ({ batchId: 1 })),
  })
}

const adminUser = {
  id: 1,
  username: 'admin',
  isAdmin: true,
  preferences: null,
  email: null,
  authProvider: 'local' as const,
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

const regularUser = {
  id: 2,
  username: 'user2',
  isAdmin: false,
  preferences: null,
  email: null,
  authProvider: 'local' as const,
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
    // By default: caller is the admin user
    getUserById: vi.fn(async (id: number) => (id === 1 ? adminUser : null)),
    // Users exist so auth is required
    getUserCount: vi.fn(async () => 1),
    genreService: {} as unknown as AppDependencies['genreService'],
    libraryHealth: {} as unknown as AppDependencies['libraryHealth'],
    librarySync: {} as unknown as AppDependencies['librarySync'],
    librarySyncStore: {} as unknown as AppDependencies['librarySyncStore'],
    getEnabledTargetsForUser: vi.fn().mockResolvedValue([]),
    updateUser: vi.fn(async () => {}),
    listUsers: vi.fn(async () => [adminUser, regularUser]),
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

/** Register a session for userId 1 (admin) and return the bearer token. */
async function adminToken(): Promise<string> {
  const token = 'test-admin-token'
  await createSession(1, token)
  return token
}

/** Register a session for userId 2 (non-admin) and return the bearer token. */
async function regularToken(): Promise<string> {
  const token = 'test-regular-token'
  await createSession(2, token)
  return token
}

beforeEach(async () => {
  await clearAllSessions()
})

afterEach(async () => {
  delete process.env.DJLLAMA_AUTH_TOKEN
  await clearAllSessions()
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

// ---------------------------------------------------------------------------
// GET /api/v1/users
// ---------------------------------------------------------------------------

describe('GET /api/v1/users', () => {
  it('returns user list for admin', async () => {
    const token = await adminToken()
    const app = createApp(makeDeps())

    const res = await app.request('/api/v1/users', {
      headers: { Authorization: `Bearer ${token}` },
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
    expect(body).toHaveLength(2)
    expect(body[0].username).toBe('admin')
    expect(body[0]).not.toHaveProperty('plexToken')
    expect(body[0]).not.toHaveProperty('preferences')
    expect(body[0]).toHaveProperty('hasSignedIn')
  })

  it('returns 403 for non-admin', async () => {
    const token = await regularToken()
    const app = createApp(
      makeDeps({
        // Caller is user 2 (not admin)
        getUserById: vi.fn(async (id: number) => (id === 2 ? regularUser : null)),
      }),
    )

    const res = await app.request('/api/v1/users', {
      headers: { Authorization: `Bearer ${token}` },
    })

    expect(res.status).toBe(403)
  })

  it('returns 401 for unauthenticated', async () => {
    const app = createApp(makeDeps())
    // No Authorization header, but users exist so auth is required
    const res = await app.request('/api/v1/users')
    expect(res.status).toBe(401)
  })

  it('returns 403 for legacy token even when user 1 is admin', async () => {
    const token = 'legacy-users-token'
    const app = await createMountedAppWithLegacyToken(token, {
      getUserById: vi.fn(async (id: number) => (id === 1 ? adminUser : null)),
    })

    const res = await app.request('/api/v1/users', {
      headers: { Authorization: `Bearer ${token}` },
    })

    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// PATCH /api/v1/users/:id
// ---------------------------------------------------------------------------

describe('PATCH /api/v1/users/:id', () => {
  it('admin can toggle isAdmin on another user', async () => {
    const updateUser = vi.fn(async () => {})
    const token = await adminToken()
    const app = createApp(
      makeDeps({
        updateUser,
        getUserById: vi.fn(async (id: number) => {
          if (id === 1) return adminUser
          if (id === 2) return regularUser
          return null
        }),
      }),
    )

    const res = await app.request('/api/v1/users/2', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ isAdmin: true }),
    })

    expect(res.status).toBe(204)
    expect(updateUser).toHaveBeenCalledWith(2, { isAdmin: true })
  })

  it('prevents admin from removing own admin role', async () => {
    const token = await adminToken()
    const app = createApp(makeDeps())

    const res = await app.request('/api/v1/users/1', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ isAdmin: false }),
    })

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/own admin role/i)
  })

  it('returns 404 for non-existent user', async () => {
    const token = await adminToken()
    const app = createApp(
      makeDeps({
        // Admin check succeeds for id=1, target 99 not found
        getUserById: vi.fn(async (id: number) => (id === 1 ? adminUser : null)),
      }),
    )

    const res = await app.request('/api/v1/users/99', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ isAdmin: true }),
    })

    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// DELETE /api/v1/users/:id
// ---------------------------------------------------------------------------

describe('DELETE /api/v1/users/:id', () => {
  it('admin can delete another user', async () => {
    const deleteUser = vi.fn(async () => {})
    const token = await adminToken()
    const app = createApp(
      makeDeps({
        deleteUser,
        getUserById: vi.fn(async (id: number) => {
          if (id === 1) return adminUser
          if (id === 2) return regularUser
          return null
        }),
      }),
    )

    const res = await app.request('/api/v1/users/2', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })

    expect(res.status).toBe(204)
    expect(deleteUser).toHaveBeenCalledWith(2)
  })

  it('prevents admin from deleting self', async () => {
    const token = await adminToken()
    const app = createApp(makeDeps())

    const res = await app.request('/api/v1/users/1', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/own account/i)
  })

  it('returns 404 for non-existent user', async () => {
    const token = await adminToken()
    const app = createApp(
      makeDeps({
        getUserById: vi.fn(async (id: number) => (id === 1 ? adminUser : null)),
      }),
    )

    const res = await app.request('/api/v1/users/99', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })

    expect(res.status).toBe(404)
  })
})
