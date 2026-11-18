import { and, eq, gte, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm'
import type { Database } from '@/db'
import { notifyUsers } from '@/db/queries/change-events'
import {
  artists,
  type LearnedWeights,
  listeningEvents,
  type RecommendationOutcome,
  recommendations,
  users,
} from '@/db/schema'

export type OutcomeCandidate = {
  id: number
  kind: string
  artistName: string
  albumTitle: string | null
  confirmedAt: Date
}

/** Library-confirmed recommendations whose outcome isn't final yet. */
export async function listOutcomeCandidates(
  db: Database,
  userId: number,
): Promise<OutcomeCandidate[]> {
  const rows = await db
    .select({
      id: recommendations.id,
      kind: recommendations.kind,
      artistName: artists.name,
      albumTitle: recommendations.recommendedReleaseGroupTitle,
      confirmedAt: recommendations.libraryConfirmedAt,
    })
    .from(recommendations)
    .innerJoin(artists, eq(artists.id, recommendations.artistId))
    .where(
      and(
        eq(recommendations.userId, userId),
        isNotNull(recommendations.libraryConfirmedAt),
        isNull(recommendations.outcome),
      ),
    )
  return rows.map((r) => ({ ...r, confirmedAt: r.confirmedAt as Date }))
}

export type PlayForOutcome = {
  artistName: string
  albumName: string | null
  completed: boolean
  skipped: boolean
  playedAt: Date
}

export async function listPlaysSince(
  db: Database,
  userId: number,
  since: Date,
): Promise<PlayForOutcome[]> {
  return db
    .select({
      artistName: listeningEvents.artistName,
      albumName: listeningEvents.albumName,
      completed: listeningEvents.completed,
      skipped: listeningEvents.skipped,
      playedAt: listeningEvents.playedAt,
    })
    .from(listeningEvents)
    .where(and(eq(listeningEvents.userId, userId), gte(listeningEvents.playedAt, since)))
}

export type OutcomeUpdate = {
  id: number
  outcome: RecommendationOutcome
  plays: number
  skipRate: number | null
}

export async function setOutcomes(
  db: Database,
  userId: number,
  updates: OutcomeUpdate[],
): Promise<void> {
  if (updates.length === 0) return
  const now = new Date()
  await db.transaction(async (tx) => {
    for (const u of updates) {
      await tx
        .update(recommendations)
        .set({
          outcome: u.outcome,
          outcomePlays: u.plays,
          outcomeSkipRate: u.skipRate,
          outcomeAt: now,
        })
        .where(eq(recommendations.id, u.id))
    }
  })
  notifyUsers([userId], { type: 'activity-updated' })
}

// Rejections that say "this was a bad pick" -- training negatives alongside
// approvals that were never played. 'not_right_now' and 'already_own' say
// nothing about the scoring, so they're left out.
const NEGATIVE_REJECTIONS = ['tried_didnt_like', 'wrong_style', 'not_interested']

export type TrainingRow = {
  sources: Record<string, number> | null
  outcome: RecommendationOutcome | null
  status: string
}

export async function listTrainingRows(db: Database, userId: number): Promise<TrainingRow[]> {
  return db
    .select({
      sources: recommendations.sources,
      outcome: recommendations.outcome,
      status: recommendations.status,
    })
    .from(recommendations)
    .where(
      and(
        eq(recommendations.userId, userId),
        isNotNull(recommendations.sources),
        or(
          isNotNull(recommendations.outcome),
          and(
            eq(recommendations.status, 'rejected'),
            inArray(recommendations.rejectionReason, NEGATIVE_REJECTIONS),
          ),
        ),
      ),
    )
}

export async function setLearnedWeights(
  db: Database,
  userId: number,
  learned: LearnedWeights | null,
): Promise<void> {
  await db.update(users).set({ learnedWeights: learned }).where(eq(users.id, userId))
}

export async function getLearnedWeights(
  db: Database,
  userId: number,
): Promise<LearnedWeights | null> {
  const [row] = await db
    .select({ learned: users.learnedWeights })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  return row?.learned ?? null
}

export type OutcomeSummary = {
  keepers: number
  tried: number
  unplayed: number
  /** Confirmed in the library, still inside the listening window. */
  pending: number
}

export async function getOutcomeSummary(db: Database, userId: number): Promise<OutcomeSummary> {
  const [row] = await db
    .select({
      keepers: sql<number>`count(*) filter (where ${recommendations.outcome} = 'keeper')::int`,
      tried: sql<number>`count(*) filter (where ${recommendations.outcome} = 'tried')::int`,
      unplayed: sql<number>`count(*) filter (where ${recommendations.outcome} = 'unplayed')::int`,
      pending: sql<number>`count(*) filter (where ${recommendations.outcome} is null)::int`,
    })
    .from(recommendations)
    .where(and(eq(recommendations.userId, userId), isNotNull(recommendations.libraryConfirmedAt)))
  return row ?? { keepers: 0, tried: 0, unplayed: 0, pending: 0 }
}

export type OutcomeListItem = {
  id: number
  artistId: number
  artistName: string
  artistMbid: string
  imageUrl: string | null
  albumTitle: string | null
  kind: string
  plays: number
  outcomeAt: Date | null
}

export async function listByOutcome(
  db: Database,
  userId: number,
  outcome: RecommendationOutcome,
  limit = 12,
): Promise<OutcomeListItem[]> {
  const rows = await db
    .select({
      id: recommendations.id,
      artistId: artists.id,
      artistName: artists.name,
      artistMbid: artists.mbid,
      imageUrl: artists.imageUrl,
      albumTitle: recommendations.recommendedReleaseGroupTitle,
      kind: recommendations.kind,
      plays: recommendations.outcomePlays,
      outcomeAt: recommendations.outcomeAt,
    })
    .from(recommendations)
    .innerJoin(artists, eq(artists.id, recommendations.artistId))
    .where(and(eq(recommendations.userId, userId), eq(recommendations.outcome, outcome)))
    .orderBy(sql`${recommendations.outcomeAt} desc nulls last`)
    .limit(limit)
  return rows.map((r) => ({ ...r, plays: r.plays ?? 0 }))
}
