// @vitest-environment node

import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HonoEnv } from '@/server/types'

vi.mock('@/core/clients/musicbrainz', () => ({
  createMusicBrainzClient: vi.fn(),
}))

vi.mock('@/db/queries/requests', () => ({
  createRequest: vi.fn(),
  getRequestById: vi.fn(),
  listFailedOpenRequests: vi.fn(),
  listPendingRequests: vi.fn(),
  listRequestsForUser: vi.fn(),
  resolvePendingRequest: vi.fn(),
  resolveRequest: vi.fn(),
}))

vi.mock('@/server/routes/recommendations', () => ({
  approveAlbumToTargets: vi.fn(),
  approveToTargets: vi.fn(),
  buildAddOptions: vi.fn(),
}))

const { createMusicBrainzClient } = await import('@/core/clients/musicbrainz')
const { getRequestById, listFailedOpenRequests, resolvePendingRequest, resolveRequest } =
  await import('@/db/queries/requests')
const { approveAlbumToTargets, approveToTargets, buildAddOptions } = await import(
  '@/server/routes/recommendations'
)
const { requestRoutes } = await import('@/server/routes/requests')

const ARTIST_MBID = 'a74b1b7f-71a5-4011-9441-d0b5e4122711'

function requestRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    requestedByUserId: 2,
    kind: 'artist' as const,
    artistMbid: ARTIST_MBID,
    artistName: 'Radiohead',
    releaseGroupMbid: null,
    albumTitle: null,
    coverUrl: null,
    status: 'pending' as const,
    targetActions: null,
    rejectionReason: null,
    decidedByUserId: null,
    createdAt: new Date(),
    decidedAt: null,
    ...overrides,
  }
}

function makeDeps() {
  return {
    getSettings: vi.fn().mockResolvedValue({}),
    getEnabledTargetsForUser: vi.fn().mockResolvedValue([]),
    getUserById: vi.fn().mockResolvedValue({ id: 1, isAdmin: true, isOwner: false }),
    db: {} as never,
    jobRecorder: {} as never,
  }
}

function makeApp(deps: ReturnType<typeof makeDeps>) {
  const app = new Hono<HonoEnv>()
  app.use('*', async (c, next) => {
    c.set('userId', 1)
    return next()
  })
  app.route('/', requestRoutes(deps as never))
  return app
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(buildAddOptions).mockResolvedValue({})
  vi.mocked(approveToTargets).mockResolvedValue({ targetActions: {} } as never)
  vi.mocked(approveAlbumToTargets).mockResolvedValue({ targetActions: {} } as never)
})

describe('POST /api/v1/requests/:id/approve - whole-discography album-type restriction', () => {
  it('resolves release groups via MusicBrainz and dispatches only Album/EP as selectedAlbumIds', async () => {
    const getReleaseGroups = vi.fn().mockResolvedValue([
      { id: 'album-mbid-1', title: 'OK Computer', type: 'Album' },
      { id: 'ep-mbid-1', title: 'Airbag / How Am I Driving?', type: 'EP' },
    ])
    vi.mocked(createMusicBrainzClient).mockReturnValue({ getReleaseGroups } as never)
    vi.mocked(getRequestById).mockResolvedValue(requestRow({ kind: 'artist' }) as never)
    vi.mocked(resolvePendingRequest).mockResolvedValue(
      requestRow({ status: 'dispatched' }) as never,
    )

    const deps = makeDeps()
    const app = makeApp(deps)

    const res = await app.request('/api/v1/requests/1/approve', { method: 'POST' })

    expect(res.status).toBe(200)
    expect(getReleaseGroups).toHaveBeenCalledWith(ARTIST_MBID)
    expect(buildAddOptions).toHaveBeenCalledWith(
      deps,
      2,
      { mbid: ARTIST_MBID, name: 'Radiohead' },
      {
        monitorOption: 'selected',
        selectedAlbumIds: ['album-mbid-1', 'ep-mbid-1'],
      },
    )
  })

  it('does not set a monitorOption or selectedAlbumIds for album-kind requests', async () => {
    const getReleaseGroups = vi.fn()
    vi.mocked(createMusicBrainzClient).mockReturnValue({ getReleaseGroups } as never)
    vi.mocked(getRequestById).mockResolvedValue(
      requestRow({ kind: 'album', releaseGroupMbid: 'rg-mbid' }) as never,
    )
    vi.mocked(resolvePendingRequest).mockResolvedValue(
      requestRow({ status: 'dispatched' }) as never,
    )

    const deps = makeDeps()
    const app = makeApp(deps)

    const res = await app.request('/api/v1/requests/1/approve', { method: 'POST' })

    expect(res.status).toBe(200)
    expect(getReleaseGroups).not.toHaveBeenCalled()
    expect(buildAddOptions).toHaveBeenCalledWith(
      deps,
      2,
      { mbid: ARTIST_MBID, name: 'Radiohead' },
      { monitorOption: undefined, selectedAlbumIds: undefined },
    )
  })

  it('falls back to an empty selection when MusicBrainz lookup fails, without throwing', async () => {
    const getReleaseGroups = vi.fn().mockRejectedValue(new Error('musicbrainz unreachable'))
    vi.mocked(createMusicBrainzClient).mockReturnValue({ getReleaseGroups } as never)
    vi.mocked(getRequestById).mockResolvedValue(requestRow({ kind: 'artist' }) as never)
    vi.mocked(resolvePendingRequest).mockResolvedValue(
      requestRow({ status: 'dispatched' }) as never,
    )

    const deps = makeDeps()
    const app = makeApp(deps)

    const res = await app.request('/api/v1/requests/1/approve', { method: 'POST' })

    expect(res.status).toBe(200)
    expect(buildAddOptions).toHaveBeenCalledWith(
      deps,
      2,
      { mbid: ARTIST_MBID, name: 'Radiohead' },
      { monitorOption: 'selected', selectedAlbumIds: [] },
    )
  })
})

describe('POST /api/v1/requests/retry-failed', () => {
  it('returns 202 immediately and re-dispatches every failed request in the background', async () => {
    vi.mocked(listFailedOpenRequests).mockResolvedValue([
      requestRow({ id: 10, kind: 'album', releaseGroupMbid: 'rg-1', status: 'failed' }),
      requestRow({ id: 11, kind: 'album', releaseGroupMbid: 'rg-2', status: 'failed' }),
    ] as never)
    vi.mocked(approveAlbumToTargets)
      .mockResolvedValueOnce({ targetActions: { lidarr: { status: 'added' } } } as never)
      .mockResolvedValueOnce({ targetActions: { lidarr: { status: 'failed' } } } as never)

    const res = await makeApp(makeDeps()).request('/api/v1/requests/retry-failed', {
      method: 'POST',
    })

    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ retrying: 2 })
    expect(listFailedOpenRequests).toHaveBeenCalledWith(expect.anything(), 1)
    await vi.waitFor(() => expect(resolveRequest).toHaveBeenCalledTimes(2))
    expect(resolveRequest).toHaveBeenCalledWith(
      expect.anything(),
      10,
      expect.objectContaining({ status: 'dispatched' }),
    )
    expect(resolveRequest).toHaveBeenCalledWith(
      expect.anything(),
      11,
      expect.objectContaining({ status: 'failed' }),
    )
  })

  it('is a no-op when there is nothing failed', async () => {
    vi.mocked(listFailedOpenRequests).mockResolvedValue([])

    const res = await makeApp(makeDeps()).request('/api/v1/requests/retry-failed', {
      method: 'POST',
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ retrying: 0 })
    expect(resolveRequest).not.toHaveBeenCalled()
  })
})
