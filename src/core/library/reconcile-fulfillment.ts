import { and, eq, inArray, isNull, or } from 'drizzle-orm'
import type { Database } from '@/db'
import { rejectRecommendation } from '@/db/queries/recommendations'
import { artists, libraryAlbums, libraryArtists, recommendations, requests } from '@/db/schema'

export type FulfillmentReconciliationResult = {
  confirmedRequestIds: number[]
  confirmedRecommendationIds: number[]
  autoRejectedRecommendationIds: number[]
}

/**
 * Checks this user's pending/dispatched requests and added_to_lidarr
 * recommendations against library_artists/library_albums (already kept in
 * sync by the periodic/webhook-triggered library sync) and stamps
 * libraryConfirmedAt the moment a matching mbid shows up. Distinct from
 * `status`, which only ever reflected "Lidarr accepted the add" -- this is
 * "we asked for it, and it's actually here now," layered on top rather than
 * replacing the original status.
 *
 * Also auto-rejects still-*pending* recommendations that turn out to already
 * be owned (e.g. generated before this user's library synced, or the album
 * was added through some other path since) -- otherwise they sit in Discover
 * suggesting something the user already has, forever, since nothing else
 * ever re-checks a pending rec against the library after it's created.
 */
export async function reconcileFulfillment(
  db: Database,
  userId: number,
): Promise<FulfillmentReconciliationResult> {
  // library_artists/library_albums has userId=null rows for Lidarr (one
  // global instance for the whole install, not per-user) and a non-null
  // userId for Plex (per-user library scan) -- a request is fulfilled the
  // moment Lidarr has actually downloaded it, which can well precede Plex
  // ever rescanning and picking up the same mbid itself. Matching only this
  // user's own rows meant a Lidarr-confirmed download could never surface
  // here at all.
  const [ownedArtists, ownedAlbums] = await Promise.all([
    db
      .select({ mbid: libraryArtists.mbid })
      .from(libraryArtists)
      .where(or(eq(libraryArtists.userId, userId), isNull(libraryArtists.userId))),
    db
      .select({ mbid: libraryAlbums.albumMbid })
      .from(libraryAlbums)
      .where(or(eq(libraryAlbums.userId, userId), isNull(libraryAlbums.userId))),
  ])
  const artistMbids = new Set(ownedArtists.map((r) => r.mbid).filter((m): m is string => !!m))
  const albumMbids = new Set(ownedAlbums.map((r) => r.mbid).filter((m): m is string => !!m))

  if (artistMbids.size === 0 && albumMbids.size === 0) {
    return {
      confirmedRequestIds: [],
      confirmedRecommendationIds: [],
      autoRejectedRecommendationIds: [],
    }
  }

  // Includes 'failed', not just 'dispatched'/'pending': Lidarr's own add
  // flow does a synchronous, sequential full-catalog metadata + cover-art
  // refresh per artist before it responds to anything else (confirmed live
  // -- a burst of approvals left Lidarr's own /api/v1/artist unresponsive
  // for minutes while it churned through refreshes), which routinely
  // outlasts this app's client-side timeout. The add call gets aborted and
  // recorded as 'failed' while Lidarr keeps working in the background and
  // completes it anyway moments later -- without 'failed' here, a request
  // that actually succeeded stays mislabeled "failed" forever, since
  // nothing else ever re-checks a failed request against the library.
  const pendingRequests = await db
    .select()
    .from(requests)
    .where(
      and(
        eq(requests.requestedByUserId, userId),
        or(
          eq(requests.status, 'dispatched'),
          eq(requests.status, 'pending'),
          eq(requests.status, 'failed'),
          // A rejected request whose album turned up anyway (someone else
          // requested it, or it was added by hand) is still in the library --
          // it belongs under Added to Library like any other. Its status
          // stays 'rejected'; only libraryConfirmedAt is set.
          eq(requests.status, 'rejected'),
        ),
        isNull(requests.libraryConfirmedAt),
      ),
    )

  const confirmed = pendingRequests.filter((r) =>
    r.kind === 'album'
      ? r.releaseGroupMbid != null && albumMbids.has(r.releaseGroupMbid)
      : artistMbids.has(r.artistMbid),
  )
  const confirmedRequestIds = confirmed.map((r) => r.id)

  if (confirmedRequestIds.length > 0) {
    await db
      .update(requests)
      .set({ libraryConfirmedAt: new Date() })
      .where(inArray(requests.id, confirmedRequestIds))
  }

  // A 'failed' request that turns out to already be in the library didn't
  // actually fail -- Lidarr just finished after this app's client gave up.
  // Correct the status too, not just libraryConfirmedAt, so it stops
  // showing as a failure (with a stale error message and a "Retry" button
  // that would only re-do already-finished work) once it's confirmed done.
  const misreportedFailedIds = confirmed.filter((r) => r.status === 'failed').map((r) => r.id)
  if (misreportedFailedIds.length > 0) {
    await db
      .update(requests)
      .set({ status: 'dispatched' })
      .where(inArray(requests.id, misreportedFailedIds))
  }

  const pendingRecs = await db
    .select({
      id: recommendations.id,
      artistMbid: artists.mbid,
      recommendedReleaseGroupId: recommendations.recommendedReleaseGroupId,
    })
    .from(recommendations)
    .innerJoin(artists, eq(recommendations.artistId, artists.id))
    .where(
      and(
        eq(recommendations.userId, userId),
        eq(recommendations.status, 'added_to_lidarr'),
        isNull(recommendations.libraryConfirmedAt),
      ),
    )

  const confirmedRecommendationIds = pendingRecs
    .filter((r) =>
      r.recommendedReleaseGroupId
        ? albumMbids.has(r.recommendedReleaseGroupId)
        : artistMbids.has(r.artistMbid),
    )
    .map((r) => r.id)

  if (confirmedRecommendationIds.length > 0) {
    await db
      .update(recommendations)
      .set({ libraryConfirmedAt: new Date() })
      .where(inArray(recommendations.id, confirmedRecommendationIds))
  }

  const stillPendingRecs = await db
    .select({
      id: recommendations.id,
      artistMbid: artists.mbid,
      recommendedReleaseGroupId: recommendations.recommendedReleaseGroupId,
    })
    .from(recommendations)
    .innerJoin(artists, eq(recommendations.artistId, artists.id))
    .where(and(eq(recommendations.userId, userId), eq(recommendations.status, 'pending')))

  const autoRejectIds = stillPendingRecs
    .filter((r) =>
      r.recommendedReleaseGroupId
        ? albumMbids.has(r.recommendedReleaseGroupId)
        : artistMbids.has(r.artistMbid),
    )
    .map((r) => r.id)

  const autoRejectedRecommendationIds: number[] = []
  for (const recommendationId of autoRejectIds) {
    const rejected = await rejectRecommendation(db, {
      recommendationId,
      userId,
      reason: 'already_own',
      reasonText: null,
      permanent: false,
    })
    if (rejected !== null) autoRejectedRecommendationIds.push(recommendationId)
  }

  return { confirmedRequestIds, confirmedRecommendationIds, autoRejectedRecommendationIds }
}
