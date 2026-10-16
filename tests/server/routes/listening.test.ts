// @vitest-environment node

import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppDependencies } from '@/server'

vi.mock('@/db/queries/users', () => ({
  getUserConnections: vi.fn(),
}))

vi.mock('@/core/clients/lidarr', () => ({
  createLidarrClient: vi.fn(),
}))

vi.mock('@/core/clients/plex', () => ({
  createPlexClient: vi.fn(),
}))

import { createPlexClient } from '@/core/clients/plex'
import { getUserConnections } from '@/db/queries/users'
import { listeningRoutes } from '@/server/routes/listening'

const USER_ID = 42

const mockGetUserConnections = getUserConnections as typeof getUserConnections & {
  mockResolvedValue: (value: Awaited<ReturnType<typeof getUserConnections>>) => void
}
const mockCreatePlexClient = createPlexClient as typeof createPlexClient & {
  mockReturnValue: (value: ReturnType<typeof createPlexClient>) => void
}

function emptyConnections() {
  return {
    username: 'test-user',
    plexUrl: null,
    plexToken: null,
    plexSectionId: null,
    plexAccountId: null,
  }
}

function makeDeps(
  overrides: Partial<Pick<AppDependencies, 'db' | 'getSettings'>> = {},
): AppDependencies {
  return {
    db: {} as AppDependencies['db'],
    storeDb: {} as AppDependencies['storeDb'],
    orchestrator: {} as AppDependencies['orchestrator'],
    scheduler: {} as AppDependencies['scheduler'],
    providerRegistry: {} as AppDependencies['providerRegistry'],
    isSetupComplete: vi.fn(async () => true),
    getSettings: vi.fn(
      async () =>
        ({
          id: 1,
          setupComplete: true,
          lidarrUrl: null,
          lidarrApiKey: null,
          skipTlsVerify: false,
          plexAdminToken: null,
        }) as Awaited<ReturnType<AppDependencies['getSettings']>>,
    ),
    updateSettings: vi.fn(async () => {}),
    completeSetup: vi.fn(async () => ({})),
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
    filterOwnedIds: vi.fn(async () => []),
    listBatches: vi.fn(async () => []),
    getBatch: vi.fn(async () => null),
    getArtistById: vi.fn(async () => null),
    restartScheduler: vi.fn(),
    restartPlaylistScheduler: vi.fn(async () => {}),
    createUser: vi.fn(async () => ({
      id: 1,
      username: 'user',
      isAdmin: false,
    })) as unknown as AppDependencies['createUser'],
    getUserByUsername: vi.fn(async () => null),
    getUserById: vi.fn(async () => null),
    getUserCount: vi.fn(async () => 1),
    updateUser: vi.fn(async () => {}),
    listUsers: vi.fn(async () => []),
    deleteUser: vi.fn(async () => {}),
    genreService: {} as AppDependencies['genreService'],
    libraryHealth: {} as AppDependencies['libraryHealth'],
    librarySync: {} as AppDependencies['librarySync'],
    librarySyncStore: {
      findReconciledByNormalizedName: vi.fn(async () => []),
    } as unknown as AppDependencies['librarySyncStore'],
    getEnabledTargetsForUser: vi.fn(async () => []),
    getFeedbackHistory: vi.fn(async () => new Map()),
    dashboardQueries: {
      getTasteProfile: vi.fn(async () => ({ genres: [] })),
      getLatestGenreCoverage: vi.fn(async () => null),
      getRecentActivity: vi.fn(async () => []),
    },
    jobRecorder: {} as AppDependencies['jobRecorder'],
    jobQueries: {} as AppDependencies['jobQueries'],
    ...overrides,
  }
}

function createTestApp(deps: AppDependencies, userId = USER_ID) {
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('userId' as never, userId as never)
    await next()
  })
  app.route('/', listeningRoutes(deps))
  return app
}

describe('GET /api/v1/listening/top-artists', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('uses Plex native lifetime ranking for all_time', async () => {
    mockGetUserConnections.mockResolvedValue({
      ...emptyConnections(),
      plexUrl: 'https://plex.example.com',
      plexToken: 'plex-token',
    })
    const getTopArtists = vi.fn(async () => [
      { name: 'Boards of Canada', viewCount: 88, ratingKey: '1', genres: [] },
      { name: 'Autechre', viewCount: 40, ratingKey: '2', genres: [] },
    ])
    mockCreatePlexClient.mockReturnValue({
      getTopArtists,
    } as unknown as ReturnType<typeof createPlexClient>)

    const app = createTestApp(makeDeps())
    const res = await app.request('/api/v1/listening/top-artists?range=all_time&limit=5&offset=0')

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.source).toBe('plex')
    expect(body.tracks).toEqual([
      { artist: 'Boards of Canada', track: '88 plays all time', source: 'plex' },
      { artist: 'Autechre', track: '40 plays all time', source: 'plex' },
    ])
  })

  it('aggregates Plex recent plays within the range cutoff for this_week', async () => {
    mockGetUserConnections.mockResolvedValue({
      ...emptyConnections(),
      plexUrl: 'https://plex.example.com',
      plexToken: 'plex-token',
    })
    const now = Date.now()
    const getRecentlyPlayedSince = vi.fn(async () => [
      { artistName: 'Recent Artist', trackName: 'A', viewedAt: now - 1 * 60 * 60 * 1000 },
      { artistName: 'Recent Artist', trackName: 'B', viewedAt: now - 2 * 60 * 60 * 1000 },
    ])
    mockCreatePlexClient.mockReturnValue({
      getRecentlyPlayedSince,
    } as unknown as ReturnType<typeof createPlexClient>)

    const app = createTestApp(makeDeps())
    const res = await app.request('/api/v1/listening/top-artists?range=this_week&limit=5')

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.source).toBe('plex')
    expect(body.tracks).toEqual([
      { artist: 'Recent Artist', track: '2 plays this week', source: 'plex' },
    ])
    expect(body.total).toBe(1)
  })

  it('maps back-compat range "month" to "this_month"', async () => {
    mockGetUserConnections.mockResolvedValue({
      ...emptyConnections(),
      plexUrl: 'https://plex.example.com',
      plexToken: 'plex-token',
    })
    const getRecentlyPlayedSince = vi.fn(async () => [])
    mockCreatePlexClient.mockReturnValue({
      getRecentlyPlayedSince,
    } as unknown as ReturnType<typeof createPlexClient>)

    const app = createTestApp(makeDeps())
    const res = await app.request('/api/v1/listening/top-artists?range=month')

    expect(res.status).toBe(200)
    expect(getRecentlyPlayedSince).toHaveBeenCalled()
  })

  it('returns empty tracks with null source when no connections are configured', async () => {
    mockGetUserConnections.mockResolvedValue(emptyConnections())

    const app = createTestApp(makeDeps())
    const res = await app.request('/api/v1/listening/top-artists')

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      tracks: [],
      total: 0,
      offset: 0,
      limit: 5,
      hasSource: false,
      source: null,
    })
  })
})

describe('GET /api/v1/listening/recent-tracks', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns hasSource=false when no scrobble source is connected', async () => {
    mockGetUserConnections.mockResolvedValue(emptyConnections())

    const app = createTestApp(makeDeps())
    const res = await app.request('/api/v1/listening/recent-tracks')

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      tracks: [],
      total: 0,
      offset: 0,
      limit: 5,
      hasSource: false,
      source: null,
    })
  })

  it('uses Plex when connected', async () => {
    mockGetUserConnections.mockResolvedValue({
      ...emptyConnections(),
      plexUrl: 'https://plex.example.com',
      plexToken: 'plex-token',
    })
    const viewedAt = 1700000000000
    const getRecentlyPlayed = vi.fn(async () => ({
      tracks: [{ artistName: 'Boards of Canada', trackName: 'Roygbiv', viewedAt }],
      total: 1,
    }))
    mockCreatePlexClient.mockReturnValue({
      getRecentlyPlayed,
    } as unknown as ReturnType<typeof createPlexClient>)

    const app = createTestApp(makeDeps())
    const res = await app.request('/api/v1/listening/recent-tracks?range=all_time&limit=1')

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.source).toBe('plex')
    expect(body.hasSource).toBe(true)
    expect(body.tracks).toEqual([
      {
        artist: 'Boards of Canada',
        track: 'Roygbiv',
        source: 'plex',
        playedAt: new Date(viewedAt).toISOString(),
      },
    ])
  })
})
