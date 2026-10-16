import type { DiscoveredArtist, ScoredArtist } from '@/core/types'
import type { GenreFeedback } from './score'

// Minimal database interface - only what store() needs
export interface StoreDb {
  getExistingRecommendationMbids: (userId?: number) => Promise<Set<string>>
  getExistingAlbumReleaseGroupMbids?: (userId?: number) => Promise<Set<string>>
  getBlockedAlbumKeys?: (userId: number) => Promise<Set<string>>
  getArtistGenreCacheByMbids?: import('./genre-backfill').GenreBackfillDb['getArtistGenreCacheByMbids']
  getArtistGenreCacheByAliases?: import('./genre-backfill').GenreBackfillDb['getArtistGenreCacheByAliases']
  upsertArtistGenres?: import('./genre-backfill').GenreBackfillDb['upsertArtistGenres']
  upsertArtistGenreAlias?: import('./genre-backfill').GenreBackfillDb['upsertArtistGenreAlias']

  insertBatch: (data: { status: string; stats: Record<string, unknown> }) => Promise<{ id: number }>

  completeBatch: (
    id: number,
    stats: { discovered: number; added: number; failed: number },
  ) => Promise<void>

  failBatch: (id: number) => Promise<void>

  upsertArtist: (data: {
    mbid: string
    name: string
    disambiguation?: string
    tags: string[]
    genres: string[]
    imageUrl?: string
    logoUrl?: string
    imageFailed?: boolean
    streamingUrls: Record<string, string>
    beginYear?: number
    endYear?: number
  }) => Promise<{ id: number }>

  insertRecommendation: (data: {
    artistId: number
    batchId: number
    score: number
    sources: Record<string, number>
    aiReasoning?: string
    status: string
    userId?: number
    recommendedReleaseGroupId?: string
    recommendedReleaseGroupTitle?: string
    kind?: 'artist' | 'album'
  }) => Promise<void>

  getRejectedMbids: (cooldownDays: number) => Promise<Set<string>>

  getBlockedMbids: (userId: number) => Promise<Set<string>>

  getFeedbackHistory: (userId?: number) => Promise<Map<string, GenreFeedback>>

  lookupArtistMetadata?: (name: string) => Promise<{
    spotifyGenres: string[] | null
    spotifyPopularity: number | null
  } | null>

  getPopularityMap?: () => Promise<Map<string, number>>

  getLibraryArtistsForUser?: (
    userId: number,
    options?: { onlyReconciled?: boolean; source?: string },
  ) => Promise<
    Array<{
      mbid: string | null
      name: string
      source: string
      sourceArtistId: string
      genres: string[] | null
      matchMethod: string | null
      matchConfidence: number | null
    }>
  >

  userHasOwnSyncState?: (userId: number) => Promise<boolean>

  // Track-based discovery's lowest-confidence signal (see
  // core/pipeline/track-taste.ts) -- this user's own past album/artist
  // requests, most recent first. Optional: orchestrator.ts falls back to
  // liked-tracks + recent-plays only when a StoreDb implementation (or test
  // mock) doesn't provide it.
  getRequestHistoryForUser?: (
    userId: number,
    limit: number,
  ) => Promise<Array<{ artistName: string; albumTitle?: string; createdAt: Date }>>

  // Push-based recent-play cache from Plex's own webhook feature (see
  // db/queries/plex-scrobbles.ts, server/routes/webhooks.ts) -- preferred
  // over polling Plex's getRecentListening() when it has entries. Optional:
  // orchestrator.ts falls back to polling alone when a StoreDb implementation
  // (or test mock) doesn't provide it.
  getRecentPlexScrobbles?: (
    userId: number,
    limit: number,
  ) => Promise<Array<{ artistName: string; trackName: string; playedAt: Date }>>

  // Gap-fill: studio albums missing from artists already in the user's
  // library (owned artist, unowned album). Rotates through the library a
  // bounded number of artists per call (mirrors the standalone "Library
  // Gap-Fill" discovery mode) so this is safe to call on every pipeline run.
  // Optional: orchestrator.ts skips this branch entirely when a StoreDb
  // implementation (or test mock) doesn't provide it.
  getGapFillCandidates?: (userId: number, maxArtists: number) => Promise<DiscoveredArtist[]>

  // Optional atomic variant: wraps upsertArtist + insertRecommendation in a
  // single DB transaction so a crash between the two cannot leave an artist
  // row without a matching recommendation. Prod wiring provides this; test
  // mocks keep the two separate methods.
  upsertArtistAndRecommendation?: (
    artist: Parameters<StoreDb['upsertArtist']>[0],
    rec: Omit<Parameters<StoreDb['insertRecommendation']>[0], 'artistId'>,
  ) => Promise<void>

  tryConsumeRateLimit?: (
    key: string,
    config: { capacity: number; refillPerMs: number },
  ) => Promise<boolean>
}

export type StoreOptions = {
  userId?: number
}

export async function store(
  artists: ScoredArtist[],
  db: StoreDb,
  options: StoreOptions = {},
): Promise<number> {
  const batch = await db.insertBatch({
    status: 'running',
    stats: {
      total: artists.length,
      createdAt: new Date().toISOString(),
    },
  })

  let added = 0
  let failed = 0

  try {
    for (const artist of artists) {
      const artistData = {
        mbid: artist.mbid,
        name: artist.name,
        disambiguation: artist.disambiguation,
        tags: artist.tags,
        genres: artist.genres,
        imageUrl: artist.imageUrl,
        logoUrl: artist.logoUrl,
        imageFailed: artist.imageFailed,
        streamingUrls: artist.streamingUrls,
        beginYear: artist.beginYear,
        endYear: artist.endYear,
      }
      const recData = {
        batchId: batch.id,
        score: artist.score,
        sources: artist.sourceScores,
        aiReasoning: artist.aiReasoning,
        status: 'pending',
        userId: options.userId,
        recommendedReleaseGroupId: artist.suggestedAlbum?.releaseGroupId,
        recommendedReleaseGroupTitle: artist.suggestedAlbum?.title,
        kind: artist.kind ?? 'artist',
      }

      try {
        if (db.upsertArtistAndRecommendation) {
          await db.upsertArtistAndRecommendation(artistData, recData)
        } else {
          const upserted = await db.upsertArtist(artistData)
          await db.insertRecommendation({ ...recData, artistId: upserted.id })
        }
        added++
      } catch (err: unknown) {
        failed++
        console.error(`Failed to store artist ${artist.mbid}:`, err)
      }
    }

    await db.completeBatch(batch.id, {
      discovered: artists.length,
      added,
      failed,
    })

    return batch.id
  } catch (err) {
    // A throw here (e.g. completeBatch hitting a DB error) would otherwise
    // strand the batch in 'running' forever. Transition it to 'failed' before
    // re-raising so the admin jobs view and stuck-detector see the truth.
    await db.failBatch(batch.id)
    throw err
  }
}
