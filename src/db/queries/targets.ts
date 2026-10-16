import { and, eq, isNull } from 'drizzle-orm'
import { decryptFields, encryptFields, SENSITIVE_TARGET_CONFIG } from '@/core/crypto'
import type { Database } from '@/db'
import { targets } from '@/db/schema'

export type TargetRow = typeof targets.$inferSelect

function encryptConfig(config: Record<string, unknown>): Record<string, unknown> {
  return encryptFields(config, SENSITIVE_TARGET_CONFIG)
}

function decryptConfig<T extends { config: Record<string, unknown> | unknown }>(row: T): T {
  if (row.config && typeof row.config === 'object') {
    return {
      ...row,
      config: decryptFields(row.config as Record<string, unknown>, SENSITIVE_TARGET_CONFIG),
    }
  }
  return row
}

/**
 * Lidarr is a global, admin-configured connection (settings.lidarrUrl etc.),
 * not a manually added per-user target. This "system" target (userId: null,
 * exactly one per type) is auto-created and kept in sync with settings
 * whenever an admin saves the corresponding Connections card. Never exposed
 * for direct CRUD.
 */
export async function getSystemTarget(db: Database, type: string): Promise<TargetRow | null> {
  const [row] = await db
    .select()
    .from(targets)
    .where(and(eq(targets.type, type), isNull(targets.userId)))
    .limit(1)
  return row ? decryptConfig(row) : null
}

export async function upsertSystemTarget(
  db: Database,
  type: string,
  name: string,
  config: Record<string, unknown>,
): Promise<{ id: number }> {
  const [existing] = await db
    .select({ id: targets.id })
    .from(targets)
    .where(and(eq(targets.type, type), isNull(targets.userId)))
    .limit(1)
  if (existing) {
    await db
      .update(targets)
      .set({ name, config: encryptConfig(config), enabled: true, updatedAt: new Date() })
      .where(eq(targets.id, existing.id))
    return { id: existing.id }
  }
  const [inserted] = await db
    .insert(targets)
    .values({ type, name, config: encryptConfig(config), userId: null, enabled: true })
    .returning({ id: targets.id })
  if (!inserted) throw new Error('upsertSystemTarget: no row returned')
  return { id: inserted.id }
}

/**
 * Disables (never deletes) a system target -- used when an admin clears a
 * connection, so job/history records tied to it are preserved.
 */
export async function disableSystemTarget(db: Database, type: string): Promise<void> {
  await db
    .update(targets)
    .set({ enabled: false, updatedAt: new Date() })
    .where(and(eq(targets.type, type), isNull(targets.userId)))
}
