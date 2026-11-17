import { envSettingsOverrides } from '@/config/env'
import { decryptFields, encryptFields, SENSITIVE_SETTINGS } from '@/core/crypto'
import type { Database } from '@/db'
import type { Preferences } from '@/db/schema'
import { settings } from '@/db/schema'

export type SettingsRow = typeof settings.$inferSelect
type SettingsPartial = Partial<Omit<SettingsRow, 'id' | 'createdAt' | 'updatedAt'>>

export type SetupConfig = {
  lidarrUrl?: string
  lidarrApiKey?: string
  skipTlsVerify?: boolean
  aiProvider?: string
  aiApiKey?: string
  aiModel?: string
  aiBaseUrl?: string
  preferences?: Preferences
}

// getSettings() runs several times per request (route handlers, Lidarr client
// factories, notifications) and each call re-decrypts every secret column, so
// memoize the merged+decrypted row per Database handle for a few seconds. All
// writes in this file invalidate it; anything else that rewrites the settings
// table (backup restore) calls invalidateSettingsCache().
const SETTINGS_CACHE_TTL_MS = 10_000
const settingsCache = new WeakMap<Database, { at: number; row: Promise<SettingsRow | null> }>()
// setup_complete only ever flips false -> true outside a restore, so once seen
// true it's cached until invalidated.
const setupCompleteCache = new WeakSet<Database>()

export function invalidateSettingsCache(db: Database): void {
  settingsCache.delete(db)
  setupCompleteCache.delete(db)
}

export async function getSettings(db: Database): Promise<SettingsRow | null> {
  const hit = settingsCache.get(db)
  if (hit && Date.now() - hit.at < SETTINGS_CACHE_TTL_MS) {
    const row = await hit.row
    // Callers occasionally mutate what they get back (e.g. preferences);
    // hand each one its own copy so the cached row stays pristine.
    return row ? structuredClone(row) : null
  }
  const load = loadSettings(db)
  settingsCache.set(db, { at: Date.now(), row: load })
  try {
    const row = await load
    return row ? structuredClone(row) : null
  } catch (err) {
    settingsCache.delete(db)
    throw err
  }
}

async function loadSettings(db: Database): Promise<SettingsRow | null> {
  const rows = await db.select().from(settings).limit(1)
  const row = rows[0]
  if (!row) return null

  // Merge env var fallbacks for null fields
  const overrides = envSettingsOverrides()
  const merged = { ...row }
  for (const [key, value] of Object.entries(overrides)) {
    if ((merged as Record<string, unknown>)[key] == null) {
      ;(merged as Record<string, unknown>)[key] = value
    }
  }
  return decryptFields(merged, SENSITIVE_SETTINGS)
}

export async function updateSettings(db: Database, partial: SettingsPartial): Promise<void> {
  const encrypted = encryptFields(partial, SENSITIVE_SETTINGS)
  invalidateSettingsCache(db)
  // Upsert, not a plain UPDATE: the settings row doesn't exist until
  // something first creates it (e.g. completeSetup()'s Lidarr/AI wizard).
  // Plex login can legitimately run before that wizard, so a plain
  // `.update().where(id=1)` would silently affect zero rows and lose
  // whatever it was trying to persist -- this bit us for real, wiping
  // plexAdminUrl/plexAdminToken/plexMusicSectionIds on first login.
  await db
    .insert(settings)
    .values({ ...encrypted, id: 1 })
    .onConflictDoUpdate({
      target: settings.id,
      set: { ...encrypted, updatedAt: new Date() },
    })
  invalidateSettingsCache(db)
}

export async function completeSetup(db: Database, config: SetupConfig): Promise<SettingsRow> {
  const encrypted = encryptFields(config, SENSITIVE_SETTINGS)
  const rows = await db
    .insert(settings)
    .values({ ...encrypted, setupComplete: true, id: 1 })
    .onConflictDoUpdate({
      target: settings.id,
      set: { ...encrypted, setupComplete: true, updatedAt: new Date() },
    })
    .returning()
  invalidateSettingsCache(db)
  const row = rows[0]
  if (!row) throw new Error('completeSetup: no row returned')
  return decryptFields(row, SENSITIVE_SETTINGS)
}

export async function isSetupComplete(db: Database): Promise<boolean> {
  if (setupCompleteCache.has(db)) return true
  const rows = await db.select({ setupComplete: settings.setupComplete }).from(settings).limit(1)
  const complete = rows[0]?.setupComplete ?? false
  if (complete) setupCompleteCache.add(db)
  return complete
}
