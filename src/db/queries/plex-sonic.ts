import { inArray, sql } from 'drizzle-orm'
import type { Database } from '@/db'
import { plexTrackSonic } from '@/db/schema'

export type StoredPlexSonic = typeof plexTrackSonic.$inferSelect

export async function getPlexSonic(
  db: Database,
  ratingKeys: string[],
): Promise<Map<string, StoredPlexSonic>> {
  if (ratingKeys.length === 0) return new Map()
  const rows = await db
    .select()
    .from(plexTrackSonic)
    .where(inArray(plexTrackSonic.ratingKey, ratingKeys))
  return new Map(rows.map((r) => [r.ratingKey, r]))
}

export async function savePlexSonic(
  db: Database,
  rows: Array<Omit<StoredPlexSonic, 'fetchedAt'>>,
): Promise<void> {
  if (rows.length === 0) return
  await db
    .insert(plexTrackSonic)
    .values(rows.map((r) => ({ ...r, fetchedAt: new Date() })))
    .onConflictDoUpdate({
      target: plexTrackSonic.ratingKey,
      set: {
        loudness: sql`excluded.loudness`,
        lra: sql`excluded.lra`,
        introSec: sql`excluded.intro_sec`,
        outroSec: sql`excluded.outro_sec`,
        moods: sql`excluded.moods`,
        sonicAnalyzed: sql`excluded.sonic_analyzed`,
        fetchedAt: sql`excluded.fetched_at`,
      },
    })
}
