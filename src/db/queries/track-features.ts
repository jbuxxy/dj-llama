import { inArray, sql } from 'drizzle-orm'
import type { AudioFeatures } from '@/core/audio/features'
import type { Database } from '@/db'
import { trackFeatures } from '@/db/schema'

export type StoredTrackFeatures = {
  ratingKey: string
  partKey: string
  bpm: number | null
  camelot: string | null
  keyName: string | null
  energy: number | null
  error: string | null
  analyzedAt: Date
}

export async function getTrackFeatures(
  db: Database,
  ratingKeys: string[],
): Promise<Map<string, StoredTrackFeatures>> {
  if (ratingKeys.length === 0) return new Map()
  const rows = await db
    .select({
      ratingKey: trackFeatures.ratingKey,
      partKey: trackFeatures.partKey,
      bpm: trackFeatures.bpm,
      camelot: trackFeatures.camelot,
      keyName: trackFeatures.keyName,
      energy: trackFeatures.energy,
      error: trackFeatures.error,
      analyzedAt: trackFeatures.analyzedAt,
    })
    .from(trackFeatures)
    .where(inArray(trackFeatures.ratingKey, ratingKeys))
  return new Map(rows.map((r) => [r.ratingKey, r]))
}

export async function saveTrackFeatures(
  db: Database,
  row: {
    ratingKey: string
    partKey: string
    durationMs?: number | null
    features?: AudioFeatures
    error?: string
  },
): Promise<void> {
  const f = row.features
  const values = {
    ratingKey: row.ratingKey,
    partKey: row.partKey,
    bpm: f?.bpm ?? null,
    bpmConfidence: f?.bpmConfidence ?? null,
    camelot: f?.camelot ?? null,
    keyName: f?.keyName ?? null,
    keyConfidence: f?.keyConfidence ?? null,
    energy: f?.energy ?? null,
    durationMs: row.durationMs ?? null,
    error: row.error ?? null,
    analyzedAt: new Date(),
  }
  await db
    .insert(trackFeatures)
    .values(values)
    .onConflictDoUpdate({
      target: trackFeatures.ratingKey,
      set: {
        partKey: sql`excluded.part_key`,
        bpm: sql`excluded.bpm`,
        bpmConfidence: sql`excluded.bpm_confidence`,
        camelot: sql`excluded.camelot`,
        keyName: sql`excluded.key_name`,
        keyConfidence: sql`excluded.key_confidence`,
        energy: sql`excluded.energy`,
        durationMs: sql`excluded.duration_ms`,
        error: sql`excluded.error`,
        analyzedAt: sql`excluded.analyzed_at`,
      },
    })
}
