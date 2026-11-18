import { and, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm'
import type { Database } from '@/db'
import { listeningEvents } from '@/db/schema'

export type ListeningEventInput = {
  userId: number
  ratingKey?: string | null
  artistName: string
  trackName: string
  albumName?: string | null
  durationMs?: number | null
  listenedMs?: number | null
  completed: boolean
  skipped: boolean
  source: 'webhook' | 'history'
  playedAt: Date
}

export async function recordListeningEvent(db: Database, data: ListeningEventInput): Promise<void> {
  await db.insert(listeningEvents).values(data).onConflictDoNothing()
}

export async function recordListeningEvents(
  db: Database,
  rows: ListeningEventInput[],
): Promise<number> {
  if (rows.length === 0) return 0
  const inserted = await db
    .insert(listeningEvents)
    .values(rows)
    .onConflictDoNothing()
    .returning({ id: listeningEvents.id })
  return inserted.length
}

export type RecentPlayRow = { artistName: string; trackName: string; playedAt: Date }

/** Most recent completed plays (skips and early stops excluded). */
export async function getRecentPlays(
  db: Database,
  userId: number,
  limit = 100,
): Promise<RecentPlayRow[]> {
  return db
    .select({
      artistName: listeningEvents.artistName,
      trackName: listeningEvents.trackName,
      playedAt: listeningEvents.playedAt,
    })
    .from(listeningEvents)
    .where(and(eq(listeningEvents.userId, userId), eq(listeningEvents.completed, true)))
    .orderBy(desc(listeningEvents.playedAt))
    .limit(limit)
}

/** Newest playedAt for a user (optionally from one source), or null when there's none. */
export async function getLatestPlayedAt(
  db: Database,
  userId: number,
  source?: 'webhook' | 'history',
): Promise<Date | null> {
  const [row] = await db
    .select({ at: sql<Date | null>`max(${listeningEvents.playedAt})` })
    .from(listeningEvents)
    .where(
      source
        ? and(eq(listeningEvents.userId, userId), eq(listeningEvents.source, source))
        : eq(listeningEvents.userId, userId),
    )
  return row?.at ? new Date(row.at) : null
}

/** (ratingKey, playedAt) pairs in a window -- used to skip history rows a webhook already recorded. */
export async function getPlaysInWindow(
  db: Database,
  userId: number,
  from: Date,
  to: Date,
): Promise<Array<{ ratingKey: string | null; playedAt: Date }>> {
  return db
    .select({ ratingKey: listeningEvents.ratingKey, playedAt: listeningEvents.playedAt })
    .from(listeningEvents)
    .where(
      and(
        eq(listeningEvents.userId, userId),
        gte(listeningEvents.playedAt, from),
        lt(listeningEvents.playedAt, to),
      ),
    )
}

export type TrackSkipStats = { plays: number; skips: number }

/** Per-track play/skip counts since `since`, for the given Plex ratingKeys. */
export async function getTrackSkipStats(
  db: Database,
  userId: number,
  ratingKeys: string[],
  since: Date,
): Promise<Map<string, TrackSkipStats>> {
  const out = new Map<string, TrackSkipStats>()
  if (ratingKeys.length === 0) return out
  const rows = await db
    .select({
      ratingKey: listeningEvents.ratingKey,
      plays: sql<number>`count(*)::int`,
      skips: sql<number>`count(*) filter (where ${listeningEvents.skipped})::int`,
    })
    .from(listeningEvents)
    .where(
      and(
        eq(listeningEvents.userId, userId),
        inArray(listeningEvents.ratingKey, ratingKeys),
        gte(listeningEvents.playedAt, since),
      ),
    )
    .groupBy(listeningEvents.ratingKey)
  for (const r of rows) if (r.ratingKey) out.set(r.ratingKey, { plays: r.plays, skips: r.skips })
  return out
}

export async function pruneListeningEvents(db: Database, olderThan: Date): Promise<number> {
  const removed = await db
    .delete(listeningEvents)
    .where(lt(listeningEvents.playedAt, olderThan))
    .returning({ id: listeningEvents.id })
  return removed.length
}

/** Distinct Plex ratingKeys this user completed recently, most recent first. */
export async function getRecentlyPlayedRatingKeys(
  db: Database,
  userId: number,
  limit: number,
): Promise<string[]> {
  const rows = await db
    .select({
      ratingKey: listeningEvents.ratingKey,
      last: sql<Date>`max(${listeningEvents.playedAt})`,
    })
    .from(listeningEvents)
    .where(
      and(
        eq(listeningEvents.userId, userId),
        eq(listeningEvents.completed, true),
        sql`${listeningEvents.ratingKey} is not null`,
      ),
    )
    .groupBy(listeningEvents.ratingKey)
    .orderBy(sql`2 desc`)
    .limit(limit)
  return rows.map((r) => r.ratingKey as string)
}
