// @vitest-environment node
import { lookup } from 'node:dns/promises'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearAllSessions, createSession } from '@/core/sessions'
import type { SettingsRow } from '@/db/queries/settings'
import type { UserConnections } from '@/db/queries/users'
import type { AppDependencies } from '@/server'
import { createApp } from '@/server'

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(),
}))

const { mockGetUserConnections, mockUpdateUserConnections } = vi.hoisted(() => ({
  mockGetUserConnections: vi.fn(async () => ({
    plexUrl: null as string | null,
    plexToken: null as string | null,
    plexSectionId: null as string | null,
    plexAccountId: null as number | null,
  })),
  mockUpdateUserConnections: vi.fn(async () => {}),
}))

const { mockCreatePlexClient } = vi.hoisted(() => ({
  mockCreatePlexClient: vi.fn(() => ({
    testConnection: vi.fn(async () => ({
      success: true,
      message: 'Connected to Plex',
    })),
  })),
}))

vi.mock('@/db/queries/users', async () => {
  const actual = await vi.importActual<typeof import('@/db/queries/users')>('@/db/queries/users')
  return {
    ...actual,
    getUserConnections: mockGetUserConnections,
    updateUserConnections: mockUpdateUserConnections,
  }
})

vi.mock('@/core/clients/plex', () => ({
  createPlexClient: mockCreatePlexClient,
}))

vi.mock('@/core/notifications', () => ({
  dispatch: vi.fn(),
}))

const { mockUpsertSystemTarget, mockDisableSystemTarget } = vi.hoisted(() => ({
  mockUpsertSystemTarget: vi.fn(async () => ({ id: 1 })),
  mockDisableSystemTarget: vi.fn(async () => {}),
}))

vi.mock('@/db/queries/targets', () => ({
  upsertSystemTarget: mockUpsertSystemTarget,
  disableSystemTarget: mockDisableSystemTarget,
}))

const mockSettings = {
  id: 1,
  lidarrUrl: 'http://lidarr:8686',
  lidarrApiKey: 'secret-key',
  aiProvider: 'ollama',
  aiApiKey: null,
  aiModel: 'llama3',
  aiBaseUrl: 'http://ollama:11434',
  preferences: null,
  setupComplete: true,
  createdAt: new Date('2024-01-01').toISOString(),
  updatedAt: new Date('2024-01-01').toISOString(),
}

const defaultUserConnections: UserConnections = {
  username: 'test-user',
  plexUrl: null,
  plexToken: null,
  plexSectionId: null,
  plexAccountId: null,
}

function makeMockOrchestrator() {
  const { EventEmitter } = require('node:events')
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
    getSettings: vi.fn(async () => mockSettings as unknown as SettingsRow),
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
    restartLibraryMaintenanceScheduler: vi.fn(),
    restartDigestNotifier: vi.fn(async () => {}),
    createUser: vi.fn(async () => ({
      id: 1,
      username: 'test',
      isAdmin: false,
      preferences: null,
      email: null,
      authProvider: 'local',
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
      preferences: null,
      email: null,
      authProvider: 'local',
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

const SESSION_TOKEN = 'settings-session-token'

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

describe('GET /api/v1/settings', () => {
  it('returns settings with secrets masked', async () => {
    mockGetUserConnections.mockResolvedValueOnce(defaultUserConnections)
    const app = createApp(makeDeps())
    const res = await authedRequest(app, '/api/v1/settings')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.lidarrUrl).toBe('http://lidarr:8686')
    expect(body.lidarrApiKey).toBe('***')
    expect(body.aiApiKey).toBeNull()
  })

  it('preserves null secret fields instead of pretending they were saved', async () => {
    mockGetUserConnections.mockResolvedValueOnce(defaultUserConnections)
    const app = createApp(makeDeps())
    const res = await authedRequest(app, '/api/v1/settings')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.aiApiKey).toBeNull()
  })

  it('returns 403 when setup not complete', async () => {
    const app = createApp(makeDeps({ isSetupComplete: async () => false }))
    const res = await authedRequest(app, '/api/v1/settings')
    expect(res.status).toBe(403)
  })

  it('returns 404 when no settings exist', async () => {
    const app = createApp(makeDeps({ getSettings: vi.fn(async () => null) }))
    const res = await authedRequest(app, '/api/v1/settings')
    expect(res.status).toBe(404)
  })
})

describe('PATCH /api/v1/settings', () => {
  beforeEach(() => {
    mockUpsertSystemTarget.mockClear()
    mockDisableSystemTarget.mockClear()
  })

  it('calls updateSettings and returns updated settings', async () => {
    const updateSettings = vi.fn(async () => {})
    const updatedSettings = { ...mockSettings, lidarrUrl: 'http://new:8686' }
    const getSettings = vi.fn(async () => updatedSettings as unknown as SettingsRow)
    const app = createApp(makeDeps({ updateSettings, getSettings }))

    const res = await authedRequest(app, '/api/v1/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lidarrUrl: 'http://new:8686' }),
    })
    expect(res.status).toBe(200)
    expect(updateSettings).toHaveBeenCalledTimes(1)
    const body = await res.json()
    expect(body.lidarrUrl).toBe('http://new:8686')
  })

  it('re-syncs the system Lidarr target when lidarrUrl changes', async () => {
    const updatedSettings = {
      ...mockSettings,
      lidarrUrl: 'http://new:8686',
      lidarrApiKey: 'secret-key',
    }
    const getSettings = vi.fn(async () => updatedSettings as unknown as SettingsRow)
    const app = createApp(makeDeps({ getSettings }))

    await authedRequest(app, '/api/v1/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lidarrUrl: 'http://new:8686' }),
    })

    expect(mockUpsertSystemTarget).toHaveBeenCalledWith(
      expect.anything(),
      'lidarr',
      'Lidarr',
      expect.objectContaining({ url: 'http://new:8686', apiKey: 'secret-key' }),
    )
    expect(mockDisableSystemTarget).not.toHaveBeenCalled()
  })

  it('disables the system Lidarr target when the API key is cleared', async () => {
    const updatedSettings = { ...mockSettings, lidarrApiKey: '' }
    const getSettings = vi.fn(async () => updatedSettings as unknown as SettingsRow)
    const app = createApp(makeDeps({ getSettings }))

    await authedRequest(app, '/api/v1/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lidarrApiKey: '' }),
    })

    expect(mockDisableSystemTarget).toHaveBeenCalledWith(expect.anything(), 'lidarr')
    expect(mockUpsertSystemTarget).not.toHaveBeenCalled()
  })

  it('does not touch the system Lidarr target for unrelated field changes', async () => {
    const app = createApp(makeDeps())

    await authedRequest(app, '/api/v1/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aiProvider: 'openai', aiModel: 'gpt-5' }),
    })

    expect(mockUpsertSystemTarget).not.toHaveBeenCalled()
    expect(mockDisableSystemTarget).not.toHaveBeenCalled()
  })

  it('restarts scheduler when cron is updated', async () => {
    const restartScheduler = vi.fn()
    const app = createApp(makeDeps({ restartScheduler }))
    const res = await authedRequest(app, '/api/v1/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preferences: { scheduleCron: '0 3 * * *' } }),
    })
    expect(res.status).toBe(200)
    expect(restartScheduler).toHaveBeenCalledWith('0 3 * * *')
  })

  it('stops scheduler when cron is set to empty string', async () => {
    const restartScheduler = vi.fn()
    const app = createApp(makeDeps({ restartScheduler }))
    const res = await authedRequest(app, '/api/v1/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preferences: { scheduleCron: '' } }),
    })
    expect(res.status).toBe(200)
    expect(restartScheduler).toHaveBeenCalledWith(null)
  })

  it('returns warning when cron expression is invalid', async () => {
    const restartScheduler = vi.fn(() => {
      throw new TypeError('Invalid cron expression')
    })
    const app = createApp(makeDeps({ restartScheduler }))
    const res = await authedRequest(app, '/api/v1/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preferences: { scheduleCron: 'not a cron' } }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.warning).toBe('Settings saved but cron expression is invalid')
  })

  it('does not restart scheduler when preferences lack scheduleCron', async () => {
    const restartScheduler = vi.fn()
    const app = createApp(makeDeps({ restartScheduler }))
    const res = await authedRequest(app, '/api/v1/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preferences: { librarySeedRatio: 0.5 } }),
    })
    expect(res.status).toBe(200)
    expect(restartScheduler).not.toHaveBeenCalled()
  })

  it('does not restart scheduler when scheduleCron only exists in stored preferences', async () => {
    const restartScheduler = vi.fn()
    const getSettings = vi.fn(
      async () =>
        ({
          ...mockSettings,
          preferences: {
            scheduleCron: '0 4 * * *',
            playlistEnabled: false,
          },
        }) as unknown as SettingsRow,
    )
    const app = createApp(makeDeps({ restartScheduler, getSettings }))

    const res = await authedRequest(app, '/api/v1/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preferences: { librarySeedRatio: 0.4 } }),
    })

    expect(res.status).toBe(200)
    expect(restartScheduler).not.toHaveBeenCalled()
  })

  it('restarts playlist scheduling when playlist preferences change', async () => {
    const restartPlaylistScheduler = vi.fn(async () => {})
    const app = createApp(makeDeps({ restartPlaylistScheduler }))
    const res = await authedRequest(app, '/api/v1/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preferences: { playlistSchedule: '0 7 * * 1' } }),
    })
    expect(res.status).toBe(200)
    expect(restartPlaylistScheduler).toHaveBeenCalledOnce()
  })

  it('restarts playlist scheduling when AI provider/model change', async () => {
    const restartPlaylistScheduler = vi.fn(async () => {})
    const app = createApp(makeDeps({ restartPlaylistScheduler }))
    const res = await authedRequest(app, '/api/v1/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aiProvider: 'openai', aiModel: 'gpt-4' }),
    })
    expect(res.status).toBe(200)
    expect(restartPlaylistScheduler).toHaveBeenCalledOnce()
  })

  it('does not restart playlist scheduling when playlist fields only exist in stored preferences', async () => {
    const restartPlaylistScheduler = vi.fn(async () => {})
    const getSettings = vi.fn(
      async () =>
        ({
          ...mockSettings,
          preferences: {
            scheduleCron: null,
            playlistSchedule: '0 6 * * 1',
          },
        }) as unknown as SettingsRow,
    )
    const app = createApp(makeDeps({ restartPlaylistScheduler, getSettings }))

    const res = await authedRequest(app, '/api/v1/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preferences: { librarySeedRatio: 0.4 } }),
    })

    expect(res.status).toBe(200)
    expect(restartPlaylistScheduler).not.toHaveBeenCalled()
  })

  it('does not restart scheduler when no preferences in body', async () => {
    const restartScheduler = vi.fn()
    const app = createApp(makeDeps({ restartScheduler }))
    const res = await authedRequest(app, '/api/v1/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lidarrUrl: 'http://new:8686' }),
    })
    expect(res.status).toBe(200)
    expect(restartScheduler).not.toHaveBeenCalled()
  })

  it('restarts library maintenance scheduling when the sync interval is updated', async () => {
    const restartLibraryMaintenanceScheduler = vi.fn()
    const app = createApp(makeDeps({ restartLibraryMaintenanceScheduler }))
    const res = await authedRequest(app, '/api/v1/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ librarySyncIntervalHours: 12 }),
    })

    expect(res.status).toBe(200)
    expect(restartLibraryMaintenanceScheduler).toHaveBeenCalledWith(12)
  })

  it('restarts the digest notifier when digestCron is updated', async () => {
    const restartDigestNotifier = vi.fn(async () => {})
    const app = createApp(makeDeps({ restartDigestNotifier }))
    const res = await authedRequest(app, '/api/v1/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preferences: { digestCron: '0 6 * * 1' } }),
    })
    expect(res.status).toBe(200)
    expect(restartDigestNotifier).toHaveBeenCalledOnce()
  })

  it('returns warning when the digest cron expression is invalid', async () => {
    const restartDigestNotifier = vi.fn(async () => {
      throw new TypeError('Invalid cron expression')
    })
    const app = createApp(makeDeps({ restartDigestNotifier }))
    const res = await authedRequest(app, '/api/v1/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preferences: { digestCron: 'not a cron' } }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.warning).toBe('Settings saved but cron expression is invalid')
  })

  it('does not restart the digest notifier when preferences lack digestCron', async () => {
    const restartDigestNotifier = vi.fn(async () => {})
    const app = createApp(makeDeps({ restartDigestNotifier }))
    const res = await authedRequest(app, '/api/v1/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preferences: { librarySeedRatio: 0.5 } }),
    })
    expect(res.status).toBe(200)
    expect(restartDigestNotifier).not.toHaveBeenCalled()
  })

  it('merges partial preference updates with the stored preferences blob', async () => {
    const updateSettings = vi.fn(async () => {})
    const getSettings = vi.fn(
      async () =>
        ({
          ...mockSettings,
          preferences: {
            scoreThreshold: 0.72,
            rejectionCooldownDays: 45,
            seasonalPlaylistsEnabled: false,
          },
        }) as unknown as SettingsRow,
    )
    const app = createApp(makeDeps({ updateSettings, getSettings }))

    const res = await authedRequest(app, '/api/v1/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preferences: { seasonalPlaylistsEnabled: true } }),
    })

    expect(res.status).toBe(200)
    expect(updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        preferences: {
          scoreThreshold: 0.72,
          rejectionCooldownDays: 45,
          seasonalPlaylistsEnabled: true,
        },
      }),
    )
  })

  it('returns 403 when setup not complete', async () => {
    const app = createApp(makeDeps({ isSetupComplete: async () => false }))
    const res = await authedRequest(app, '/api/v1/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lidarrUrl: 'http://new:8686' }),
    })
    expect(res.status).toBe(403)
  })
})

describe('POST /api/v1/settings/test/:service', () => {
  it('requires admin access for every settings test service', async () => {
    await clearAllSessions()
    await createSession(7, 'non-admin-settings-test-token')

    const app = createApp(
      makeDeps({
        getUserCount: vi.fn(async () => 1),
        getUserById: vi.fn(async () => ({
          id: 7,
          username: 'user7',
          isAdmin: false,
          preferences: null,
          email: null,
          authProvider: 'local',
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
      }),
    )

    const services = ['lidarr', 'ai', 'plex', 'spotify', 'oidc']

    for (const service of services) {
      const res = await app.request(`/api/v1/settings/test/${service}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer non-admin-settings-test-token',
        },
        body: JSON.stringify({}),
      })

      expect(res.status, `service: ${service}`).toBe(403)
      const body = await res.json()
      expect(body.type).toBe('/problems/admin-required')
      expect(body.title).toBe('Admin access required')
    }
  })

  it.each([
    ['explicit', { sectionId: 'music-1' }, 'music-1'],
    ['empty', { sectionId: '' }, ''],
    ['omitted', {}, 'stored-music'],
  ])('passes the %s Plex library selection to the client', async (_case, selection, expected) => {
    mockCreatePlexClient.mockClear()
    mockGetUserConnections.mockResolvedValueOnce({
      ...defaultUserConnections,
      plexSectionId: 'stored-music',
    })
    const app = createApp(makeDeps())

    const res = await authedRequest(app, '/api/v1/settings/test/plex', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: 'http://plex:32400',
        token: 'plex-token',
        ...selection,
      }),
    })

    expect(res.status).toBe(200)
    expect(mockCreatePlexClient).toHaveBeenCalledWith('http://plex:32400', 'plex-token', {
      sectionId: expected,
    })
  })

  it('surfaces failed probe detail with secrets redacted', async () => {
    vi.mocked(lookup).mockResolvedValue({ address: '127.0.0.1', family: 4 })
    const providerRegistry = {
      create: vi.fn(async () => ({
        testConnection: vi.fn(async () => ({
          success: false,
          message: `models/llama3 is not found for key sk-abcdefgh12345678\n${'x'.repeat(400)}`,
        })),
      })),
    }

    const app = createApp(makeDeps({ providerRegistry: providerRegistry as never }))
    const res = await authedRequest(app, '/api/v1/settings/test/ai', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        provider: 'ollama',
        model: 'llama3',
        baseUrl: 'http://127.0.0.1:11434',
      }),
    })

    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.type).toBe('/problems/probe-failed')
    // Upstream detail is surfaced so admins can act on it (missing model,
    // malformed field), but credential-shaped substrings are redacted and the
    // whole detail is capped.
    expect(body.detail).toContain('models/llama3 is not found')
    expect(body.detail).not.toContain('sk-abcdefgh12345678')
    expect(body.detail).toContain('[redacted]')
    expect(body.detail.length).toBeLessThanOrEqual(300)
  })

  it('falls back to the unknown-error detail when the probe message is empty', async () => {
    vi.mocked(lookup).mockResolvedValue({ address: '127.0.0.1', family: 4 })
    const providerRegistry = {
      create: vi.fn(async () => ({
        testConnection: vi.fn(async () => ({ success: false, message: '' })),
      })),
    }

    const app = createApp(makeDeps({ providerRegistry: providerRegistry as never }))
    const res = await authedRequest(app, '/api/v1/settings/test/ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'ollama',
        model: 'llama3',
        baseUrl: 'http://127.0.0.1:11434',
      }),
    })

    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.detail).toBe('Unknown error')
  })

  it('tests lidarr and returns 200 or 502 with problem+json', async () => {
    const app = createApp(makeDeps())
    // Client will fail to connect - 502 problem+json, not a 200 with success:false
    const res = await authedRequest(app, '/api/v1/settings/test/lidarr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'http://invalid-lidarr:9999', apiKey: 'key' }),
    })
    expect([200, 502]).toContain(res.status)
    const body = await res.json()
    if (res.status === 200) expect(typeof body.message).toBe('string')
    else expect(body.type).toBe('/problems/probe-failed')
  })

  it('tests ai provider and returns 200 or 502 with problem+json', async () => {
    vi.mocked(lookup).mockResolvedValue({ address: '93.184.216.34', family: 4 })
    const app = createApp(makeDeps())
    const res = await authedRequest(app, '/api/v1/settings/test/ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'ollama',
        apiKey: null,
        model: 'llama3',
        baseUrl: 'http://ollama.example.com:11434',
      }),
    })
    expect([200, 502]).toContain(res.status)
    const body = await res.json()
    if (res.status === 200) expect(typeof body.message).toBe('string')
    else expect(body.type).toBe('/problems/probe-failed')
  })

  it('includes optional probe metadata on successful connection tests', async () => {
    vi.mocked(lookup).mockResolvedValue({ address: '93.184.216.34', family: 4 })
    const providerRegistry = {
      create: vi.fn(async () => ({
        testConnection: vi.fn(async () => ({
          success: true,
          message: 'Connected to test provider',
          details: { version: '1.2.3' },
        })),
      })),
    }
    const app = createApp(makeDeps({ providerRegistry: providerRegistry as never }))

    const res = await authedRequest(app, '/api/v1/settings/test/ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'ollama',
        model: 'llama3',
        baseUrl: 'http://ollama.example.com:11434',
      }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({
      message: 'Connected to test provider',
      version: '1.2.3',
    })
    expect(body.latencyMs).toEqual(expect.any(Number))
    expect(body.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('returns 400 for unknown service', async () => {
    const app = createApp(makeDeps())
    const res = await authedRequest(app, '/api/v1/settings/test/unknown', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  it('blocks test endpoints until setup is complete', async () => {
    const app = createApp(makeDeps({ isSetupComplete: async () => false }))
    const res = await authedRequest(app, '/api/v1/settings/test/lidarr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'http://lidarr:8686', apiKey: 'key' }),
    })
    expect(res.status).toBe(403)
  })
})

describe('per-user listening source connections', () => {
  it('GET requires authentication once setup is complete', async () => {
    // Users exist -> non-degenerate state. authGuard 401s the unauthenticated
    // call. (Degenerate state `setupComplete=true && no users` returns 503,
    // covered separately in auth-status-shape.test.ts.)
    const app = createApp(makeDeps({ getUserCount: vi.fn(async () => 1) }))
    const res = await app.request('/api/v1/settings')
    expect(res.status).toBe(401)
  })

  it('PATCH requires authentication once setup is complete', async () => {
    const updateSettings = vi.fn(async () => {})
    const app = createApp(makeDeps({ updateSettings, getUserCount: vi.fn(async () => 1) }))

    const res = await app.request('/api/v1/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lidarrUrl: 'http://lidarr:8686',
      }),
    })
    expect(res.status).toBe(401)
    expect(updateSettings).not.toHaveBeenCalled()
  })
})

describe('POST /api/v1/settings/test-webhook', () => {
  function appWithWebhook() {
    return createApp(
      makeDeps({
        getSettings: vi.fn(
          async () =>
            ({
              ...mockSettings,
              preferences: { webhookUrl: 'http://hooks.internal:9000/notify' },
            }) as unknown as SettingsRow,
        ),
      }),
    )
  }

  it('returns 204 when the dispatched channel succeeds', async () => {
    const { dispatch } = await import('@/core/notifications')
    vi.mocked(dispatch).mockResolvedValueOnce([{ id: 'legacy-webhook', type: 'webhook', ok: true }])

    const res = await authedRequest(appWithWebhook(), '/api/v1/settings/test-webhook', {
      method: 'POST',
    })
    expect(res.status).toBe(204)
  })

  it('returns 502 with a redacted detail when the channel fails', async () => {
    const { dispatch } = await import('@/core/notifications')
    // A dispatch error may carry a secret-bearing URL; the route must redact
    // it before echoing it in the problem+json detail (defense-in-depth).
    vi.mocked(dispatch).mockResolvedValueOnce([
      {
        id: 'legacy-webhook',
        type: 'webhook',
        ok: false,
        error: 'POST failed: https://hooks.example.com/notify?token=SUPERSECRET123 returned 500',
      },
    ])

    const res = await authedRequest(appWithWebhook(), '/api/v1/settings/test-webhook', {
      method: 'POST',
    })
    expect(res.status).toBe(502)
    const body = (await res.json()) as { detail?: string }
    const serialized = JSON.stringify(body)
    // The raw secret token must not leak into the response.
    expect(serialized).not.toContain('SUPERSECRET123')
    expect(body.detail).toContain('[redacted]')
  })

  it('returns 400 when an inline channel body fails schema validation', async () => {
    const res = await authedRequest(appWithWebhook(), '/api/v1/settings/test-webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Inline path (type + id present) but missing required telegram fields.
      body: JSON.stringify({ id: 'bad', type: 'telegram' }),
    })
    expect(res.status).toBe(400)
  })

  it('returns 400 when no notification channel is configured', async () => {
    const app = createApp(
      makeDeps({
        getSettings: vi.fn(
          async () => ({ ...mockSettings, preferences: {} }) as unknown as SettingsRow,
        ),
      }),
    )
    const res = await authedRequest(app, '/api/v1/settings/test-webhook', { method: 'POST' })
    expect(res.status).toBe(400)
  })
})
