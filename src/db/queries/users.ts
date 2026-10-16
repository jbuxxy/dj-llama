import { and, count, desc, eq, isNotNull, isNull, lt, or } from 'drizzle-orm'
import { decryptFields, encryptFields, SENSITIVE_USER_CONNECTIONS } from '@/core/crypto'
import type { Database } from '@/db'
import type { Preferences, TasteProfileCache } from '@/db/schema'
import { users } from '@/db/schema'
import type { Cursor } from '@/server/helpers/pagination-cursor'

type UserRow = typeof users.$inferSelect

export type UserPublic = Omit<UserRow, 'passwordHash'>

function toPublic(row: UserRow): UserPublic {
  const { passwordHash: _, ...rest } = row
  return rest
}

export async function createUser(
  db: Database,
  data: {
    username: string
    passwordHash: string
    isAdmin?: boolean
    email?: string
    plexAccountId?: number
    authProvider?: string
    hasMusicAccess?: boolean
    isOwner?: boolean
  },
): Promise<UserPublic> {
  const rows = await db
    .insert(users)
    .values({
      username: data.username,
      passwordHash: data.passwordHash,
      isAdmin: data.isAdmin ?? false,
      email: data.email,
      plexAccountId: data.plexAccountId,
      authProvider: data.authProvider ?? 'local',
      hasMusicAccess: data.hasMusicAccess ?? false,
      isOwner: data.isOwner ?? false,
    })
    .returning()
  const row = rows[0]
  if (!row) throw new Error('createUser: no row returned')
  return toPublic(row)
}

export async function getUserByUsername(db: Database, username: string): Promise<UserRow | null> {
  const rows = await db.select().from(users).where(eq(users.username, username)).limit(1)
  return rows[0] ?? null
}

export async function getUserById(db: Database, id: number): Promise<UserPublic | null> {
  const rows = await db.select().from(users).where(eq(users.id, id)).limit(1)
  const row = rows[0]
  return row ? toPublic(row) : null
}

/**
 * The single "owner" account for server-to-server integrations that need one
 * fixed user with no session (e.g. /api/v1/integrations/recommendations) --
 * owner first, then any admin, then the earliest-created user. Mirrors
 * index.ts's runPipeline() cron-fallback owner resolution.
 */
export async function getOwnerUserId(db: Database): Promise<number | null> {
  const owner = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.isOwner, true))
    .limit(1)
  if (owner[0]) return owner[0].id
  const admin = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.isAdmin, true))
    .orderBy(users.id)
    .limit(1)
  if (admin[0]) return admin[0].id
  const first = await db.select({ id: users.id }).from(users).orderBy(users.id).limit(1)
  return first[0]?.id ?? null
}

export async function getUserCount(db: Database): Promise<number> {
  const rows = await db.select({ total: count() }).from(users)
  return rows[0]?.total ?? 0
}

export async function updateUserPreferences(
  db: Database,
  userId: number,
  preferences: Preferences,
): Promise<void> {
  await db.update(users).set({ preferences }).where(eq(users.id, userId))
}

export async function updateTasteProfileCache(
  db: Database,
  userId: number,
  cache: TasteProfileCache,
): Promise<void> {
  await db
    .update(users)
    .set({ tasteProfileCache: cache, tasteProfileCachedAt: new Date() })
    .where(eq(users.id, userId))
}

export async function listUsers(
  db: Database,
  opts: { limit?: number; cursor?: Cursor | null; includeRevoked?: boolean } = {},
): Promise<UserPublic[]> {
  const conditions = []
  if (opts.cursor) {
    conditions.push(
      or(
        lt(users.createdAt, new Date(opts.cursor.ts)),
        and(eq(users.createdAt, new Date(opts.cursor.ts)), lt(users.id, opts.cursor.id)),
      ) as NonNullable<ReturnType<typeof or>>,
    )
  }
  // Users whose Plex server access was fully revoked (see plex-user-sync.ts)
  // are hidden by default -- they should read as "removed" in the admin UI,
  // even though the row is kept (soft revoke, not a hard delete).
  if (!opts.includeRevoked) {
    conditions.push(isNull(users.plexAccessRevokedAt))
  }
  const base = conditions.length
    ? db
        .select()
        .from(users)
        .where(and(...conditions))
    : db.select().from(users)
  const ordered = base.orderBy(desc(users.createdAt), desc(users.id))
  const rows = await (opts.limit ? ordered.limit(opts.limit) : ordered)
  return rows.map(toPublic)
}

/** All Plex-linked accounts, including revoked ones -- used by the sync job's removal pass. */
export async function listPlexLinkedUsers(db: Database): Promise<UserPublic[]> {
  const rows = await db
    .select()
    .from(users)
    .where(and(eq(users.authProvider, 'plex'), isNotNull(users.plexAccountId)))
  return rows.map(toPublic)
}

export async function deleteUser(db: Database, id: number): Promise<void> {
  await db.delete(users).where(eq(users.id, id))
}

export async function getUserByPlexAccountId(
  db: Database,
  plexAccountId: number,
): Promise<UserRow | null> {
  const rows = await db.select().from(users).where(eq(users.plexAccountId, plexAccountId)).limit(1)
  return rows[0] ?? null
}

export type UserConnections = {
  // Plex username -- doubles as the account's DJ Llama username (set from the
  // Plex identity at signup). Used to resolve the *local* Plex server account
  // id for history-endpoint scoping; see clients/plex.ts's getServerAccounts().
  username: string
  plexUrl: string | null
  plexToken: string | null
  plexSectionId: string | null
  // Plex's *global* (plex.tv) account id -- used only to identify which DJ
  // Llama user row a Plex login belongs to (see getUserByPlexAccountId). NOT
  // valid as the local Plex Media Server history endpoint's accountID filter
  // -- that's a different, server-local id space (resolved via username).
  plexAccountId: number | null
}

export async function getUserConnections(
  db: Database,
  userId: number,
): Promise<UserConnections | null> {
  const [row] = await db
    .select({
      username: users.username,
      plexUrl: users.plexUrl,
      plexToken: users.plexToken,
      plexSectionId: users.plexSectionId,
      plexAccountId: users.plexAccountId,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  if (!row) return null
  return decryptFields(row, SENSITIVE_USER_CONNECTIONS)
}

export async function updateUserConnections(
  db: Database,
  userId: number,
  data: Partial<UserConnections>,
): Promise<void> {
  const encrypted = encryptFields(data, SENSITIVE_USER_CONNECTIONS)
  await db.update(users).set(encrypted).where(eq(users.id, userId))
}

// Deliberately its own narrow function, not a field on updateUser()'s
// general-purpose data bag -- isOwner is set exactly once, at a verified
// bootstrap completion, and should never be reachable from any other,
// broader update call site by accident.
export async function markUserAsOwner(db: Database, id: number): Promise<void> {
  await db.update(users).set({ isOwner: true }).where(eq(users.id, id))
}

export async function updateUser(
  db: Database,
  id: number,
  data: {
    username?: string
    isAdmin?: boolean
    email?: string | null
    plexAccountId?: number
    authProvider?: string
    hasMusicAccess?: boolean
    plexAccessRevokedAt?: Date | null
    autoApproveRequests?: boolean
  },
): Promise<void> {
  await db.update(users).set(data).where(eq(users.id, id))
}
