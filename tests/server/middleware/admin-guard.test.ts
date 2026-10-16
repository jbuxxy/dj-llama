// @vitest-environment node
import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { adminGuard, resolveAdmin } from '@/server/middleware/admin-guard'
import type { HonoEnv } from '@/server/types'

function makeApp(
  getUserById: (id: number) => Promise<{ isAdmin: boolean } | null>,
  ctx: { userId?: number; legacyTokenAuth?: boolean; authSkipped?: boolean } = {},
) {
  const app = new Hono<HonoEnv>()
  app.use('*', async (c, next) => {
    if (ctx.userId !== undefined) c.set('userId', ctx.userId)
    if (ctx.legacyTokenAuth !== undefined) c.set('legacyTokenAuth', ctx.legacyTokenAuth)
    if (ctx.authSkipped !== undefined) c.set('authSkipped', ctx.authSkipped)
    await next()
  })
  app.use('*', adminGuard(getUserById))
  app.get('/admin-only', (c) => c.text('ok'))
  return app
}

describe('adminGuard', () => {
  it('rejects with 403 when no userId is set', async () => {
    const getUserById = vi.fn(async () => null)
    const app = makeApp(getUserById)
    const res = await app.request('/admin-only')
    expect(res.status).toBe(403)
    expect(getUserById).not.toHaveBeenCalled()
  })

  it('rejects legacy-token auth with 403 without calling getUserById', async () => {
    const getUserById = vi.fn(async () => ({ isAdmin: true }))
    const app = makeApp(getUserById, { userId: 1, legacyTokenAuth: true })
    const res = await app.request('/admin-only')
    expect(res.status).toBe(403)
    expect(getUserById).not.toHaveBeenCalled()
  })

  it('rejects a non-admin user with 403', async () => {
    const getUserById = vi.fn(async () => ({ isAdmin: false }))
    const app = makeApp(getUserById, { userId: 5 })
    const res = await app.request('/admin-only')
    expect(res.status).toBe(403)
  })

  it('rejects when getUserById returns null (deleted/unknown user)', async () => {
    const getUserById = vi.fn(async () => null)
    const app = makeApp(getUserById, { userId: 5 })
    const res = await app.request('/admin-only')
    expect(res.status).toBe(403)
  })

  it('allows an admin user through', async () => {
    const getUserById = vi.fn(async () => ({ isAdmin: true }))
    const app = makeApp(getUserById, { userId: 1 })
    const res = await app.request('/admin-only')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
  })

  it('allows requests through when authSkipped is set, without checking admin status', async () => {
    const getUserById = vi.fn(async () => ({ isAdmin: false }))
    const app = makeApp(getUserById, { authSkipped: true })
    const res = await app.request('/admin-only')
    expect(res.status).toBe(200)
    expect(getUserById).not.toHaveBeenCalled()
  })
})

describe('resolveAdmin', () => {
  it('returns true when authSkipped, without calling getUserById', async () => {
    const getUserById = vi.fn(async () => null)
    await expect(resolveAdmin(undefined, getUserById, true)).resolves.toBe(true)
    expect(getUserById).not.toHaveBeenCalled()
  })

  it('returns false for legacy-token auth', async () => {
    const getUserById = vi.fn(async () => ({ isAdmin: true }))
    await expect(resolveAdmin(1, getUserById, false, true)).resolves.toBe(false)
    expect(getUserById).not.toHaveBeenCalled()
  })

  it('returns false when userId is undefined', async () => {
    const getUserById = vi.fn(async () => ({ isAdmin: true }))
    await expect(resolveAdmin(undefined, getUserById)).resolves.toBe(false)
    expect(getUserById).not.toHaveBeenCalled()
  })

  it('returns false when the user is not found', async () => {
    const getUserById = vi.fn(async () => null)
    await expect(resolveAdmin(1, getUserById)).resolves.toBe(false)
  })

  it("returns the looked-up user's isAdmin flag", async () => {
    const getUserById = vi.fn(async () => ({ isAdmin: true }))
    await expect(resolveAdmin(1, getUserById)).resolves.toBe(true)
  })
})
