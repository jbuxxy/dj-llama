// @vitest-environment node

/**
 * Tests for the first-owner bootstrap race (Phase 0a). Migration 0054
 * installs a partial unique index `users_single_owner ON users(is_owner)
 * WHERE is_owner = true` that guarantees at-most-one owner at the DB layer
 * (retargeted from the old, overly-strict `users_single_admin` index that
 * blocked promoting a second regular admin). These tests simulate the 23505
 * collision raised by the index and assert that the real Plex bootstrap
 * flow (POST /api/v1/auth/plex/select-library) resolves the race correctly
 * instead of surfacing a 500 -- the previous version of this file tested
 * POST /api/v1/auth/register, which has returned a hardcoded 403 since local
 * password auth was replaced by Plex-only OAuth, so it could not have been
 * passing.
 */

import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HonoEnv } from '@/server/types'

vi.mock('@/core/auth', () => ({
  hashPassword: vi.fn(() => 'mocked-hash'),
  verifyPassword: vi.fn(() => false),
}))

vi.mock('@/core/auth/plex', () => ({
  createPlexPin: vi.fn(),
  buildPlexAuthAppUrl: vi.fn(() => 'https://app.plex.tv/auth#?mock'),
  checkPlexPin: vi.fn(async () => 'identity-token'),
  getPlexAccount: vi.fn(async () => ({
    id: 555,
    username: 'racer',
    email: null,
    thumb: null,
  })),
  listOwnedPlexServers: vi.fn(async () => [{ name: 'Home', machineIdentifier: 'machine-1' }]),
  resolvePlexServerConnection: vi.fn(async () => ({
    url: 'http://plex.local:32400',
    accessToken: 'server-token',
    machineIdentifier: 'machine-1',
  })),
  getPlexLibrarySections: vi.fn(async () => [{ id: '1', title: 'Music', type: 'artist' }]),
}))

vi.mock('@/db/queries/settings', () => ({
  getSettings: vi.fn(async () => null),
  updateSettings: vi.fn(async () => {}),
}))

vi.mock('@/db/queries/users', () => ({
  createUser: vi.fn(),
  getUserByPlexAccountId: vi.fn(async () => null),
  markUserAsOwner: vi.fn(async () => {}),
  updateUser: vi.fn(async () => {}),
  updateUserConnections: vi.fn(async () => {}),
}))

vi.mock('@/server/helpers/session-auth', () => ({
  prepareSessionCookie: vi.fn(() => ({ name: 'djllama_session', options: {} })),
  issueSession: vi.fn(async () => {}),
}))

const { createUser } = await import('@/db/queries/users')
const { plexAuthRoutes } = await import('@/server/routes/auth-plex')

const PIN_COOKIE = 'djllama_plex_pin'
const BOOTSTRAP_COOKIE = 'djllama_plex_bootstrap'

function singleOwnerCollision(): Error {
  return Object.assign(new Error('duplicate key value violates unique constraint'), {
    code: '23505',
    constraint: 'users_single_owner',
  })
}

function extractCookieValue(res: Response, name: string): string {
  const setCookie = res.headers.get('set-cookie')
  const match = setCookie?.match(new RegExp(`(?:^|,\\s*)${name}=([^;]+)`))
  if (!match?.[1]) throw new Error(`${name} cookie missing from response`)
  return match[1]
}

function makeApp() {
  const app = new Hono<HonoEnv>()
  app.route('/', plexAuthRoutes({ db: {} as never }))
  return app
}

async function driveToSelectLibrary(app: Hono<HonoEnv>) {
  const pollRes = await app.request('/api/v1/auth/plex/poll', {
    headers: { Cookie: `${PIN_COOKIE}=42` },
  })
  expect(pollRes.status).toBe(200)
  const pollBody = await pollRes.json()
  expect(pollBody.status).toBe('select-library')
  return extractCookieValue(pollRes, BOOTSTRAP_COOKIE)
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('first-owner bootstrap race: POST /api/v1/auth/plex/select-library', () => {
  it('falls back to a non-owner, non-admin user when the single-owner index collides', async () => {
    let call = 0
    vi.mocked(createUser).mockImplementation(async (_db, data) => {
      call += 1
      if (call === 1) throw singleOwnerCollision()
      return { id: 2, username: data.username, isAdmin: data.isAdmin ?? false } as never
    })

    const app = makeApp()
    const bootstrapId = await driveToSelectLibrary(app)

    const res = await app.request('/api/v1/auth/plex/select-library', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `${BOOTSTRAP_COOKIE}=${bootstrapId}`,
      },
      body: JSON.stringify({ sectionIds: ['1'] }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('complete')
    expect(createUser).toHaveBeenCalledTimes(2)
    expect(createUser).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({ isAdmin: true, isOwner: true }),
    )
    expect(createUser).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({ isAdmin: false }),
    )
    const secondCallData = vi.mocked(createUser).mock.calls[1]?.[1] as { isOwner?: boolean }
    expect(secondCallData.isOwner).toBeUndefined()
  })

  it('propagates unrelated 23505 errors (e.g. username uniqueness) as 500', async () => {
    vi.mocked(createUser).mockImplementation(async () => {
      throw Object.assign(new Error('username taken'), {
        code: '23505',
        constraint: 'users_username_unique',
      })
    })

    const app = makeApp()
    const bootstrapId = await driveToSelectLibrary(app)

    const res = await app.request('/api/v1/auth/plex/select-library', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `${BOOTSTRAP_COOKIE}=${bootstrapId}`,
      },
      body: JSON.stringify({ sectionIds: ['1'] }),
    })

    expect(res.status).toBe(500)
    expect(createUser).toHaveBeenCalledTimes(1)
  })
})
