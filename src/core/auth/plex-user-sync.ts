// Proactively mirrors Plex's own server-sharing list into DJ Llama accounts,
// rather than only lazily creating an account the first time someone happens
// to log in. Every Plex identity with access to the server gets an account;
// whether they can actually use the app (vs. see a "contact your admin"
// screen) depends separately on hasMusicAccess. Run periodically (see
// src/index.ts) and on demand via the admin's "Sync now" button.

import { hashPassword } from '@/core/auth'
import { getPlexServerSharedUsers } from '@/core/auth/plex'
import { errMsg } from '@/core/validation'
import type { Database } from '@/db'
import { getSettings } from '@/db/queries/settings'
import {
  createUser,
  getUserByPlexAccountId,
  listPlexLinkedUsers,
  updateUser,
} from '@/db/queries/users'

export type PlexUserSyncResult = {
  added: number
  updated: number
  revoked: number
  error?: string
}

export async function syncPlexServerUsers(db: Database): Promise<PlexUserSyncResult> {
  const settings = await getSettings(db)
  if (!settings?.plexAdminToken || !settings.plexMachineIdentifier) {
    return { added: 0, updated: 0, revoked: 0, error: 'Plex admin connection not configured yet' }
  }
  const musicSectionIds = settings.plexMusicSectionIds ?? []

  let plexUsers: Awaited<ReturnType<typeof getPlexServerSharedUsers>>
  try {
    plexUsers = await getPlexServerSharedUsers(
      settings.plexAdminToken,
      settings.plexMachineIdentifier,
      musicSectionIds,
    )
  } catch (err) {
    console.error('[plex-user-sync] failed to fetch shared users:', err)
    return { added: 0, updated: 0, revoked: 0, error: errMsg(err) }
  }

  let added = 0
  let updated = 0
  const seenAccountIds = new Set<number>()

  for (const pu of plexUsers) {
    seenAccountIds.add(pu.accountId)
    const existing = await getUserByPlexAccountId(db, pu.accountId)
    if (!existing) {
      await createUser(db, {
        username: pu.username,
        passwordHash: hashPassword(crypto.randomUUID()),
        isAdmin: false,
        email: pu.email ?? undefined,
        plexAccountId: pu.accountId,
        authProvider: 'plex',
        hasMusicAccess: pu.hasMusicAccess,
      })
      added++
      continue
    }
    const needsUpdate =
      existing.hasMusicAccess !== pu.hasMusicAccess ||
      existing.plexAccessRevokedAt !== null ||
      existing.username !== pu.username
    if (needsUpdate) {
      await updateUser(db, existing.id, {
        username: pu.username,
        hasMusicAccess: pu.hasMusicAccess,
        plexAccessRevokedAt: null,
      })
      updated++
    }
  }

  // Removal pass: any Plex-linked account that no longer shows up at all in
  // the server's shared-users list gets soft-revoked. The owner never
  // appears in that list to begin with (it's *shared* users, not the owner)
  // and is explicitly skipped as defense in depth.
  let revoked = 0
  const known = await listPlexLinkedUsers(db)
  for (const u of known) {
    if (u.isOwner || u.plexAccountId == null) continue
    if (u.plexAccessRevokedAt) continue
    if (!seenAccountIds.has(u.plexAccountId)) {
      await updateUser(db, u.id, { plexAccessRevokedAt: new Date() })
      revoked++
    }
  }

  return { added, updated, revoked }
}
