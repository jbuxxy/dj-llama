// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSession } from '@/core/sessions'
import type { AppDependencies } from '@/server'
import { createApp } from '@/server'

vi.mock('@/core/clients/shazam', () => ({
  recognizeSong: vi.fn(),
}))

vi.mock('@/core/clients/musicbrainz', () => ({
  createMusicBrainzClient: vi.fn(),
}))

vi.mock('@/server/routes/requests', async () => {
  const actual = await vi.importActual<typeof import('@/server/routes/requests')>(
    '@/server/routes/requests',
  )
  return {
    ...actual,
    findAlreadyOwnedAlbums: vi.fn(async () => new Set<string>()),
    getLidarrClient: vi.fn(async () => null),
  }
})

import { createMusicBrainzClient } from '@/core/clients/musicbrainz'
import { recognizeSong } from '@/core/clients/shazam'
import { findAlreadyOwnedAlbums, getLidarrClient } from '@/server/routes/requests'

const mockRecognizeSong = vi.mocked(recognizeSong)
const mockCreateMusicBrainzClient = vi.mocked(createMusicBrainzClient)
const mockFindAlreadyOwnedAlbums = vi.mocked(findAlreadyOwnedAlbums)
const mockGetLidarrClient = vi.mocked(getLidarrClient)

const TOKEN = 'identify-test-token'

function makeDeps(overrides: Partial<AppDependencies> = {}): AppDependencies {
  return {
    db: {} as never,
    getUserCount: vi.fn(async () => 1),
    isSetupComplete: async () => true,
    getSettings: vi.fn(async () => ({}) as never),
    ...overrides,
  } as unknown as AppDependencies
}

// Shazam's own client needs no API key (see core/clients/shazam.ts) --
// unlike AudD, there is no "not configured" state for the route to gate on.
// The server receives an already-WAV-encoded clip (song-identify-dialog.tsx
// converts client-side before upload); the byte content doesn't matter here
// since recognizeSong is mocked, only the route's own size checks run for
// real.
function audioForm(bytes = 10) {
  const form = new FormData()
  form.set('file', new File([new Uint8Array(bytes)], 'clip.wav', { type: 'audio/wav' }))
  return form
}

async function post(app: ReturnType<typeof createApp>, form: FormData | null, withAuth = true) {
  return app.request('/api/v1/identify', {
    method: 'POST',
    headers: withAuth ? { Authorization: `Bearer ${TOKEN}` } : {},
    body: form ?? undefined,
  })
}

describe('POST /api/v1/identify', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    await createSession(101, TOKEN)
  })

  it('requires authentication', async () => {
    const app = createApp(makeDeps())
    const res = await post(app, audioForm(), false)
    expect(res.status).toBe(401)
    expect(mockRecognizeSong).not.toHaveBeenCalled()
  })

  it('rejects a non-multipart request', async () => {
    const app = createApp(makeDeps())
    const res = await app.request('/api/v1/identify', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(400)
  })

  it('rejects a request with no file field', async () => {
    const app = createApp(makeDeps())
    const res = await post(app, new FormData())
    expect(res.status).toBe(400)
  })

  it('rejects an empty audio file', async () => {
    const app = createApp(makeDeps())
    const res = await post(app, audioForm(0))
    expect(res.status).toBe(400)
  })

  it('rejects an oversized audio file', async () => {
    const app = createApp(makeDeps())
    const res = await post(app, audioForm(15 * 1024 * 1024 + 1))
    expect(res.status).toBe(400)
  })

  it('returns matched:false when Shazam finds no match', async () => {
    mockRecognizeSong.mockResolvedValue(null)
    const app = createApp(makeDeps())

    const res = await post(app, audioForm())

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ matched: false })
  })

  it('returns matched:false when Shazam lookup throws', async () => {
    mockRecognizeSong.mockRejectedValue(new Error('network down'))
    const app = createApp(makeDeps())

    const res = await post(app, audioForm())

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ matched: false })
  })

  it('returns matched:true, resolved:false when MusicBrainz has no matching release group', async () => {
    mockRecognizeSong.mockResolvedValue({ artist: 'Poison', title: 'Fallen Angel' })
    mockCreateMusicBrainzClient.mockReturnValue({
      searchRecordingCandidates: vi.fn(async () => []),
    } as never)
    const app = createApp(makeDeps())

    const res = await post(app, audioForm())

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      matched: true,
      resolved: false,
      artist: 'Poison',
      title: 'Fallen Angel',
    })
  })

  it('prefers the ISRC lookup over title search when Shazam reports one', async () => {
    mockRecognizeSong.mockResolvedValue({
      artist: 'Poison',
      title: 'Fallen Angel',
      isrc: 'USA000000001',
    })
    const searchRecordingCandidates = vi.fn()
    const lookupRecordingsByIsrc = vi.fn(async () => [{ id: 'rec-1', title: 'Fallen Angel' }])
    mockCreateMusicBrainzClient.mockReturnValue({
      lookupRecordingsByIsrc,
      searchRecordingCandidates,
      lookupRecordingWithReleaseGroups: vi.fn(async () => ({
        recordingMbid: 'rec-1',
        artistMbid: 'artist-1',
        artistName: 'Poison',
        releaseGroups: [
          {
            id: 'rg-1',
            title: 'Open Up and Say... Ahh!',
            type: 'Album',
            firstReleaseDate: '1988-05-05',
          },
        ],
      })),
    } as never)
    const app = createApp(makeDeps())

    const res = await post(app, audioForm())

    expect(res.status).toBe(200)
    expect(lookupRecordingsByIsrc).toHaveBeenCalledWith('USA000000001')
    expect(searchRecordingCandidates).not.toHaveBeenCalled()
    const body = await res.json()
    expect(body).toMatchObject({
      matched: true,
      resolved: true,
      releaseGroupMbid: 'rg-1',
      albumTitle: 'Open Up and Say... Ahh!',
    })
  })

  it('falls back to an artist+title search when Shazam has no ISRC', async () => {
    mockRecognizeSong.mockResolvedValue({ artist: 'Poison', title: 'Fallen Angel' })
    mockCreateMusicBrainzClient.mockReturnValue({
      searchRecordingCandidates: vi.fn(async () => [
        { id: 'rec-1', title: 'Fallen Angel', score: 100 },
      ]),
      lookupRecordingWithReleaseGroups: vi.fn(async () => ({
        recordingMbid: 'rec-1',
        artistMbid: 'artist-1',
        artistName: 'Poison',
        releaseGroups: [
          {
            id: 'rg-1',
            title: 'Open Up and Say... Ahh!',
            type: 'Album',
            firstReleaseDate: '1988-05-05',
          },
        ],
      })),
    } as never)
    mockFindAlreadyOwnedAlbums.mockResolvedValue(new Set(['rg-1']))
    const app = createApp(makeDeps())

    const res = await post(app, audioForm())

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({
      matched: true,
      resolved: true,
      artist: 'Poison',
      title: 'Fallen Angel',
      artistMbid: 'artist-1',
      artistName: 'Poison',
      releaseGroupMbid: 'rg-1',
      albumTitle: 'Open Up and Say... Ahh!',
      alreadyOwned: true,
    })
    expect(body.coverUrl).toBeUndefined()
    expect(mockGetLidarrClient).toHaveBeenCalledWith(expect.anything())
  })

  it('resolves cover art from Lidarr when a client is configured', async () => {
    mockRecognizeSong.mockResolvedValue({ artist: 'Poison', title: 'Fallen Angel' })
    mockCreateMusicBrainzClient.mockReturnValue({
      searchRecordingCandidates: vi.fn(async () => [
        { id: 'rec-1', title: 'Fallen Angel', score: 100 },
      ]),
      lookupRecordingWithReleaseGroups: vi.fn(async () => ({
        recordingMbid: 'rec-1',
        artistMbid: 'artist-1',
        artistName: 'Poison',
        releaseGroups: [{ id: 'rg-1', title: 'Open Up and Say... Ahh!', type: 'Album' }],
      })),
    } as never)
    mockGetLidarrClient.mockResolvedValue({
      client: {
        lookupAlbum: vi.fn(async (term: string) => {
          expect(term).toBe('lidarr:rg-1')
          return [{ images: [{ coverType: 'cover', url: '/MediaCover/1/cover.jpg' }] }]
        }),
      } as never,
      imageBaseUrl: 'http://lidarr.local',
    })
    const app = createApp(makeDeps())

    const res = await post(app, audioForm())

    const body = await res.json()
    expect(body.coverUrl).toBe('http://lidarr.local/MediaCover/1/cover.jpg')
  })

  it('falls back to stripping a leading article when the exact title has no hits', async () => {
    mockRecognizeSong.mockResolvedValue({ artist: 'Poison', title: 'A Fallen Angel' })
    const searchRecordingCandidates = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'rec-1', title: 'Fallen Angel', score: 100 }])
    mockCreateMusicBrainzClient.mockReturnValue({
      searchRecordingCandidates,
      lookupRecordingWithReleaseGroups: vi.fn(async () => ({
        recordingMbid: 'rec-1',
        artistMbid: 'artist-1',
        artistName: 'Poison',
        releaseGroups: [{ id: 'rg-1', title: 'Album', type: 'Album' }],
      })),
    } as never)
    const app = createApp(makeDeps())

    const res = await post(app, audioForm())

    expect(res.status).toBe(200)
    expect(searchRecordingCandidates).toHaveBeenCalledTimes(2)
    expect(searchRecordingCandidates).toHaveBeenNthCalledWith(2, 'Poison', 'Fallen Angel', 10)
    const body = await res.json()
    expect(body).toMatchObject({ matched: true, resolved: true })
  })

  it('excludes release groups whose recording artist does not match the identified artist', async () => {
    mockRecognizeSong.mockResolvedValue({ artist: 'Poison', title: 'Fallen Angel' })
    mockCreateMusicBrainzClient.mockReturnValue({
      searchRecordingCandidates: vi.fn(async () => [
        { id: 'rec-1', title: 'Fallen Angel', score: 100 },
      ]),
      lookupRecordingWithReleaseGroups: vi.fn(async () => ({
        recordingMbid: 'rec-1',
        artistMbid: 'other-artist',
        artistName: 'Some Cover Band',
        releaseGroups: [{ id: 'rg-1', title: 'Covers Album', type: 'Album' }],
      })),
    } as never)
    const app = createApp(makeDeps())

    const res = await post(app, audioForm())

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      matched: true,
      resolved: false,
      artist: 'Poison',
      title: 'Fallen Angel',
    })
  })
})
