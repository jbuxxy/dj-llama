// @vitest-environment node

import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/core/clients/lidarr', () => ({
  getSharedLidarrClient: vi.fn(),
}))
vi.mock('@/db/queries/lidarr-cache', () => ({
  getLidarrAlbumTitlesByArtist: vi.fn(async () => new Map()),
}))

import { getSharedLidarrClient } from '@/core/clients/lidarr'
import { getLidarrAlbumTitlesByArtist } from '@/db/queries/lidarr-cache'
import { type MoodDeps, moodRoutes } from '@/server/routes/mood'

const mockCreateLidarrClient = vi.mocked(getSharedLidarrClient)
const mockOwnedTitles = vi.mocked(getLidarrAlbumTitlesByArtist)

function makeDeps(overrides: Partial<MoodDeps> = {}): MoodDeps {
  return {
    db: {} as MoodDeps['db'],
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
    // Ownership comes from the synced library snapshot, keyed by normalized names.
    mockOwnedTitles.mockResolvedValueOnce(
      new Map([['grouper', new Set(['dragging a dead deer up a hill'])]]),
    )
    mockCreateLidarrClient.mockReturnValue({
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

  it('streams NDJSON results as the provider produces them when asked', async () => {
    const recs = [
      { artistName: 'Grouper', reasoning: 'r', confidence: 0.9, genres: ['ambient'] },
      { artistName: 'Tim Hecker', reasoning: 'r', confidence: 0.8, genres: ['drone'] },
    ]
    const app = new Hono()
    app.route(
      '/',
      moodRoutes(
        makeDeps({
          providerRegistry: {
            create: vi.fn().mockResolvedValue({
              getRecommendations: vi.fn(),
              streamRecommendations: vi.fn(async (_p: unknown, onRec: (r: unknown) => void) => {
                for (const r of recs) onRec(r)
                return recs
              }),
              testConnection: vi.fn(),
            }),
          } as unknown as MoodDeps['providerRegistry'],
        }),
      ),
    )

    const res = await app.request('/api/v1/mood/discover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
      body: JSON.stringify({ query: 'dark ambient' }),
    })
    expect(res.headers.get('content-type')).toContain('application/x-ndjson')
    const events = (await res.text())
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { type: string; result?: { artistName: string } })
    expect(events.filter((e) => e.type === 'result').map((e) => e.result?.artistName)).toEqual([
      'Grouper',
      'Tim Hecker',
    ])
    expect(events.at(-1)).toEqual({ type: 'done', count: 2 })
  })

  it('falls back to the one-shot call when streaming fails before any result', async () => {
    const getRecommendations = vi
      .fn()
      .mockResolvedValue([{ artistName: 'Eno', reasoning: 'r', confidence: 0.9, genres: [] }])
    const app = new Hono()
    app.route(
      '/',
      moodRoutes(
        makeDeps({
          providerRegistry: {
            create: vi.fn().mockResolvedValue({
              getRecommendations,
              streamRecommendations: vi.fn().mockRejectedValue(new Error('no streaming here')),
              testConnection: vi.fn(),
            }),
          } as unknown as MoodDeps['providerRegistry'],
        }),
      ),
    )
    const res = await app.request('/api/v1/mood/discover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
      body: JSON.stringify({ query: 'ambient' }),
    })
    const text = await res.text()
    expect(text).toContain('"artistName":"Eno"')
    expect(getRecommendations).toHaveBeenCalledTimes(1)
  })
})
