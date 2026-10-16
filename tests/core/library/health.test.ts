// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LidarrAlbum, LidarrArtist } from '@/core/clients/lidarr'
import { LibraryHealthService } from '@/core/library/health'
import type { LibraryHealthState } from '@/core/library/types'

// ---------------------------------------------------------------------------
// Mock p-queue: runs tasks immediately, no rate-limiting in tests
// ---------------------------------------------------------------------------
vi.mock('p-queue', () => {
  const mockAdd = vi.fn((fn: () => unknown) => Promise.resolve(fn()))
  const mockOnIdle = vi.fn(() => Promise.resolve())
  // Must use a real class (not arrow fn) so `new PQueue()` works as a constructor
  class MockPQueue {
    add = mockAdd
    onIdle = mockOnIdle
  }
  return { default: MockPQueue }
})

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ARTIST_RADIOHEAD: LidarrArtist = {
  id: 1,
  artistName: 'Radiohead',
  foreignArtistId: 'a74b1b7f-71a5-4011-9441-d0b5e4122711',
  qualityProfileId: 1,
  rootFolderPath: '/music',
  monitored: true,
  status: 'ended',
  genres: ['alternative rock', 'art rock'],
}

const ARTIST_PORTISHEAD: LidarrArtist = {
  id: 2,
  artistName: 'Portishead',
  foreignArtistId: '8f6bd1e4-fbe1-4f50-aa9b-94c450ec0a11',
  qualityProfileId: 1,
  rootFolderPath: '/music',
  monitored: true,
  status: 'continuing',
  genres: ['trip hop'],
}

const ARTIST_BJORK: LidarrArtist = {
  id: 3,
  artistName: 'Bjork',
  foreignArtistId: '87c7bda4-9a31-4e8c-a09c-7a595dc55c40',
  qualityProfileId: 1,
  rootFolderPath: '/music',
  monitored: false,
  status: 'continuing',
  genres: [],
}

const ALBUM_WITH_FILES: LidarrAlbum = {
  id: 10,
  title: 'OK Computer',
  artistId: 1,
  foreignAlbumId: 'abcdef-01',
  monitored: true,
  albumType: 'Album',
  statistics: { trackCount: 12, trackFileCount: 12, percentOfTracks: 100 },
}

const ALBUM_NO_FILES: LidarrAlbum = {
  id: 11,
  title: 'Portishead',
  artistId: 2,
  foreignAlbumId: 'abcdef-02',
  monitored: true,
  albumType: 'Album',
  statistics: { trackCount: 11, trackFileCount: 0, percentOfTracks: 0 },
}

// ---------------------------------------------------------------------------
// Mock factory helpers
// ---------------------------------------------------------------------------

type MockDeps = {
  getArtists: ReturnType<typeof vi.fn>
  getAlbums: ReturnType<typeof vi.fn>
  triggerCommand: ReturnType<typeof vi.fn>
  getRootFolders: ReturnType<typeof vi.fn>
  cacheGetAll: ReturnType<typeof vi.fn>
  healthStateGet: ReturnType<typeof vi.fn>
  healthStateStart: ReturnType<typeof vi.fn>
  healthStateSave: ReturnType<typeof vi.fn>
}

function makeMocks(): MockDeps {
  return {
    getArtists: vi.fn().mockResolvedValue([]),
    getAlbums: vi.fn().mockResolvedValue([]),
    triggerCommand: vi.fn().mockResolvedValue({}),
    getRootFolders: vi
      .fn()
      .mockResolvedValue([{ id: 1, path: '/music', freeSpace: 5_000_000_000 }]),
    cacheGetAll: vi.fn().mockResolvedValue([]),
    healthStateGet: vi.fn(async (): Promise<LibraryHealthState | null> => null),
    healthStateStart: vi.fn(async () => {}),
    healthStateSave: vi.fn(async () => {}),
  }
}

function makeService(mocks: MockDeps): LibraryHealthService {
  return new LibraryHealthService({
    lidarrClient: {
      getArtists: mocks.getArtists as unknown as () => Promise<LidarrArtist[]>,
      getAlbums: mocks.getAlbums as unknown as (artistId: number) => Promise<LidarrAlbum[]>,
      triggerCommand: mocks.triggerCommand as unknown as (
        name: string,
        body?: Record<string, unknown>,
      ) => Promise<unknown>,
      getRootFolders: mocks.getRootFolders as unknown as () => Promise<
        Array<{ id: number; path: string; freeSpace: number }>
      >,
    },
    artistCache: {
      getAll: mocks.cacheGetAll as unknown as () => Promise<
        Array<{
          id: number
          mbid: string
          name: string
          genres: string[] | null
          tags: string[] | null
          imageUrl: string | null
          streamingUrls: Record<string, string> | null
        }>
      >,
    },
    stateStore: {
      get: mocks.healthStateGet as unknown as () => Promise<LibraryHealthState | null>,
      markScanStarted: mocks.healthStateStart as unknown as () => Promise<void>,
      save: mocks.healthStateSave as unknown as (input: {
        checks: LibraryHealthState['checks']
        lastCompletedAt: Date
        lastError: string | null
      }) => Promise<void>,
    },
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LibraryHealthService', () => {
  let mocks: MockDeps
  let service: LibraryHealthService

  beforeEach(() => {
    mocks = makeMocks()
    service = makeService(mocks)
    vi.clearAllMocks()
  })

  describe('state persistence', () => {
    it('persists the computed snapshot and exposes it via getState', async () => {
      mocks.getArtists.mockResolvedValue([ARTIST_RADIOHEAD, ARTIST_BJORK])
      mocks.cacheGetAll.mockResolvedValue([
        {
          id: 1,
          mbid: ARTIST_RADIOHEAD.foreignArtistId,
          name: 'Radiohead',
          genres: ['rock'],
          tags: null,
          imageUrl: 'http://img',
          streamingUrls: null,
        },
      ])

      const savedStates: LibraryHealthState[] = []
      mocks.healthStateSave.mockImplementation(
        async ({
          checks,
          lastCompletedAt,
          lastError,
        }: {
          checks: LibraryHealthState['checks']
          lastCompletedAt: Date
          lastError: string | null
        }) => {
          savedStates.push({
            checks,
            lastStartedAt: new Date('2026-04-13T10:00:00.000Z'),
            lastCompletedAt,
            lastError,
          })
        },
      )
      mocks.healthStateGet.mockImplementation(async () => savedStates.at(-1) ?? null)

      await service.runChecks()
      const state = await service.getState()

      expect(mocks.healthStateSave).toHaveBeenCalledTimes(1)
      expect(state).not.toBeNull()
      expect(state?.lastStartedAt?.toISOString()).toBe('2026-04-13T10:00:00.000Z')
      expect(state?.lastCompletedAt).toBeInstanceOf(Date)
      expect(state?.lastError).toBeNull()
      expect(state?.checks.map((check) => check.id)).toEqual(['missing-albums', 'genre-gaps'])
    })
  })

  // -------------------------------------------------------------------------
  // unmonitored check
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // genre-gaps check
  // -------------------------------------------------------------------------

  describe('genre-gaps check', () => {
    it('detects artists with null genres in both sources', async () => {
      const artist = { ...ARTIST_BJORK, genres: undefined }
      mocks.getArtists.mockResolvedValue([artist])
      mocks.cacheGetAll.mockResolvedValue([
        {
          id: 3,
          mbid: ARTIST_BJORK.foreignArtistId,
          name: 'Bjork',
          genres: null,
          tags: null,
          imageUrl: null,
          streamingUrls: null,
        },
      ])

      const results = await service.runChecks()
      const check = results.find((r) => r.id === 'genre-gaps')

      expect(check?.count).toBe(1)
      expect(check?.items[0]?.detail).toBe('No genre tags')
    })

    it('detects artists with empty array genres in both sources', async () => {
      mocks.getArtists.mockResolvedValue([ARTIST_BJORK]) // genres: []
      mocks.cacheGetAll.mockResolvedValue([
        {
          id: 3,
          mbid: ARTIST_BJORK.foreignArtistId,
          name: 'Bjork',
          genres: [],
          tags: null,
          imageUrl: null,
          streamingUrls: null,
        },
      ])

      const results = await service.runChecks()
      const check = results.find((r) => r.id === 'genre-gaps')

      expect(check?.count).toBe(1)
    })

    it('skips artist if Lidarr has genres', async () => {
      mocks.getArtists.mockResolvedValue([ARTIST_RADIOHEAD]) // has genres
      mocks.cacheGetAll.mockResolvedValue([
        {
          id: 1,
          mbid: ARTIST_RADIOHEAD.foreignArtistId,
          name: 'Radiohead',
          genres: null,
          tags: null,
          imageUrl: null,
          streamingUrls: null,
        },
      ])

      const results = await service.runChecks()
      const check = results.find((r) => r.id === 'genre-gaps')

      expect(check?.count).toBe(0)
    })

    it('skips artist if cache has genres', async () => {
      mocks.getArtists.mockResolvedValue([ARTIST_BJORK]) // no genres in Lidarr
      mocks.cacheGetAll.mockResolvedValue([
        {
          id: 3,
          mbid: ARTIST_BJORK.foreignArtistId,
          name: 'Bjork',
          genres: ['electronic'],
          tags: null,
          imageUrl: null,
          streamingUrls: null,
        },
      ])

      const results = await service.runChecks()
      const check = results.find((r) => r.id === 'genre-gaps')

      expect(check?.count).toBe(0)
    })
  })

  // -------------------------------------------------------------------------
  // image-gaps check
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // duplicate-artists check
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Caching behavior
  // -------------------------------------------------------------------------

  describe('caching', () => {
    it('getLastResults returns null before first runChecks', () => {
      expect(service.getLastResults()).toBeNull()
    })

    it('getLastResults returns results after runChecks', async () => {
      mocks.getArtists.mockResolvedValue([ARTIST_RADIOHEAD])
      mocks.cacheGetAll.mockResolvedValue([])

      const results = await service.runChecks()
      expect(service.getLastResults()).toBe(results)
    })

    it('runChecks always fetches fresh data', async () => {
      mocks.getArtists.mockResolvedValue([])
      mocks.cacheGetAll.mockResolvedValue([])

      await service.runChecks()
      await service.runChecks()

      expect(mocks.getArtists).toHaveBeenCalledTimes(2)
      expect(mocks.cacheGetAll).toHaveBeenCalledTimes(2)
    })

    it('getLastResults returns updated results after second runChecks', async () => {
      mocks.getArtists.mockResolvedValueOnce([]).mockResolvedValueOnce([ARTIST_BJORK])
      mocks.cacheGetAll.mockResolvedValue([])

      const first = await service.runChecks()
      const second = await service.runChecks()

      expect(service.getLastResults()).toBe(second)
      expect(service.getLastResults()).not.toBe(first)
    })
  })

  // -------------------------------------------------------------------------
  // Fix actions
  // -------------------------------------------------------------------------

  describe('fixCheck', () => {
    beforeEach(async () => {
      // Pre-populate cache with a mix of issues
      mocks.getArtists.mockResolvedValue([ARTIST_BJORK, ARTIST_PORTISHEAD])
      mocks.getAlbums.mockImplementation((artistId: number) => {
        if (artistId === 2) return Promise.resolve([ALBUM_NO_FILES])
        return Promise.resolve([ALBUM_WITH_FILES])
      })
      mocks.cacheGetAll.mockResolvedValue([
        {
          id: 3,
          mbid: ARTIST_BJORK.foreignArtistId,
          name: 'Bjork',
          genres: null,
          tags: null,
          imageUrl: null,
          streamingUrls: null,
        },
        {
          id: 2,
          mbid: ARTIST_PORTISHEAD.foreignArtistId,
          name: 'Portishead',
          genres: ['trip hop'],
          tags: null,
          imageUrl: null,
          streamingUrls: null,
        },
      ])
      await service.runChecks()
      vi.clearAllMocks()
    })

    it('calls triggerCommand RefreshArtist for genre-gaps', async () => {
      // Rebuild service state with genre-gaps
      mocks.getArtists.mockResolvedValue([ARTIST_BJORK])
      mocks.cacheGetAll.mockResolvedValue([
        {
          id: 3,
          mbid: ARTIST_BJORK.foreignArtistId,
          name: 'Bjork',
          genres: [],
          tags: null,
          imageUrl: null,
          streamingUrls: null,
        },
      ])
      await service.runChecks()
      mocks.triggerCommand.mockResolvedValue({})

      const progress = await service.fixCheck('genre-gaps')

      expect(mocks.triggerCommand).toHaveBeenCalledWith('RefreshArtist', {
        artistId: ARTIST_BJORK.id,
      })
      expect(progress.completed).toBe(1)
      expect(progress.failed).toBe(0)
      expect(progress.status).toBe('completed')
    })

    it('calls triggerCommand ArtistSearch for missing-albums', async () => {
      mocks.getArtists.mockResolvedValue([ARTIST_PORTISHEAD])
      mocks.getAlbums.mockResolvedValue([ALBUM_NO_FILES])
      mocks.cacheGetAll.mockResolvedValue([
        {
          id: 2,
          mbid: ARTIST_PORTISHEAD.foreignArtistId,
          name: 'Portishead',
          genres: ['trip hop'],
          tags: null,
          imageUrl: 'http://img',
          streamingUrls: null,
        },
      ])
      await service.runChecks()
      mocks.triggerCommand.mockResolvedValue({})

      const progress = await service.fixCheck('missing-albums')

      expect(mocks.triggerCommand).toHaveBeenCalledWith('ArtistSearch', {
        artistId: ARTIST_PORTISHEAD.id,
      })
      expect(progress.completed).toBe(1)
    })

    it('counts failures when fix throws', async () => {
      mocks.getArtists.mockResolvedValue([ARTIST_BJORK])
      mocks.cacheGetAll.mockResolvedValue([])
      await service.runChecks()
      mocks.triggerCommand.mockRejectedValue(new Error('Lidarr down'))

      const progress = await service.fixCheck('genre-gaps')

      expect(progress.failed).toBe(1)
      expect(progress.completed).toBe(0)
      expect(progress.status).toBe('failed')
      expect(progress.errors[0]).toContain('Lidarr down')
    })

    it('returns completed status with zero items when no cached results', async () => {
      // Don't run runChecks first - cachedResults is null
      const fresh = makeService(mocks)

      const progress = await fresh.fixCheck('genre-gaps')

      expect(progress.total).toBe(0)
      expect(progress.completed).toBe(0)
      expect(progress.status).toBe('completed')
    })

    it('still queues one triggerCommand call per item for missing-albums (non-bulk path unchanged)', async () => {
      mocks.getArtists.mockResolvedValue([ARTIST_PORTISHEAD, ARTIST_RADIOHEAD])
      mocks.getAlbums.mockResolvedValue([ALBUM_NO_FILES])
      mocks.cacheGetAll.mockResolvedValue([])
      await service.runChecks()
      mocks.triggerCommand.mockResolvedValue({})

      const progress = await service.fixCheck('missing-albums')

      expect(mocks.triggerCommand).toHaveBeenCalledTimes(2)
      expect(mocks.triggerCommand).toHaveBeenCalledWith('ArtistSearch', {
        artistId: ARTIST_PORTISHEAD.id,
      })
      expect(mocks.triggerCommand).toHaveBeenCalledWith('ArtistSearch', {
        artistId: ARTIST_RADIOHEAD.id,
      })
      expect(progress.completed).toBe(2)
      expect(progress.status).toBe('completed')
    })
  })

  // -------------------------------------------------------------------------
  // getStats
  // -------------------------------------------------------------------------

  describe('getStats', () => {
    it('returns correct counts and genre distribution', async () => {
      mocks.getArtists.mockResolvedValue([
        ARTIST_RADIOHEAD, // monitored, genres: [alternative rock, art rock]
        ARTIST_PORTISHEAD, // monitored, genres: [trip hop]
        ARTIST_BJORK, // unmonitored, genres: []
      ])
      mocks.getRootFolders.mockResolvedValue([{ id: 1, path: '/music', freeSpace: 10_000_000_000 }])

      const stats = await service.getStats()

      expect(stats.totalArtists).toBe(3)
      expect(stats.monitoredArtists).toBe(2)
      expect(stats.totalAlbums).toBe(0)
      expect(stats.rootFolders).toHaveLength(1)
      expect(stats.rootFolders[0]?.path).toBe('/music')
      expect(stats.genreDistribution.some((g) => g.genre === 'alternative rock')).toBe(true)
    })

    it('limits genre distribution to top 30', async () => {
      const artists: LidarrArtist[] = Array.from({ length: 35 }, (_, i) => ({
        id: i + 1,
        artistName: `Artist ${i}`,
        foreignArtistId: `mbid-${i}`,
        qualityProfileId: 1,
        rootFolderPath: '/music',
        monitored: true,
        status: 'ended',
        genres: [`genre-${i}`],
      }))
      mocks.getArtists.mockResolvedValue(artists)
      mocks.getRootFolders.mockResolvedValue([])

      const stats = await service.getStats()

      expect(stats.genreDistribution).toHaveLength(30)
    })
  })

  // -------------------------------------------------------------------------
  // missing-metadata check
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // missing-albums check
  // -------------------------------------------------------------------------

  describe('missing-albums check', () => {
    it('flags monitored artists with empty monitored albums', async () => {
      mocks.getArtists.mockResolvedValue([ARTIST_PORTISHEAD])
      mocks.getAlbums.mockResolvedValue([ALBUM_NO_FILES])
      mocks.cacheGetAll.mockResolvedValue([])

      const results = await service.runChecks()
      const check = results.find((r) => r.id === 'missing-albums')

      expect(check?.count).toBe(1)
      expect(check?.items[0]?.detail).toBe('1 monitored album with no files')
    })

    it('skips unmonitored artists', async () => {
      mocks.getArtists.mockResolvedValue([ARTIST_BJORK])
      mocks.cacheGetAll.mockResolvedValue([])

      const results = await service.runChecks()
      const check = results.find((r) => r.id === 'missing-albums')

      expect(check?.count).toBe(0)
      // getAlbums should not be called for unmonitored artists
      expect(mocks.getAlbums).not.toHaveBeenCalled()
    })

    it('skips albums with files', async () => {
      mocks.getArtists.mockResolvedValue([ARTIST_RADIOHEAD])
      mocks.getAlbums.mockResolvedValue([ALBUM_WITH_FILES])
      mocks.cacheGetAll.mockResolvedValue([])

      const results = await service.runChecks()
      const check = results.find((r) => r.id === 'missing-albums')

      expect(check?.count).toBe(0)
    })

    it('handles getAlbums errors gracefully', async () => {
      mocks.getArtists.mockResolvedValue([ARTIST_RADIOHEAD])
      mocks.getAlbums.mockRejectedValue(new Error('API timeout'))
      mocks.cacheGetAll.mockResolvedValue([])

      const results = await service.runChecks()
      const check = results.find((r) => r.id === 'missing-albums')

      // Error is swallowed; artist treated as having no problem albums
      expect(check?.count).toBe(0)
    })
  })
})
