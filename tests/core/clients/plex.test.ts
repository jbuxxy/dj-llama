// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHttpClient } from '@/core/clients/http'
import { createPlexClient } from '@/core/clients/plex'

const mockGet = vi.fn()

vi.mock('@/core/clients/http', () => ({
  createHttpClient: vi.fn(() => ({
    get: mockGet,
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  })),
}))

beforeEach(() => {
  mockGet.mockReset()
  vi.mocked(createHttpClient).mockClear()
})

const TEST_URL = 'http://plex.local:32400'
const TEST_TOKEN = 'test-plex-token'

describe('plex client.getTopArtists()', () => {
  it('maps genres already present in the top-artist response', async () => {
    mockGet.mockResolvedValueOnce({
      MediaContainer: {
        Metadata: [
          {
            ratingKey: '101',
            title: 'Portishead',
            viewCount: 12,
            Genre: [{ tag: 'trip hop' }, { tag: 'electronic' }],
          },
        ],
      },
    })

    const client = createPlexClient(TEST_URL, TEST_TOKEN, { sectionId: '1' })
    await expect(client.getTopArtists(10)).resolves.toEqual([
      {
        ratingKey: '101',
        name: 'Portishead',
        viewCount: 12,
        genres: ['trip hop', 'electronic'],
      },
    ])
  })
})

describe('plex client.getRecentlyPlayed()', () => {
  it('does not filter by accountID when no username is configured', async () => {
    mockGet.mockResolvedValueOnce({ MediaContainer: { Metadata: [] } })
    const client = createPlexClient(TEST_URL, TEST_TOKEN)
    await client.getRecentlyPlayed()
    expect(mockGet).toHaveBeenCalledTimes(1)
    expect(mockGet.mock.calls[0]?.[0]).not.toContain('accountID')
  })

  it('filters history by the local account id resolved from the username via /accounts', async () => {
    // Plex's global (plex.tv) account id and the local per-server account id
    // are different id spaces -- the history endpoint's accountID filter only
    // understands the local one, resolved here by matching username against
    // the server's own /accounts list.
    mockGet
      .mockResolvedValueOnce({ MediaContainer: { Account: [{ id: 42, name: 'jordan' }] } })
      .mockResolvedValueOnce({
        MediaContainer: {
          Metadata: [
            { type: 'track', grandparentTitle: 'Radiohead', title: 'Idioteque', viewedAt: 1000 },
            { type: 'album', grandparentTitle: 'ignored', title: 'ignored', viewedAt: 999 },
          ],
        },
      })
    const client = createPlexClient(TEST_URL, TEST_TOKEN, { username: 'jordan' })
    const { tracks } = await client.getRecentlyPlayed()
    expect(mockGet.mock.calls[0]?.[0]).toBe('/accounts')
    expect(mockGet.mock.calls[1]?.[0]).toContain('accountID=42')
    expect(tracks).toEqual([{ artistName: 'Radiohead', trackName: 'Idioteque', viewedAt: 1000000 }])
  })

  it('does not filter when no /accounts entry matches the username (fails open, not closed)', async () => {
    mockGet
      .mockResolvedValueOnce({ MediaContainer: { Account: [{ id: 1, name: 'someone-else' }] } })
      .mockResolvedValueOnce({ MediaContainer: { Metadata: [] } })
    const client = createPlexClient(TEST_URL, TEST_TOKEN, { username: 'jordan' })
    await client.getRecentlyPlayed()
    expect(mockGet.mock.calls[1]?.[0]).not.toContain('accountID')
  })

  it('resolves the local account id only once across repeated calls', async () => {
    mockGet.mockResolvedValue({ MediaContainer: { Account: [{ id: 42, name: 'jordan' }] } })
    const client = createPlexClient(TEST_URL, TEST_TOKEN, { username: 'jordan' })
    await client.getRecentlyPlayed()
    await client.getRecentlyPlayed()
    const accountsCalls = mockGet.mock.calls.filter((c) => c[0] === '/accounts')
    expect(accountsCalls).toHaveLength(1)
  })

  it('uses a separate token for the history request when historyToken differs', async () => {
    createPlexClient(TEST_URL, TEST_TOKEN, { historyToken: 'admin-token', username: 'jordan' })
    // Once for the main client, once for the history-specific client with the admin token.
    expect(vi.mocked(createHttpClient)).toHaveBeenCalledTimes(2)
    expect(vi.mocked(createHttpClient).mock.calls[1]?.[0]).toMatchObject({
      headers: expect.objectContaining({ 'X-Plex-Token': 'admin-token' }),
    })
  })

  it('reuses the same client when no separate historyToken is given', async () => {
    createPlexClient(TEST_URL, TEST_TOKEN, { username: 'jordan' })
    expect(vi.mocked(createHttpClient)).toHaveBeenCalledTimes(1)
  })
})

describe('plex client.getRecentlyPlayedSince()', () => {
  function trackAt(viewedAtMs: number, name = 'Artist') {
    return {
      type: 'track',
      grandparentTitle: name,
      title: 'Track',
      viewedAt: Math.floor(viewedAtMs / 1000),
    }
  }

  it('stops paging once an entry older than the cutoff appears in a page', async () => {
    const now = Date.now()
    const cutoff = now - 7 * 24 * 60 * 60 * 1000 // one week
    mockGet.mockResolvedValueOnce({
      MediaContainer: {
        Metadata: [
          trackAt(now - 1000, 'Recent'),
          trackAt(now - 2000, 'Recent'),
          trackAt(cutoff - 1000, 'TooOld'), // crosses the cutoff mid-page
        ],
      },
    })

    const client = createPlexClient(TEST_URL, TEST_TOKEN)
    const tracks = await client.getRecentlyPlayedSince(cutoff)

    expect(tracks.map((t) => t.artistName)).toEqual(['Recent', 'Recent'])
    expect(mockGet).toHaveBeenCalledTimes(1)
  })

  it('fetches a second page when the first page is entirely within the cutoff and full', async () => {
    const now = Date.now()
    const cutoff = now - 365 * 24 * 60 * 60 * 1000 // a year -- deliberately wide
    const fullPage = Array.from({ length: 200 }, (_, i) => trackAt(now - i * 1000, `Artist${i}`))
    mockGet
      .mockResolvedValueOnce({ MediaContainer: { Metadata: fullPage } })
      .mockResolvedValueOnce({ MediaContainer: { Metadata: [trackAt(now - 300_000, 'Second')] } })

    const client = createPlexClient(TEST_URL, TEST_TOKEN)
    const tracks = await client.getRecentlyPlayedSince(cutoff)

    expect(mockGet).toHaveBeenCalledTimes(2)
    expect(mockGet.mock.calls[1]?.[0]).toContain('X-Plex-Container-Start=200')
    expect(tracks).toHaveLength(201)
  })

  it('stops once a short (non-full) page signals history is exhausted', async () => {
    const now = Date.now()
    const cutoff = now - 365 * 24 * 60 * 60 * 1000
    mockGet.mockResolvedValueOnce({
      MediaContainer: { Metadata: [trackAt(now - 1000, 'OnlyOne')] },
    })

    const client = createPlexClient(TEST_URL, TEST_TOKEN)
    const tracks = await client.getRecentlyPlayedSince(cutoff)

    expect(mockGet).toHaveBeenCalledTimes(1)
    expect(tracks).toHaveLength(1)
  })
})

describe('plex client.getAllArtists()', () => {
  it('paginates through the music library', async () => {
    // sections lookup
    mockGet.mockResolvedValueOnce({
      MediaContainer: {
        Directory: [{ key: '1', type: 'artist', title: 'Music' }],
      },
    })
    // page 1: 2 of 3 artists
    mockGet.mockResolvedValueOnce({
      MediaContainer: {
        totalSize: 3,
        Metadata: [
          { ratingKey: '101', title: 'Bush', Genre: [{ tag: 'rock' }] },
          { ratingKey: '102', title: 'Portishead', Genre: [{ tag: 'trip hop' }] },
        ],
      },
    })
    // page 2: remaining 1 artist
    mockGet.mockResolvedValueOnce({
      MediaContainer: {
        totalSize: 3,
        Metadata: [{ ratingKey: '103', title: 'Radiohead', Genre: [{ tag: 'art rock' }] }],
      },
    })

    const client = createPlexClient(TEST_URL, TEST_TOKEN)
    const artists = await client.getAllArtists({ pageSize: 2 })

    expect(artists).toEqual([
      { ratingKey: '101', name: 'Bush', genres: ['rock'] },
      { ratingKey: '102', name: 'Portishead', genres: ['trip hop'] },
      { ratingKey: '103', name: 'Radiohead', genres: ['art rock'] },
    ])
  })

  it('returns empty array when library is empty', async () => {
    // sections lookup
    mockGet.mockResolvedValueOnce({
      MediaContainer: {
        Directory: [{ key: '1', type: 'artist', title: 'Music' }],
      },
    })
    // empty page
    mockGet.mockResolvedValueOnce({
      MediaContainer: {
        totalSize: 0,
        Metadata: [],
      },
    })

    const client = createPlexClient(TEST_URL, TEST_TOKEN)
    const artists = await client.getAllArtists({ pageSize: 100 })

    expect(artists).toEqual([])
  })
})

describe('plex library section selection', () => {
  const TWO_SECTIONS = {
    MediaContainer: {
      Directory: [
        { key: '3', type: 'artist', title: 'Audiobooks' },
        { key: '5', type: 'artist', title: 'Music' },
        { key: '7', type: 'movie', title: 'Movies' },
      ],
    },
  }

  it('getMusicSections returns only artist-type sections', async () => {
    mockGet.mockResolvedValueOnce(TWO_SECTIONS)
    const client = createPlexClient(TEST_URL, TEST_TOKEN)
    const sections = await client.getMusicSections()
    expect(sections).toEqual([
      { key: '3', title: 'Audiobooks' },
      { key: '5', title: 'Music' },
    ])
  })

  it('uses the configured section without hitting /library/sections', async () => {
    mockGet.mockResolvedValueOnce({
      MediaContainer: {
        totalSize: 1,
        Metadata: [{ ratingKey: '201', title: 'Radiohead', Genre: [] }],
      },
    })
    const client = createPlexClient(TEST_URL, TEST_TOKEN, { sectionId: '5' })
    const artists = await client.getAllArtists()
    expect(artists).toHaveLength(1)
    expect(mockGet).toHaveBeenCalledTimes(1)
    expect(mockGet.mock.calls[0]?.[0]).toContain('/library/sections/5/all')
  })

  it('auto-picks the first artist section when none is configured', async () => {
    mockGet.mockResolvedValueOnce(TWO_SECTIONS)
    const client = createPlexClient(TEST_URL, TEST_TOKEN)
    await expect(client.getMusicSectionId()).resolves.toBe('3')
  })

  it('testConnection reports the selected library and all music sections', async () => {
    mockGet.mockResolvedValueOnce(TWO_SECTIONS)
    const client = createPlexClient(TEST_URL, TEST_TOKEN, { sectionId: '5' })
    const result = await client.testConnection()
    expect(result.success).toBe(true)
    expect(result.message).toContain('"Music"')
    expect(result.details).toEqual({
      sectionId: '5',
      sections: [
        { key: '3', title: 'Audiobooks' },
        { key: '5', title: 'Music' },
      ],
    })
  })

  it('testConnection fails when the configured section no longer exists', async () => {
    mockGet.mockResolvedValueOnce(TWO_SECTIONS)
    const client = createPlexClient(TEST_URL, TEST_TOKEN, { sectionId: '99' })
    const result = await client.testConnection()
    expect(result.success).toBe(false)
    expect(result.message).toContain('99')
    expect(result.message).toContain('Music (5)')
  })

  it('testConnection fails when no music sections exist', async () => {
    mockGet.mockResolvedValueOnce({
      MediaContainer: { Directory: [{ key: '7', type: 'movie', title: 'Movies' }] },
    })
    const client = createPlexClient(TEST_URL, TEST_TOKEN)
    const result = await client.testConnection()
    expect(result.success).toBe(false)
    expect(result.message).toContain('No music library section')
  })
})

describe('plex client.getAlbumsForArtist()', () => {
  it('includes a final partial page even when totalSize is missing', async () => {
    const client = createPlexClient(TEST_URL, TEST_TOKEN)

    mockGet.mockResolvedValueOnce({
      MediaContainer: {
        Metadata: [
          {
            ratingKey: 'alb-final',
            parentRatingKey: 'artist-1',
            title: 'A Moon Shaped Pool',
            year: 2016,
          },
        ],
      },
    })

    const albums = await client.getAlbumsForArtist('artist-1')

    expect(albums).toEqual([
      {
        ratingKey: 'alb-final',
        artistRatingKey: 'artist-1',
        title: 'A Moon Shaped Pool',
        releaseYear: 2016,
        primaryType: 'Album',
      },
    ])
  })

  it('paginates through the album library', async () => {
    const client = createPlexClient(TEST_URL, TEST_TOKEN)

    // first page of 5 albums
    mockGet.mockResolvedValueOnce({
      MediaContainer: {
        totalSize: 5,
        Metadata: [
          { ratingKey: 'alb-1', parentRatingKey: 'artist-1', title: 'Kid A', year: 2000 },
          { ratingKey: 'alb-2', parentRatingKey: 'artist-1', title: 'Amnesiac', year: 2001 },
        ],
      },
    })
    // second page omits totalSize, but more albums remain
    mockGet.mockResolvedValueOnce({
      MediaContainer: {
        Metadata: [
          {
            ratingKey: 'alb-3',
            parentRatingKey: 'artist-1',
            title: 'Hail to the Thief',
            year: 2003,
          },
          { ratingKey: 'alb-4', parentRatingKey: 'artist-1', title: 'In Rainbows', year: 2007 },
        ],
      },
    })
    // third page: final album
    mockGet.mockResolvedValueOnce({
      MediaContainer: {
        Metadata: [
          {
            ratingKey: 'alb-5',
            parentRatingKey: 'artist-1',
            title: 'The King of Limbs',
            year: 2011,
          },
        ],
      },
    })

    const albums = await client.getAlbumsForArtist('artist-1')

    expect(albums).toEqual([
      {
        ratingKey: 'alb-1',
        artistRatingKey: 'artist-1',
        title: 'Kid A',
        releaseYear: 2000,
        primaryType: 'Album',
      },
      {
        ratingKey: 'alb-2',
        artistRatingKey: 'artist-1',
        title: 'Amnesiac',
        releaseYear: 2001,
        primaryType: 'Album',
      },
      {
        ratingKey: 'alb-3',
        artistRatingKey: 'artist-1',
        title: 'Hail to the Thief',
        releaseYear: 2003,
        primaryType: 'Album',
      },
      {
        ratingKey: 'alb-4',
        artistRatingKey: 'artist-1',
        title: 'In Rainbows',
        releaseYear: 2007,
        primaryType: 'Album',
      },
      {
        ratingKey: 'alb-5',
        artistRatingKey: 'artist-1',
        title: 'The King of Limbs',
        releaseYear: 2011,
        primaryType: 'Album',
      },
    ])
  })
})
