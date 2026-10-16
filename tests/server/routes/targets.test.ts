// @vitest-environment node

import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HonoEnv } from '@/server/types'

const mockDeps = {
  getEnabledTargetsForUser: vi.fn().mockResolvedValue([]),
}

const { targetRoutes } = await import('@/server/routes/targets')

function createTestApp(userId: number | null = 1) {
  const app = new Hono<HonoEnv>()
  app.use('*', async (c, next) => {
    if (userId !== null) c.set('userId', userId)
    await next()
  })
  app.route('/', targetRoutes(mockDeps as never))
  return app
}

describe('target routes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDeps.getEnabledTargetsForUser.mockResolvedValue([])
  })

  it('GET /api/v1/targets returns 401 when unauthenticated', async () => {
    const app = createTestApp(null)
    const res = await app.request('/api/v1/targets')
    expect(res.status).toBe(401)
  })

  it('GET /api/v1/targets lists the enabled targets for the caller', async () => {
    mockDeps.getEnabledTargetsForUser.mockResolvedValue([
      { id: 'lidarr-1', type: 'lidarr', name: 'My Lidarr', capabilities: ['addArtist'] },
      {
        id: 'plex-playlist-2',
        type: 'plex-playlist',
        name: 'My Plex Playlist',
        capabilities: ['createPlaylist'],
      },
    ])
    const app = createTestApp(1)
    const res = await app.request('/api/v1/targets')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual([
      { id: 1, type: 'lidarr', name: 'My Lidarr', enabled: true, owned: true },
      {
        id: 2,
        type: 'plex-playlist',
        name: 'My Plex Playlist',
        enabled: true,
        owned: true,
      },
    ])
    expect(mockDeps.getEnabledTargetsForUser).toHaveBeenCalledWith(1)
  })
})
