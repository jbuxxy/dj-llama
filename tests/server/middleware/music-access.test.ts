// @vitest-environment node

import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { canUseApp, musicAccessGuard } from '@/server/middleware/music-access'
import type { HonoEnv } from '@/server/types'

type User = { isAdmin: boolean; hasMusicAccess: boolean; plexAccessRevokedAt: Date | null }

function appFor(user: User | null, legacy = false) {
  const app = new Hono<HonoEnv>()
  app.use('*', async (c, next) => {
    c.set('userId', 5)
    if (legacy) c.set('legacyTokenAuth', true)
    await next()
  })
  app.use('*', musicAccessGuard(vi.fn(async () => user)))
  app.get('/api/v1/recommendations', (c) => c.json({ ok: true }))
  app.get('/api/v1/auth/status', (c) => c.json({ ok: true }))
  return app
}

const listener: User = { isAdmin: false, hasMusicAccess: true, plexAccessRevokedAt: null }

describe('canUseApp', () => {
  it('lets admins in without music access but not once revoked', () => {
    expect(canUseApp({ ...listener, isAdmin: true, hasMusicAccess: false })).toBe(true)
    expect(canUseApp({ ...listener, isAdmin: true, plexAccessRevokedAt: new Date() })).toBe(false)
  })
})

describe('musicAccessGuard', () => {
  it('allows users with music access', async () => {
    const res = await appFor(listener).request('/api/v1/recommendations')
    expect(res.status).toBe(200)
  })

  it('rejects users without music access', async () => {
    const res = await appFor({ ...listener, hasMusicAccess: false }).request(
      '/api/v1/recommendations',
    )
    expect(res.status).toBe(403)
  })

  it('rejects revoked users', async () => {
    const res = await appFor({ ...listener, plexAccessRevokedAt: new Date() }).request(
      '/api/v1/recommendations',
    )
    expect(res.status).toBe(403)
  })

  it('still lets a locked-out user check their status', async () => {
    const res = await appFor({ ...listener, hasMusicAccess: false }).request('/api/v1/auth/status')
    expect(res.status).toBe(200)
  })
})
