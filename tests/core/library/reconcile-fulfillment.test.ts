// @vitest-environment node

import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { reconcileFulfillment } from '@/core/library/reconcile-fulfillment'

const TEST_USER = { username: 'reconcile-fulfillment-test-user', passwordHash: 'x' }
const SOURCE = 'reconcile-fulfillment-test'
const ARTIST_MBID = '11111111-1111-1111-1111-111111111111'
const ALBUM_MBID = '22222222-2222-2222-2222-222222222222'
const SHOULD_RUN =
  process.env.DATABASE_URL !== undefined ||
  (process.env.DB_HOST !== undefined &&
    process.env.DB_USER !== undefined &&
    process.env.DB_NAME !== undefined)

let db: import('@/db').Database
let artists: typeof import('@/db/schema').artists
let libraryAlbums: typeof import('@/db/schema').libraryAlbums
let libraryArtists: typeof import('@/db/schema').libraryArtists
let recommendationBatches: typeof import('@/db/schema').recommendationBatches
let recommendations: typeof import('@/db/schema').recommendations
let requests: typeof import('@/db/schema').requests
let users: typeof import('@/db/schema').users

if (SHOULD_RUN) {
  ;({ db } = await import('@/db'))
  ;({
    artists,
    libraryAlbums,
    libraryArtists,
    recommendationBatches,
    recommendations,
    requests,
    users,
  } = await import('@/db/schema'))
}

let userId: number

async function deleteTestUser(id: number): Promise<void> {
  await db.delete(requests).where(eq(requests.requestedByUserId, id))
  await db.delete(users).where(eq(users.id, id))
}

beforeEach(async () => {
  await db.delete(libraryAlbums).where(eq(libraryAlbums.source, SOURCE))
  await db.delete(libraryArtists).where(eq(libraryArtists.source, SOURCE))
  await db.delete(artists).where(eq(artists.mbid, ARTIST_MBID))
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, TEST_USER.username))
  if (existing[0]) await deleteTestUser(existing[0].id)
  const inserted = await db.insert(users).values(TEST_USER).returning({ id: users.id })
  if (!inserted[0]) throw new Error('failed to seed user')
  userId = inserted[0].id
})

afterEach(async () => {
  await db.delete(libraryAlbums).where(eq(libraryAlbums.source, SOURCE))
  await db.delete(libraryArtists).where(eq(libraryArtists.source, SOURCE))
  await db.delete(artists).where(eq(artists.mbid, ARTIST_MBID))
  await deleteTestUser(userId)
})

describe.skipIf(!SHOULD_RUN)('reconcileFulfillment', () => {
  it('confirms a request against a Lidarr-global (userId=null) library row', async () => {
    // Lidarr is one global instance for the whole install (userId=null),
    // distinct from Plex's per-user rows -- a request is fulfilled the
    // moment Lidarr has actually downloaded it, which can precede Plex ever
    // rescanning and picking up the same mbid for this specific user.
    await db.insert(libraryAlbums).values({
      userId: null,
      source: SOURCE,
      sourceAlbumId: 'lidarr-album-1',
      sourceArtistId: 'lidarr-artist-1',
      title: 'Test Album',
      titleNormalized: 'test album',
      albumMbid: ALBUM_MBID,
      artistMbid: ARTIST_MBID,
    })

    const [request] = await db
      .insert(requests)
      .values({
        requestedByUserId: userId,
        kind: 'album',
        artistMbid: ARTIST_MBID,
        artistName: 'Test Artist',
        releaseGroupMbid: ALBUM_MBID,
        albumTitle: 'Test Album',
        status: 'dispatched',
      })
      .returning()
    if (!request) throw new Error('failed to seed request')

    const result = await reconcileFulfillment(db, userId)

    expect(result.confirmedRequestIds).toEqual([request.id])
    const [updated] = await db.select().from(requests).where(eq(requests.id, request.id))
    expect(updated?.libraryConfirmedAt).not.toBeNull()
  })

  it('moves a rejected request whose album arrived anyway to Added to Library, keeping its status', async () => {
    await db.insert(libraryAlbums).values({
      userId: null,
      source: SOURCE,
      sourceAlbumId: 'lidarr-album-1',
      sourceArtistId: 'lidarr-artist-1',
      title: 'Test Album',
      titleNormalized: 'test album',
      albumMbid: ALBUM_MBID,
      artistMbid: ARTIST_MBID,
    })

    const [request] = await db
      .insert(requests)
      .values({
        requestedByUserId: userId,
        kind: 'album',
        artistMbid: ARTIST_MBID,
        artistName: 'Test Artist',
        releaseGroupMbid: ALBUM_MBID,
        albumTitle: 'Test Album',
        status: 'rejected',
      })
      .returning()
    if (!request) throw new Error('failed to seed request')

    const result = await reconcileFulfillment(db, userId)

    expect(result.confirmedRequestIds).toEqual([request.id])
    const [updated] = await db.select().from(requests).where(eq(requests.id, request.id))
    expect(updated?.libraryConfirmedAt).not.toBeNull()
    expect(updated?.status).toBe('rejected')
  })

  it('confirms an artist-kind request against a Lidarr-global library_artists row', async () => {
    await db.insert(libraryArtists).values({
      userId: null,
      source: SOURCE,
      sourceArtistId: 'lidarr-artist-2',
      name: 'Test Artist',
      nameNormalized: 'test artist',
      mbid: ARTIST_MBID,
    })

    const [request] = await db
      .insert(requests)
      .values({
        requestedByUserId: userId,
        kind: 'artist',
        artistMbid: ARTIST_MBID,
        artistName: 'Test Artist',
        status: 'dispatched',
      })
      .returning()
    if (!request) throw new Error('failed to seed request')

    const result = await reconcileFulfillment(db, userId)

    expect(result.confirmedRequestIds).toEqual([request.id])
  })

  it('confirms a recommendation against a Lidarr-global library_albums row', async () => {
    const [artist] = await db
      .insert(artists)
      .values({ mbid: ARTIST_MBID, name: 'Test Artist' })
      .returning()
    if (!artist) throw new Error('failed to seed artist')
    const [batch] = await db.insert(recommendationBatches).values({}).returning()
    if (!batch) throw new Error('failed to seed batch')

    await db.insert(libraryAlbums).values({
      userId: null,
      source: SOURCE,
      sourceAlbumId: 'lidarr-album-3',
      sourceArtistId: 'lidarr-artist-3',
      title: 'Test Album',
      titleNormalized: 'test album',
      albumMbid: ALBUM_MBID,
      artistMbid: ARTIST_MBID,
    })

    const [rec] = await db
      .insert(recommendations)
      .values({
        userId,
        artistId: artist.id,
        batchId: batch.id,
        score: 1,
        status: 'added_to_lidarr',
        kind: 'album',
        recommendedReleaseGroupId: ALBUM_MBID,
      })
      .returning()
    if (!rec) throw new Error('failed to seed recommendation')

    const result = await reconcileFulfillment(db, userId)

    expect(result.confirmedRecommendationIds).toEqual([rec.id])

    await db.delete(recommendations).where(eq(recommendations.id, rec.id))
    await db.delete(recommendationBatches).where(eq(recommendationBatches.id, batch.id))
  })

  it('auto-rejects a still-pending recommendation for an album the user already owns', async () => {
    const [artist] = await db
      .insert(artists)
      .values({ mbid: ARTIST_MBID, name: 'Test Artist' })
      .returning()
    if (!artist) throw new Error('failed to seed artist')
    const [batch] = await db.insert(recommendationBatches).values({}).returning()
    if (!batch) throw new Error('failed to seed batch')

    await db.insert(libraryAlbums).values({
      userId: null,
      source: SOURCE,
      sourceAlbumId: 'lidarr-album-4',
      sourceArtistId: 'lidarr-artist-4',
      title: 'Test Album',
      titleNormalized: 'test album',
      albumMbid: ALBUM_MBID,
      artistMbid: ARTIST_MBID,
    })

    const [rec] = await db
      .insert(recommendations)
      .values({
        userId,
        artistId: artist.id,
        batchId: batch.id,
        score: 1,
        status: 'pending',
        kind: 'album',
        recommendedReleaseGroupId: ALBUM_MBID,
      })
      .returning()
    if (!rec) throw new Error('failed to seed recommendation')

    const result = await reconcileFulfillment(db, userId)

    expect(result.autoRejectedRecommendationIds).toEqual([rec.id])
    const [updated] = await db.select().from(recommendations).where(eq(recommendations.id, rec.id))
    expect(updated?.status).toBe('rejected')
    expect(updated?.rejectionReason).toBe('already_own')

    await db.delete(recommendations).where(eq(recommendations.id, rec.id))
    await db.delete(recommendationBatches).where(eq(recommendationBatches.id, batch.id))
  })

  it('leaves a pending recommendation alone when the artist/album is not yet owned', async () => {
    const [artist] = await db
      .insert(artists)
      .values({ mbid: ARTIST_MBID, name: 'Test Artist' })
      .returning()
    if (!artist) throw new Error('failed to seed artist')
    const [batch] = await db.insert(recommendationBatches).values({}).returning()
    if (!batch) throw new Error('failed to seed batch')

    // A different album than the one owned, so it should not be swept up.
    await db.insert(libraryAlbums).values({
      userId: null,
      source: SOURCE,
      sourceAlbumId: 'lidarr-album-5',
      sourceArtistId: 'lidarr-artist-5',
      title: 'Other Album',
      titleNormalized: 'other album',
      albumMbid: '33333333-3333-3333-3333-333333333333',
      artistMbid: '44444444-4444-4444-4444-444444444444',
    })

    const [rec] = await db
      .insert(recommendations)
      .values({
        userId,
        artistId: artist.id,
        batchId: batch.id,
        score: 1,
        status: 'pending',
        kind: 'album',
        recommendedReleaseGroupId: ALBUM_MBID,
      })
      .returning()
    if (!rec) throw new Error('failed to seed recommendation')

    const result = await reconcileFulfillment(db, userId)

    expect(result.autoRejectedRecommendationIds).toEqual([])
    const [updated] = await db.select().from(recommendations).where(eq(recommendations.id, rec.id))
    expect(updated?.status).toBe('pending')

    await db.delete(recommendations).where(eq(recommendations.id, rec.id))
    await db.delete(recommendationBatches).where(eq(recommendationBatches.id, batch.id))
  })
})
