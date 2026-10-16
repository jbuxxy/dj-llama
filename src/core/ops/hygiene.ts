import { and, isNotNull, lt } from 'drizzle-orm'
import { artists } from '@/db/schema'
import type { HygieneResult, OpsDb } from './types'

export async function clearImageFailures(
  db: OpsDb,
  olderThanDays?: number,
): Promise<HygieneResult> {
  const conditions = [isNotNull(artists.imageFailedAt)]
  if (olderThanDays) {
    const cutoff = new Date(Date.now() - olderThanDays * 86400000)
    conditions.push(lt(artists.imageFailedAt, cutoff))
  }

  const result = await db
    .update(artists)
    .set({ imageFailedAt: null })
    .where(conditions.length === 1 ? conditions[0] : and(...conditions))

  return { tool: 'clear-image-failures', cleared: result.rowCount ?? 0 }
}
