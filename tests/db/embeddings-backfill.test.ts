// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { backfillEmbeddings, invalidateEmbeddingIndex } from '@/core/embeddings'
import { createEmbeddingService } from '@/core/embeddings/service'
import type { RecommendationProvider } from '@/core/providers/types'
import type { Database } from '@/db'
import { artists, libraryArtists, users } from '@/db/schema'
import { makeTestDb } from '../helpers/test-db'

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 })

let db: Database
let close: () => Promise<void>
let userId: number

// Deterministic fake: the vector leans on whether the text mentions "ambient".
function fakeEmbedder() {
  const calls: string[][] = []
  const provider: RecommendationProvider = {
    async getRecommendations() {
      return []
    },
    async testConnection() {
      return { success: true, message: 'ok' }
    },
    async embed(texts) {
      calls.push(texts)
      return texts.map((t) => (t.includes('ambient') ? [1, 0.1, 0] : [0, 0.1, 1]))
    },
  }
  return { provider, calls }
}

beforeEach(async () => {
  const t = await makeTestDb()
  db = t.db as unknown as Database
  close = t.close
  invalidateEmbeddingIndex()
  const [u] = await db
    .insert(users)
    .values({ username: 'u', passwordHash: 'x' })
    .returning({ id: users.id })
  userId = u?.id as number
  await db.insert(artists).values([
    { mbid: '11111111-1111-1111-1111-111111111111', name: 'Grouper', genres: ['ambient'] },
    { mbid: '22222222-2222-2222-2222-222222222222', name: 'Stars of the Lid', genres: ['ambient'] },
    { mbid: '33333333-3333-3333-3333-333333333333', name: 'Slayer', genres: ['thrash metal'] },
  ])
  await db.insert(libraryArtists).values({
    userId,
    source: 'plex',
    sourceArtistId: 'p1',
    name: 'Grouper',
    nameNormalized: 'grouper',
    mbid: '11111111-1111-1111-1111-111111111111',
    genres: ['ambient'],
  })
})

afterEach(async () => close())

describe('embedding backfill + service', () => {
  it('embeds once, skips unchanged artists, and finds neighbors', async () => {
    const { provider, calls } = fakeEmbedder()
    expect(await backfillEmbeddings(db, provider, 'fake')).toEqual({ embedded: 3, pending: 0 })
    expect(await backfillEmbeddings(db, provider, 'fake')).toEqual({ embedded: 0, pending: 0 })
    expect(calls).toHaveLength(1)

    const service = createEmbeddingService({
      db,
      getProvider: async () => ({ provider, model: 'fake' }),
    })
    const similar = await service.similar(
      userId,
      { mbid: '22222222-2222-2222-2222-222222222222', name: 'Stars of the Lid' },
      2,
    )
    expect(similar?.[0]).toMatchObject({ name: 'Grouper', owned: true })

    const semantic = await service.semanticScores(userId, [
      { mbid: '22222222-2222-2222-2222-222222222222', name: 'Stars of the Lid' },
      { mbid: '33333333-3333-3333-3333-333333333333', name: 'Slayer' },
    ])
    expect(semantic.get('22222222-2222-2222-2222-222222222222')).toBeGreaterThan(
      semantic.get('33333333-3333-3333-3333-333333333333') ?? 1,
    )
  })

  it('waits out a rate limit and retries the same batch', async () => {
    const { provider } = fakeEmbedder()
    const real = provider.embed?.bind(provider)
    let calls = 0
    provider.embed = async (texts) => {
      calls++
      if (calls === 1) throw new Error('rate limited (429)')
      return real ? real(texts) : []
    }
    const result = await backfillEmbeddings(db, provider, 'fake', undefined, {
      pauseMs: 0,
      rateLimitWaitMs: 0,
    })
    expect(result).toEqual({ embedded: 3, pending: 0 })
    expect(calls).toBe(2)
  })

  it('stops after repeated rate limits and reports what is left', async () => {
    const { provider } = fakeEmbedder()
    provider.embed = async () => {
      throw new Error('rate limited (429)')
    }
    const result = await backfillEmbeddings(db, provider, 'fake', undefined, {
      pauseMs: 0,
      rateLimitWaitMs: 0,
    })
    expect(result).toEqual({ embedded: 0, pending: 3 })
  })

  it('reports unavailable when the provider cannot embed', async () => {
    const service = createEmbeddingService({ db, getProvider: async () => null })
    expect(await service.similar(userId, { mbid: null, name: 'Grouper' })).toBeNull()
    expect(await service.tasteMap(userId)).toBeNull()
  })
})
