// @vitest-environment node
import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/db/queries/users', () => ({
  getUserByPlexAccountId: vi.fn(),
}))

vi.mock('@/db/queries/plex-scrobbles', () => ({
  recordPlexScrobble: vi.fn(),
}))

import { realtimeBroker } from '@/core/realtime/broker'
import { recordPlexScrobble } from '@/db/queries/plex-scrobbles'
import { getUserByPlexAccountId } from '@/db/queries/users'
import type { AppDependencies } from '@/server'
import { createApp } from '@/server'
import { webhookRoutes } from '@/server/routes/webhooks'

const mockGetUserByPlexAccountId = vi.mocked(getUserByPlexAccountId)
const mockRecordPlexScrobble = vi.mocked(recordPlexScrobble)

const FAKE_USER = { id: 7 } as never

function buildApp(overrides: { handleLibraryWebhookEvent?: (userId: number) => void } = {}) {
  const app = new Hono()
  app.route('/', webhookRoutes({ db: {} as never, ...overrides } as unknown as AppDependencies))
  return app
}

function payloadBody(payload: Record<string, unknown>) {
  const form = new FormData()
  form.set('payload', JSON.stringify(payload))
  return form
}

describe('POST /api/v1/webhooks/plex', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('always returns 200, even for an unmatched Plex account', async () => {
    mockGetUserByPlexAccountId.mockResolvedValue(null)
    const app = buildApp()

    const res = await app.request('/api/v1/webhooks/plex', {
      method: 'POST',
      body: payloadBody({ event: 'media.scrobble', Account: { id: 999 } }),
    })

    expect(res.status).toBe(200)
    expect(mockRecordPlexScrobble).not.toHaveBeenCalled()
  })

  it('ignores payloads with no Account.id without touching the db', async () => {
    const app = buildApp()

    const res = await app.request('/api/v1/webhooks/plex', {
      method: 'POST',
      body: payloadBody({ event: 'media.scrobble' }),
    })

    expect(res.status).toBe(200)
    expect(mockGetUserByPlexAccountId).not.toHaveBeenCalled()
  })

  it('ignores malformed (non-JSON) payload field without throwing', async () => {
    const app = buildApp()
    const form = new FormData()
    form.set('payload', '{not json')

    const res = await app.request('/api/v1/webhooks/plex', { method: 'POST', body: form })

    expect(res.status).toBe(200)
    expect(mockGetUserByPlexAccountId).not.toHaveBeenCalled()
  })

  it('ignores requests with no payload field at all', async () => {
    const app = buildApp()
    const res = await app.request('/api/v1/webhooks/plex', {
      method: 'POST',
      body: new FormData(),
    })
    expect(res.status).toBe(200)
  })

  it('records a media.scrobble event for a matched track and publishes a realtime update', async () => {
    mockGetUserByPlexAccountId.mockResolvedValue(FAKE_USER)
    mockRecordPlexScrobble.mockResolvedValue(undefined)
    const publishSpy = vi.spyOn(realtimeBroker, 'publish').mockImplementation(() => {})
    const app = buildApp()

    const res = await app.request('/api/v1/webhooks/plex', {
      method: 'POST',
      body: payloadBody({
        event: 'media.scrobble',
        Account: { id: 123 },
        Metadata: { type: 'track', title: 'Song', grandparentTitle: 'Artist' },
      }),
    })

    expect(res.status).toBe(200)
    expect(mockRecordPlexScrobble).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ userId: 7, artistName: 'Artist', trackName: 'Song' }),
    )
    expect(publishSpy).toHaveBeenCalledWith(7, { type: 'listening-updated' })
    publishSpy.mockRestore()
  })

  it('does not record a scrobble for a matched account when Metadata.type is not "track"', async () => {
    mockGetUserByPlexAccountId.mockResolvedValue(FAKE_USER)
    const app = buildApp()

    const res = await app.request('/api/v1/webhooks/plex', {
      method: 'POST',
      body: payloadBody({
        event: 'media.scrobble',
        Account: { id: 123 },
        Metadata: { type: 'episode', title: 'Song', grandparentTitle: 'Artist' },
      }),
    })

    expect(res.status).toBe(200)
    expect(mockRecordPlexScrobble).not.toHaveBeenCalled()
  })

  it('does not record a scrobble when track/artist title is missing', async () => {
    mockGetUserByPlexAccountId.mockResolvedValue(FAKE_USER)
    const app = buildApp()

    const res = await app.request('/api/v1/webhooks/plex', {
      method: 'POST',
      body: payloadBody({
        event: 'media.scrobble',
        Account: { id: 123 },
        Metadata: { type: 'track' },
      }),
    })

    expect(res.status).toBe(200)
    expect(mockRecordPlexScrobble).not.toHaveBeenCalled()
  })

  it('ignores unrecognized event types for a matched account', async () => {
    mockGetUserByPlexAccountId.mockResolvedValue(FAKE_USER)
    const app = buildApp()

    const res = await app.request('/api/v1/webhooks/plex', {
      method: 'POST',
      body: payloadBody({ event: 'media.rate', Account: { id: 123 } }),
    })

    expect(res.status).toBe(200)
    expect(mockRecordPlexScrobble).not.toHaveBeenCalled()
  })

  it('dispatches library.new events to handleLibraryWebhookEvent for the matched user', async () => {
    mockGetUserByPlexAccountId.mockResolvedValue(FAKE_USER)
    const handleLibraryWebhookEvent = vi.fn()
    const app = buildApp({ handleLibraryWebhookEvent })

    const res = await app.request('/api/v1/webhooks/plex', {
      method: 'POST',
      body: payloadBody({ event: 'library.new', Account: { id: 123 } }),
    })

    expect(res.status).toBe(200)
    expect(handleLibraryWebhookEvent).toHaveBeenCalledWith(7)
    expect(mockRecordPlexScrobble).not.toHaveBeenCalled()
  })

  it('does not throw when handleLibraryWebhookEvent is not configured', async () => {
    mockGetUserByPlexAccountId.mockResolvedValue(FAKE_USER)
    const app = buildApp()

    const res = await app.request('/api/v1/webhooks/plex', {
      method: 'POST',
      body: payloadBody({ event: 'library.new', Account: { id: 123 } }),
    })

    expect(res.status).toBe(200)
  })

  it('returns 200 even if a downstream call throws', async () => {
    mockGetUserByPlexAccountId.mockRejectedValue(new Error('db unavailable'))
    const app = buildApp()

    const res = await app.request('/api/v1/webhooks/plex', {
      method: 'POST',
      body: payloadBody({ event: 'media.scrobble', Account: { id: 123 } }),
    })

    expect(res.status).toBe(200)
  })
})

describe('POST /api/v1/webhooks/plex through the full app (auth/CSRF-exempt path)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('is reachable with no session and no CSRF header, as an unauthenticated server-to-server POST', async () => {
    mockGetUserByPlexAccountId.mockResolvedValue(null)
    const deps = {
      db: {} as never,
      getUserCount: vi.fn(async () => 1),
      isSetupComplete: async () => true,
      getSettings: vi.fn(async () => ({ id: 1 }) as never),
    } as unknown as AppDependencies
    const app = createApp(deps)

    // No Authorization header, no cookie, no Origin/Referer/Sec-Fetch-Site --
    // this is what a real Plex Media Server webhook POST looks like, and is
    // exactly what authGuard's PUBLIC_PATHS + csrfGuard's browser-signal
    // check are relied on to let through untouched.
    const res = await app.request('/api/v1/webhooks/plex', {
      method: 'POST',
      body: payloadBody({ event: 'media.scrobble', Account: { id: 999 } }),
    })

    expect(res.status).toBe(200)
  })
})
