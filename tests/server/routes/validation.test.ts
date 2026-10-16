// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearAllSessions, createSession } from '@/core/sessions'
import { createTestApp } from '../../helpers/test-app'

const adminUser = {
  id: 1,
  username: 'admin',
  isAdmin: true,
  preferences: null,
  email: null,
  authProvider: 'local' as const,
  listenbrainzUsername: null,
  listenbrainzToken: null,
  lastfmUsername: null,
  lastfmApiKey: null,
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
}

async function authedApp() {
  const { app, deps } = createTestApp({
    getUserById: vi.fn(async (id: number) => (id === 1 ? adminUser : null)),
    getUserCount: vi.fn(async () => 1),
    getUserByUsername: vi.fn(async () => null),
  })
  await clearAllSessions()
  const token = 'test-session-token'
  await createSession(adminUser.id, token)
  return { app, deps, headers: { Authorization: `Bearer ${token}` } }
}

beforeEach(async () => {
  await clearAllSessions()
})

describe('validation: shared error shape', () => {
  it('returns error summary + code + details for a validation failure', async () => {
    const { app, headers } = await authedApp()
    const res = await app.request('/api/v1/users/1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ isAdmin: 'yes' }),
    })

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('validation_failed')
    expect(typeof body.error).toBe('string')
    expect(Array.isArray(body.details)).toBe(true)
    expect(body.details.length).toBeGreaterThan(0)
    expect(body.details[0]).toHaveProperty('path')
    expect(body.details[0]).toHaveProperty('code')
    expect(body.details[0]).toHaveProperty('message')
  })
})

describe('validation: auth.register', () => {
  it('rejects missing username', async () => {
    const { app } = await authedApp()
    const res = await app.request('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'password1234' }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('validation_failed')
    expect(body.details.some((d: { path: string[] }) => d.path.includes('username'))).toBe(true)
  })

  it('rejects password shorter than 12 characters', async () => {
    const { app } = await authedApp()
    const res = await app.request('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'elevenchars' }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('validation_failed')
    expect(body.details.some((d: { path: string[] }) => d.path.includes('password'))).toBe(true)
  })

  it('rejects username with wrong type', async () => {
    const { app } = await authedApp()
    const res = await app.request('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 42, password: 'password1234' }),
    })
    expect(res.status).toBe(400)
  })
})

describe('validation: users', () => {
  it('rejects PATCH /api/users/:id with non-boolean isAdmin', async () => {
    const { app, headers } = await authedApp()
    const res = await app.request('/api/v1/users/1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ isAdmin: 'yes' }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('validation_failed')
  })

  it('rejects PATCH /api/users/:id with unknown field', async () => {
    const { app, headers } = await authedApp()
    const res = await app.request('/api/v1/users/2', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ isAdmin: true, passwordHash: 'injected' }),
    })
    expect(res.status).toBe(400)
  })

  it('rejects PATCH /api/users/:id with non-numeric id param', async () => {
    const { app, headers } = await authedApp()
    const res = await app.request('/api/v1/users/not-a-number', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ isAdmin: true }),
    })
    expect(res.status).toBe(400)
  })
})

describe('validation: settings PATCH', () => {
  it('rejects librarySyncIntervalHours out of range', async () => {
    const { app, headers } = await authedApp()
    const res = await app.request('/api/v1/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ librarySyncIntervalHours: 99 }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('validation_failed')
  })

  it('rejects skipTlsVerify with wrong type', async () => {
    const { app, headers } = await authedApp()
    const res = await app.request('/api/v1/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ skipTlsVerify: 'true' }),
    })
    expect(res.status).toBe(400)
  })

  it('rejects scoringWeights.consensus out of [0, 1]', async () => {
    const { app, headers } = await authedApp()
    const res = await app.request('/api/v1/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({
        preferences: { scoringWeights: { consensus: 2.5 } },
      }),
    })
    expect(res.status).toBe(400)
  })
})

describe('validation: recommendations', () => {
  it('rejects PATCH with invalid status enum', async () => {
    const { app, headers } = await authedApp()
    const res = await app.request('/api/v1/recommendations/1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ status: 'maybe' }),
    })
    expect(res.status).toBe(400)
  })

  it('rejects bulk with >500 ids (array size cap)', async () => {
    const { app, headers } = await authedApp()
    const res = await app.request('/api/v1/recommendations/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({
        ids: Array.from({ length: 501 }, (_, i) => i + 1),
        action: 'reject',
      }),
    })
    expect(res.status).toBe(400)
  })

  it('rejects bulk with invalid action', async () => {
    const { app, headers } = await authedApp()
    const res = await app.request('/api/v1/recommendations/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ ids: [1, 2], action: 'nonsense' }),
    })
    expect(res.status).toBe(400)
  })

  it('rejects GET query with invalid sort enum', async () => {
    const { app, headers } = await authedApp()
    const res = await app.request('/api/v1/recommendations?sort=random', {
      headers,
    })
    expect(res.status).toBe(400)
  })
})

// Playlist routes need playlistDeps wired; covered by playlists.test.ts.

describe('validation: oauth initiate', () => {
  it('rejects non-http redirectUri', async () => {
    const { app, headers } = await authedApp()
    const res = await app.request('/api/v1/auth/oauth/spotify/initiate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({
        clientId: 'x',
        clientSecret: 'y',
        redirectUri: 'javascript:alert(1)',
      }),
    })
    expect(res.status).toBe(400)
  })
})

describe('validation: quick-discover', () => {
  it('rejects empty artistName', async () => {
    const { app, headers } = await authedApp()
    const res = await app.request('/api/v1/pipeline/quick-discover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ artistName: '' }),
    })
    expect(res.status).toBe(400)
  })
})

describe('validation: admin restore', () => {
  it('rejects POST /api/admin/restore without confirm=true', async () => {
    const { app, headers } = await authedApp()
    const res = await app.request('/api/v1/admin/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('confirmation_required')
  })

  it('rejects POST /api/admin/restore with missing data section', async () => {
    const { app, headers } = await authedApp()
    const res = await app.request('/api/v1/admin/restore?confirm=true', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({
        version: 1,
        appVersion: '0.27.10',
        createdAt: '2026-04-15',
        encryptionKeyHash: null,
        includesCaches: false,
        // data: {} missing entirely
      }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('validation_failed')
  })

  it('rejects POST /api/admin/restore when a table is not an array', async () => {
    const { app, headers } = await authedApp()
    const res = await app.request('/api/v1/admin/restore?confirm=true', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({
        version: 1,
        appVersion: '0.27.10',
        createdAt: '2026-04-15',
        encryptionKeyHash: null,
        includesCaches: false,
        data: {
          settings: 'not-an-array',
          users: [],
          oauthTokens: [],
          targets: [],
          subscriptions: [],
          jobRuns: [],
          recommendationBatches: [],
          recommendations: [],
          playlists: [],
          playlistTracks: [],
        },
      }),
    })
    expect(res.status).toBe(400)
  })
})
