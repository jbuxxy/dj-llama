// @vitest-environment node

import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/core/clients/lidarr', () => ({
  createLidarrClient: vi.fn(),
}))

import { createLidarrClient } from '@/core/clients/lidarr'
import { type MoodDeps, moodRoutes } from '@/server/routes/mood'

const mockCreateLidarrClient = vi.mocked(createLidarrClient)

function makeDeps(overrides: Partial<MoodDeps> = {}): MoodDeps {
  return {
    getSettings: vi.fn().mockResolvedValue({
      aiProvider: 'openai',
      aiModel: 'gpt-4o-mini',
      aiApiKey: 'test-key',
      aiBaseUrl: null,
    }),
    providerRegistry: {
      create: vi.fn().mockResolvedValue({
        getRecommendations: vi.fn().mockResolvedValue([
          {
            artistName: 'Grouper',
            reasoning: 'Ambient folk artist known for hazy textures.',
            confidence: 0.87,
            genres: ['ambient', 'drone'],
            suggestedAlbum: 'Dragging a Dead Deer Up a Hill',
          },
        ]),
        testConnection: vi.fn(),
      }),
    } as unknown as MoodDeps['providerRegistry'],
    ...overrides,
  }
}

describe('POST /api/v1/mood/discover', () => {
  it('returns AI recommendations for mood query', async () => {
    const deps = makeDeps()
    const app = new Hono()
    app.route('/', moodRoutes(deps))

    const res = await app.request('/api/v1/mood/discover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'dark ambient with field recordings' }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { results: unknown[] }
    expect(body.results).toHaveLength(1)
  })

  it('rejects empty query', async () => {
    const app = new Hono()
    app.route('/', moodRoutes(makeDeps()))

    const res = await app.request('/api/v1/mood/discover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '' }),
    })
    expect(res.status).toBe(400)
  })

  it('rejects when AI provider not configured', async () => {
    const app = new Hono()
    app.route(
      '/',
      moodRoutes(
        makeDeps({
          getSettings: vi.fn().mockResolvedValue({ aiProvider: null, aiModel: null }),
        }),
      ),
    )

    const res = await app.request('/api/v1/mood/discover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'chill vibes' }),
    })
    expect(res.status).toBe(400)
  })

  it('returns 502 with provider detail when the AI call fails', async () => {
    const app = new Hono()
    app.route(
      '/',
      moodRoutes(
        makeDeps({
          providerRegistry: {
            create: vi.fn().mockResolvedValue({
              getRecommendations: vi
                .fn()
                .mockRejectedValue(new Error('client error 404: model "gpt-4o-mini" not found')),
              testConnection: vi.fn(),
            }),
          } as unknown as MoodDeps['providerRegistry'],
        }),
      ),
    )

    const res = await app.request('/api/v1/mood/discover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'chill vibes' }),
    })

    expect(res.status).toBe(502)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('openai/gpt-4o-mini')
    expect(body.error).toContain('client error 404')
  })

  it('marks an already-owned suggestion instead of dropping it from the results', async () => {
    mockCreateLidarrClient.mockReturnValue({
      getArtists: vi.fn(async () => [{ id: 1, artistName: 'Grouper', foreignArtistId: 'a-1' }]),
      getAlbums: vi.fn(async () => [{ id: 10, title: 'Dragging a Dead Deer Up a Hill' }]),
      lookupAlbum: vi.fn(async () => []),
      lookupArtist: vi.fn(async () => []),
    } as never)

    const app = new Hono()
    app.route(
      '/',
      moodRoutes(
        makeDeps({
          getSettings: vi.fn().mockResolvedValue({
            aiProvider: 'openai',
            aiModel: 'gpt-4o-mini',
            aiApiKey: 'test-key',
            lidarrUrl: 'http://lidarr.local',
            lidarrApiKey: 'lidarr-key',
          }),
        }),
      ),
    )

    const res = await app.request('/api/v1/mood/discover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'dark ambient with field recordings' }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      results: Array<{ artistName: string; alreadyOwned: boolean }>
    }
    // Still in the response (not filtered out), just flagged.
    expect(body.results).toHaveLength(1)
    expect(body.results[0]).toMatchObject({ artistName: 'Grouper', alreadyOwned: true })
  })

  it('resolves cover art for a suggested album via Lidarr album lookup, ranked by relevance', async () => {
    mockCreateLidarrClient.mockReturnValue({
      getArtists: vi.fn(async () => []),
      getAlbums: vi.fn(async () => []),
      lookupAlbum: vi.fn(async (term: string) => {
        expect(term).toBe('Dragging a Dead Deer Up a Hill')
        return [
          {
            title: 'Dragging a Dead Deer Up a Hill',
            artist: { artistName: 'Someone Else', foreignArtistId: 'wrong-artist' },
            images: [{ coverType: 'cover', url: '/MediaCover/9/wrong.jpg' }],
          },
          {
            title: 'Dragging a Dead Deer Up a Hill',
            artist: { artistName: 'Grouper', foreignArtistId: 'a-1' },
            images: [{ coverType: 'cover', url: '/MediaCover/1/right.jpg' }],
          },
        ]
      }),
      lookupArtist: vi.fn(async () => []),
    } as never)

    const app = new Hono()
    app.route(
      '/',
      moodRoutes(
        makeDeps({
          getSettings: vi.fn().mockResolvedValue({
            aiProvider: 'openai',
            aiModel: 'gpt-4o-mini',
            aiApiKey: 'test-key',
            lidarrUrl: 'http://lidarr.local',
            lidarrApiKey: 'lidarr-key',
          }),
        }),
      ),
    )

    const res = await app.request('/api/v1/mood/discover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'dark ambient with field recordings' }),
    })

    const body = (await res.json()) as { results: Array<{ coverUrl?: string }> }
    expect(body.results[0]?.coverUrl).toBe('http://lidarr.local/MediaCover/1/right.jpg')
  })

  it('falls back to Lidarr artist lookup for cover art when there is no suggestedAlbum', async () => {
    mockCreateLidarrClient.mockReturnValue({
      getArtists: vi.fn(async () => []),
      getAlbums: vi.fn(async () => []),
      lookupAlbum: vi.fn(async () => []),
      lookupArtist: vi.fn(async () => [
        {
          artistName: 'Grouper',
          foreignArtistId: 'a-1',
          images: [{ coverType: 'poster', url: '/MediaCover/2/poster.jpg' }],
        },
      ]),
    } as never)

    const app = new Hono()
    app.route(
      '/',
      moodRoutes(
        makeDeps({
          providerRegistry: {
            create: vi.fn().mockResolvedValue({
              getRecommendations: vi.fn().mockResolvedValue([
                {
                  artistName: 'Grouper',
                  reasoning: 'Ambient folk artist known for hazy textures.',
                  confidence: 0.87,
                  genres: ['ambient', 'drone'],
                },
              ]),
              testConnection: vi.fn(),
            }),
          } as unknown as MoodDeps['providerRegistry'],
          getSettings: vi.fn().mockResolvedValue({
            aiProvider: 'openai',
            aiModel: 'gpt-4o-mini',
            aiApiKey: 'test-key',
            lidarrUrl: 'http://lidarr.local',
            lidarrApiKey: 'lidarr-key',
          }),
        }),
      ),
    )

    const res = await app.request('/api/v1/mood/discover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'chill vibes' }),
    })

    const body = (await res.json()) as { results: Array<{ coverUrl?: string }> }
    expect(body.results[0]?.coverUrl).toBe('http://lidarr.local/MediaCover/2/poster.jpg')
  })
})
