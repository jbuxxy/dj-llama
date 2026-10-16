import { createHash } from 'node:crypto'
import { and, asc, eq, gt, inArray, lt, max } from 'drizzle-orm'
import type { Database, DbOrTx } from '@/db'
import { sessions, users } from '../schema'

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** Hash a session token before storage/lookup so plaintext tokens never touch the DB. */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export class SessionRotationConflictError extends Error {
  constructor() {
    super('Session source is no longer active')
    this.name = 'SessionRotationConflictError'
  }
}

type LockedUser = { id: number }

async function lockSessionOwners(
  tx: DbOrTx,
  targetUserId: number,
  credentialHashes: string[],
): Promise<LockedUser | null> {
  const owners =
    credentialHashes.length > 0
      ? await tx
          .select({ userId: sessions.userId })
          .from(sessions)
          .where(inArray(sessions.token, credentialHashes))
      : []
  const userIds = [...new Set([targetUserId, ...owners.map((owner) => owner.userId)])].sort(
    (a, b) => a - b,
  )
  const lockedUsers = await tx
    .select({ id: users.id })
    .from(users)
    .where(inArray(users.id, userIds))
    .orderBy(asc(users.id))
    .for('update')
  return lockedUsers.find((user) => user.id === targetUserId) ?? null
}

export function sessionQueries(db: Database) {
  return {
    async create(token: string, userId: number): Promise<void> {
      const hashed = hashSessionToken(token)
      const expiresAt = new Date(Date.now() + SESSION_TTL_MS)
      await db.insert(sessions).values({ token: hashed, userId, expiresAt }).onConflictDoUpdate({
        target: sessions.token,
        set: { userId, expiresAt },
      })
    },

    async get(token: string): Promise<{ userId: number } | null> {
      const hashed = hashSessionToken(token)
      const [row] = await db
        .select({ userId: sessions.userId })
        .from(sessions)
        .where(and(eq(sessions.token, hashed), gt(sessions.expiresAt, new Date())))
        .limit(1)
      return row ?? null
    },

    async delete(token: string): Promise<void> {
      const hashed = hashSessionToken(token)
      await db.delete(sessions).where(eq(sessions.token, hashed))
    },

    async deleteForUser(userId: number): Promise<void> {
      await db.delete(sessions).where(eq(sessions.userId, userId))
    },

    async replace(
      userId: number,
      newToken: string,
      requiredSourceToken: string,
      revokedTokens: string[],
    ): Promise<void> {
      if (newToken === requiredSourceToken) throw new SessionRotationConflictError()
      const revokedHashes = [
        ...new Set(
          revokedTokens
            .filter((token) => token !== newToken && token !== requiredSourceToken)
            .map(hashSessionToken),
        ),
      ].sort()
      const token = hashSessionToken(newToken)
      const sourceToken = hashSessionToken(requiredSourceToken)
      const credentialHashes = [...new Set([sourceToken, ...revokedHashes])].sort()
      const expiresAt = new Date(Date.now() + SESSION_TTL_MS)

      await db.transaction(async (tx) => {
        const target = await lockSessionOwners(tx, userId, credentialHashes)
        if (!target) throw new SessionRotationConflictError()

        const deletedSource = await tx
          .delete(sessions)
          .where(and(eq(sessions.token, sourceToken), eq(sessions.userId, userId)))
          .returning({ token: sessions.token })
        if (deletedSource.length !== 1) throw new SessionRotationConflictError()

        if (revokedHashes.length > 0) {
          await tx.delete(sessions).where(inArray(sessions.token, revokedHashes))
        }
        await tx.insert(sessions).values({ token, userId, expiresAt })
      })
    },

    async getActiveForUser(userId: number): Promise<string | null> {
      const [row] = await db
        .select({ token: sessions.token })
        .from(sessions)
        .where(and(eq(sessions.userId, userId), gt(sessions.expiresAt, new Date())))
        .limit(1)
      return row?.token ?? null
    },

    async deleteExpired(): Promise<void> {
      await db.delete(sessions).where(lt(sessions.expiresAt, new Date()))
    },

    async clear(): Promise<void> {
      await db.delete(sessions)
    },
  }
}

export type SessionStore = ReturnType<typeof sessionQueries>

/**
 * Most recent sign-in per user, from session creation times. Expired sessions
 * are pruned, so a user missing here hasn't signed in within SESSION_TTL_MS
 * (or ever) -- not necessarily never.
 */
export async function getLastSignInByUser(db: Database): Promise<Map<number, Date>> {
  const rows = await db
    .select({ userId: sessions.userId, lastSignInAt: max(sessions.createdAt) })
    .from(sessions)
    .groupBy(sessions.userId)
  return new Map(
    rows.flatMap((r) => (r.lastSignInAt ? [[r.userId, new Date(r.lastSignInAt)] as const] : [])),
  )
}
