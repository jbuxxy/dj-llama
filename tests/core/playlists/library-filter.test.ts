// @vitest-environment node

import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  extractDecadeFromText,
  extractGenreFromText,
  filterLibraryAlbums,
} from '@/core/playlists/library-filter'
import type { Database } from '@/db'
import { libraryAlbums, libraryArtists, users } from '@/db/schema'
import { makeTestDb } from '../../helpers/test-db'

describe('extractDecadeFromText', () => {
  it('matches a 4-digit decade', () => {
    expect(extractDecadeFromText('give me some 1990s shoegaze')).toBe(1990)
    expect(extractDecadeFromText('2020s hyperpop please')).toBe(2020)
  })

  it('matches a 2-digit shorthand decade', () => {
    expect(extractDecadeFromText('90s grunge')).toBe(1990)
    expect(extractDecadeFromText('00s indie')).toBe(2000)
    expect(extractDecadeFromText('20s pop')).toBe(2020)
  })

  it('returns undefined when no decade is mentioned', () => {
    expect(extractDecadeFromText('something mellow and moody')).toBeUndefined()
  })
})

describe('extractGenreFromText', () => {
  const known = ['ambient', 'drone', 'indie folk', 'synth']

  it('matches a known genre mentioned in the text', () => {
    expect(extractGenreFromText('something in the ambient space', known)).toBe('ambient')
  })

  it('prefers the longest match when multiple known genres overlap', () => {
    expect(extractGenreFromText('indie folk vibes', ['indie', 'indie folk'])).toBe('indie folk')
  })

  it('returns undefined when no known genre is mentioned', () => {
    expect(extractGenreFromText('upbeat summer jams', known)).toBeUndefined()
  })
})

describe('filterLibraryAlbums', () => {
  let db: Database
  let close: () => Promise<void>
  let userId: number

  beforeEach(async () => {
    const testDb = await makeTestDb()
    db = testDb.db as unknown as Database
    close = testDb.close

    const [user] = await db
      .insert(users)
      .values({ username: `lib-filter-${randomUUID()}`, passwordHash: 'test-hash' })
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
    primaryType: string
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
      primaryType: opts.primaryType,
    })
  }

  it('filters to the given decade', async () => {
    await seedAlbum({
      artistName: 'Nineties Band',
      artistMbid: randomUUID(),
      genres: ['grunge'],
      albumTitle: 'Old Album',
      releaseYear: 1994,
      primaryType: 'Album',
    })
    await seedAlbum({
      artistName: 'Modern Band',
      artistMbid: randomUUID(),
      genres: ['pop'],
      albumTitle: 'New Album',
      releaseYear: 2023,
      primaryType: 'Album',
    })

    const result = await filterLibraryAlbums(db, { userId, decade: 1990 })
    expect(result).toHaveLength(1)
    expect(result[0]?.artistName).toBe('Nineties Band')
  })

  it('OR-matches multiple decades when decades is set', async () => {
    await seedAlbum({
      artistName: 'Nineties Band',
      artistMbid: randomUUID(),
      genres: ['grunge'],
      albumTitle: 'Old Album',
      releaseYear: 1994,
      primaryType: 'Album',
    })
    await seedAlbum({
      artistName: 'Eighties Band',
      artistMbid: randomUUID(),
      genres: ['synthpop'],
      albumTitle: 'Retro Album',
      releaseYear: 1985,
      primaryType: 'Album',
    })
    await seedAlbum({
      artistName: 'Modern Band',
      artistMbid: randomUUID(),
      genres: ['pop'],
      albumTitle: 'New Album',
      releaseYear: 2023,
      primaryType: 'Album',
    })

    const result = await filterLibraryAlbums(db, { userId, decades: [1980, 1990] })
    const names = result.map((r) => r.artistName).sort()
    expect(names).toEqual(['Eighties Band', 'Nineties Band'])
  })

  it('returns everything when decades is empty (no filter)', async () => {
    await seedAlbum({
      artistName: 'Nineties Band',
      artistMbid: randomUUID(),
      genres: ['grunge'],
      albumTitle: 'Old Album',
      releaseYear: 1994,
      primaryType: 'Album',
    })
    await seedAlbum({
      artistName: 'Modern Band',
      artistMbid: randomUUID(),
      genres: ['pop'],
      albumTitle: 'New Album',
      releaseYear: 2023,
      primaryType: 'Album',
    })

    const result = await filterLibraryAlbums(db, { userId, decades: [] })
    expect(result).toHaveLength(2)
  })

  it('filters to a genre substring match', async () => {
    await seedAlbum({
      artistName: 'Ambient Artist',
      artistMbid: randomUUID(),
      genres: ['dark ambient'],
      albumTitle: 'Drones',
      releaseYear: 2010,
      primaryType: 'Album',
    })
    await seedAlbum({
      artistName: 'Pop Artist',
      artistMbid: randomUUID(),
      genres: ['pop'],
      albumTitle: 'Hits',
      releaseYear: 2010,
      primaryType: 'Album',
    })

    const result = await filterLibraryAlbums(db, { userId, genre: 'ambient' })
    expect(result).toHaveLength(1)
    expect(result[0]?.artistName).toBe('Ambient Artist')
  })

  it('excludes albums outside the default Album/EP type filter', async () => {
    await seedAlbum({
      artistName: 'Singles Artist',
      artistMbid: randomUUID(),
      genres: ['pop'],
      albumTitle: 'One Hit',
      releaseYear: 2010,
      primaryType: 'Single',
    })
    await seedAlbum({
      artistName: 'Album Artist',
      artistMbid: randomUUID(),
      genres: ['pop'],
      albumTitle: 'Full Length',
      releaseYear: 2010,
      primaryType: 'Album',
    })

    const result = await filterLibraryAlbums(db, { userId })
    expect(result).toHaveLength(1)
    expect(result[0]?.artistName).toBe('Album Artist')
  })

  it('scopes results to the given user', async () => {
    await seedAlbum({
      artistName: 'My Artist',
      artistMbid: randomUUID(),
      genres: ['pop'],
      albumTitle: 'My Album',
      releaseYear: 2010,
      primaryType: 'Album',
    })

    const result = await filterLibraryAlbums(db, { userId: userId + 999 })
    expect(result).toHaveLength(0)
  })
})
