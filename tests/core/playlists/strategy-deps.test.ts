// @vitest-environment node

import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildStrategyDeps } from '@/core/playlists/strategy-deps'
import { AiProviderRegistry } from '@/core/providers/registry'
import type { RecommendationProvider } from '@/core/providers/types'
import type { Database } from '@/db'
import { updateSettings } from '@/db/queries/settings'
import { libraryAlbums, libraryArtists, users } from '@/db/schema'
import { makeTestDb } from '../../helpers/test-db'

describe('buildStrategyDeps -- selectAlbumsWithAi', () => {
  let db: Database
  let close: () => Promise<void>
  let userId: number

  beforeEach(async () => {
    const testDb = await makeTestDb()
    db = testDb.db as unknown as Database
    close = testDb.close

    const [user] = await db
      .insert(users)
      .values({ username: `strategy-deps-${randomUUID()}`, passwordHash: 'test-hash' })
      .returning({ id: users.id })
    if (!user) throw new Error('test user was not created')
    userId = user.id
  })

  afterEach(async () => {
    await close()
  })

  async function seedAlbum(opts: {
    artistName: string
    artistMbid: string
    genres: string[]
    albumTitle: string
    releaseYear: number
  }) {
    await db.insert(libraryArtists).values({
      userId,
      source: 'lidarr',
      sourceArtistId: opts.artistMbid,
      name: opts.artistName,
      nameNormalized: opts.artistName.toLowerCase(),
      mbid: opts.artistMbid,
      genres: opts.genres,
    })
    await db.insert(libraryAlbums).values({
      userId,
      source: 'lidarr',
      sourceAlbumId: randomUUID(),
      sourceArtistId: opts.artistMbid,
      title: opts.albumTitle,
      titleNormalized: opts.albumTitle.toLowerCase(),
      artistMbid: opts.artistMbid,
      releaseYear: opts.releaseYear,
      primaryType: 'Album',
    })
  }

  function registryWithProvider(pickResponse: unknown): AiProviderRegistry {
    const registry = new AiProviderRegistry()
    const provider: RecommendationProvider = {
      lastUsage: null,
      async getRecommendations() {
        return pickResponse as never
      },
      async testConnection() {
        return { success: true, message: 'ok' }
      },
    }
    registry.register({ id: 'openai', name: 'OpenAI', create: async () => provider })
    return registry
  }

  it('returns [] when AI is not configured', async () => {
    const registry = registryWithProvider([])
    const deps = buildStrategyDeps(db, userId, registry)

    const result = await deps.selectAlbumsWithAi?.({ prompt: 'mellow 90s', size: 10 })
    expect(result).toEqual([])
  })

  it('scopes candidates to the library and only keeps verbatim (artist, album) matches', async () => {
    await updateSettings(db, { aiProvider: 'openai', aiModel: 'gpt-test' })
    await seedAlbum({
      artistName: 'Real Artist',
      artistMbid: randomUUID(),
      genres: ['ambient'],
      albumTitle: 'Real Album',
      releaseYear: 2010,
    })

    const registry = registryWithProvider([
      {
        artistName: 'Real Artist',
        suggestedAlbum: 'Real Album',
        reasoning: 'matches request',
        confidence: 0.9,
        genres: ['ambient'],
      },
      {
        artistName: 'Hallucinated Artist',
        suggestedAlbum: 'Made Up Album',
        reasoning: 'not real',
        confidence: 0.9,
        genres: ['ambient'],
      },
    ])
    const deps = buildStrategyDeps(db, userId, registry)

    const result = await deps.selectAlbumsWithAi?.({ prompt: 'ambient sounds', size: 10 })
    expect(result).toHaveLength(1)
    expect(result?.[0]).toMatchObject({
      name: 'Real Artist',
      albumTitle: 'Real Album',
    })
  })

  it('returns [] when no library albums match the extracted filters', async () => {
    await updateSettings(db, { aiProvider: 'openai', aiModel: 'gpt-test' })
    await seedAlbum({
      artistName: 'Modern Artist',
      artistMbid: randomUUID(),
      genres: ['pop'],
      albumTitle: 'New Release',
      releaseYear: 2023,
    })

    const registry = registryWithProvider([])
    const deps = buildStrategyDeps(db, userId, registry)

    const result = await deps.selectAlbumsWithAi?.({
      prompt: 'give me some 1990s grunge',
      size: 10,
    })
    expect(result).toEqual([])
  })
})
