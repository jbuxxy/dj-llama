import { and, desc, eq, notInArray } from 'drizzle-orm'
import type { Database } from '@/db'
import { plexScrobbles } from '@/db/schema'

// Bounded per user so an always-on webhook never grows this table
// unboundedly -- this is meant to be a rolling "recent plays" window, not a
// full listening-history archive.
const PLEX_SCROBBLE_CAP = 500

export async function recordPlexScrobble(
  db: Database,
  data: { userId: number; artistName: string; trackName: string; playedAt: Date },
): Promise<void> {
  await db.insert(plexScrobbles).values(data)

  // Prune anything past the cap for this user, oldest first.
  const keepIds = await db
    .select({ id: plexScrobbles.id })
    .from(plexScrobbles)
    .where(eq(plexScrobbles.userId, data.userId))
    .orderBy(desc(plexScrobbles.playedAt))
    .limit(PLEX_SCROBBLE_CAP)
  const keepIdList = keepIds.map((r) => r.id)
  if (keepIdList.length === 0) return
  await db
    .delete(plexScrobbles)
    .where(and(eq(plexScrobbles.userId, data.userId), notInArray(plexScrobbles.id, keepIdList)))
}

export type PlexScrobbleEntry = { artistName: string; trackName: string; playedAt: Date }

export async function getRecentPlexScrobbles(
  db: Database,
  userId: number,
  limit = 100,
): Promise<PlexScrobbleEntry[]> {
  const rows = await db
    .select({
      artistName: plexScrobbles.artistName,
      trackName: plexScrobbles.trackName,
      playedAt: plexScrobbles.playedAt,
    })
    .from(plexScrobbles)
    .where(eq(plexScrobbles.userId, userId))
    .orderBy(desc(plexScrobbles.playedAt))
    .limit(limit)
  return rows
}
