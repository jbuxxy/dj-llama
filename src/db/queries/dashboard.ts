import { and, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import type { GenreCoverage } from '@/core/types'
import type { Database } from '@/db'
import {
  artists,
  jobRuns,
  playlists,
  recommendationBatches,
  recommendations,
  requests,
  users,
} from '@/db/schema'

export type TasteGenre = {
  genre: string
  count: number
  percentage: number
}

/**
 * Case-insensitive genre lookup for a batch of artist names -- used to map
 * track-taste signals (which only carry a plain artist name, not an id) back
 * to genre tags for the "Your Taste" dashboard widget. Names with no
 * matching artist row (or no genres cached yet) are simply absent from the
 * returned map.
 */
export async function getArtistGenresByNames(
  db: Database,
  names: string[],
): Promise<Map<string, string[]>> {
  const normalized = [...new Set(names.map((n) => n.trim().toLowerCase()).filter(Boolean))]
  if (normalized.length === 0) return new Map()

  const rows = await db
    .select({ name: artists.name, genres: artists.genres })
    .from(artists)
    .where(and(isNotNull(artists.genres), inArray(sql`lower(${artists.name})`, normalized)))

  const map = new Map<string, string[]>()
  for (const row of rows) {
    if (row.genres && row.genres.length > 0) map.set(row.name.trim().toLowerCase(), row.genres)
  }
  return map
}

function parseGenreCoverage(value: unknown): GenreCoverage | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<Record<keyof GenreCoverage, unknown>>
  if (
    !Number.isInteger(candidate.coveredArtists) ||
    !Number.isInteger(candidate.pendingArtists) ||
    !Number.isInteger(candidate.totalArtists)
  ) {
    return null
  }
  const coverage = candidate as GenreCoverage
  if (
    coverage.coveredArtists < 0 ||
    coverage.pendingArtists < 0 ||
    coverage.totalArtists < 0 ||
    coverage.coveredArtists > coverage.totalArtists ||
    coverage.pendingArtists > coverage.totalArtists
  ) {
    return null
  }
  return coverage
}

export async function getLatestGenreCoverage(
  db: Database,
  userId: number | undefined,
): Promise<GenreCoverage | null> {
  const conditions = [eq(jobRuns.type, 'pipeline'), eq(jobRuns.status, 'completed')]
  if (userId !== undefined) conditions.push(eq(jobRuns.userId, userId))

  const [row] = await db
    .select({ metadata: jobRuns.metadata })
    .from(jobRuns)
    .where(and(...conditions))
    .orderBy(desc(jobRuns.startedAt))
    .limit(1)

  return parseGenreCoverage(row?.metadata.genreCoverage)
}

export type ActivityEntry = {
  type: 'approved' | 'rejected' | 'scan_completed' | 'auto_request_added'
  timestamp: string
  data: {
    artistName?: string
    albumTitle?: string
    discovered?: number
    added?: number
    username?: string
    playlistName?: string
  }
}

export async function getRecentActivity(
  db: Database,
  userId: number | undefined,
  isAdmin: boolean,
  limit = 5,
): Promise<ActivityEntry[]> {
  const entries: ActivityEntry[] = []

  // 1. Recent recommendation actions
  const recWhere =
    userId && !isAdmin
      ? and(isNotNull(recommendations.actedOnAt), eq(recommendations.userId, userId))
      : isNotNull(recommendations.actedOnAt)

  const recentRecs = await db
    .select({
      status: recommendations.status,
      actedOnAt: recommendations.actedOnAt,
      artistName: artists.name,
      userId: recommendations.userId,
    })
    .from(recommendations)
    .innerJoin(artists, eq(recommendations.artistId, artists.id))
    .where(recWhere)
    .orderBy(desc(recommendations.actedOnAt))
    .limit(10)

  let userMap = new Map<number, string>()
  if (isAdmin && recentRecs.length > 0) {
    const userIds = [...new Set(recentRecs.map((r) => r.userId).filter(Boolean))] as number[]
    if (userIds.length > 0) {
      const userRows = await db
        .select({ id: users.id, username: users.username })
        .from(users)
        .where(inArray(users.id, userIds))
      userMap = new Map(userRows.map((u) => [u.id, u.username]))
    }
  }

  for (const rec of recentRecs) {
    const status = rec.status === 'rejected' ? ('rejected' as const) : ('approved' as const)
    entries.push({
      type: status,
      timestamp: rec.actedOnAt?.toISOString() ?? '',
      data: {
        artistName: rec.artistName,
        username: isAdmin && rec.userId ? userMap.get(rec.userId) : undefined,
      },
    })
  }

  // 2. Recent batches (scan events) - admin sees all
  if (isAdmin) {
    const recentBatches = await db
      .select({
        createdAt: recommendationBatches.createdAt,
        stats: recommendationBatches.stats,
      })
      .from(recommendationBatches)
      .orderBy(desc(recommendationBatches.createdAt))
      .limit(5)

    for (const batch of recentBatches) {
      const stats = batch.stats as { discovered?: number; added?: number } | null
      entries.push({
        type: 'scan_completed',
        timestamp: batch.createdAt.toISOString(),
        data: {
          discovered: stats?.discovered ?? 0,
          added: stats?.added ?? 0,
        },
      })
    }
  }

  // 4. Recent playlist-import auto-approved requests. These never go through
  // an admin/user decision -- see index.ts's autoRequestMissingPlaylistTracks,
  // which calls resolveRequest() without a decidedByUserId. Every other path
  // that resolves a request (manual submit, retry, admin approve/reject)
  // always stamps a real deciding user, so `decidedByUserId IS NULL` is what
  // distinguishes "playlist import added this automatically" from a request
  // someone actually acted on.
  const reqWhere =
    userId && !isAdmin
      ? and(
          eq(requests.status, 'dispatched'),
          isNull(requests.decidedByUserId),
          eq(requests.requestedByUserId, userId),
        )
      : and(eq(requests.status, 'dispatched'), isNull(requests.decidedByUserId))

  const recentAutoRequests = await db
    .select({
      artistName: requests.artistName,
      albumTitle: requests.albumTitle,
      decidedAt: requests.decidedAt,
      createdAt: requests.createdAt,
      requestedByUserId: requests.requestedByUserId,
      playlistName: playlists.name,
    })
    .from(requests)
    .leftJoin(playlists, eq(playlists.id, requests.sourcePlaylistId))
    .where(reqWhere)
    .orderBy(desc(requests.decidedAt))
    .limit(10)

  let requestUserMap = new Map<number, string>()
  if (isAdmin && recentAutoRequests.length > 0) {
    const userIds = [...new Set(recentAutoRequests.map((r) => r.requestedByUserId))]
    const userRows = await db
      .select({ id: users.id, username: users.username })
      .from(users)
      .where(inArray(users.id, userIds))
    requestUserMap = new Map(userRows.map((u) => [u.id, u.username]))
  }

  for (const req of recentAutoRequests) {
    entries.push({
      type: 'auto_request_added',
      timestamp: (req.decidedAt ?? req.createdAt).toISOString(),
      data: {
        artistName: req.artistName,
        albumTitle: req.albumTitle ?? undefined,
        playlistName: req.playlistName ?? undefined,
        username: isAdmin ? requestUserMap.get(req.requestedByUserId) : undefined,
      },
    })
  }

  entries.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
  return entries.slice(0, limit)
}
