import type { Database } from '@/db'
import { getUserById, type UserPublic } from '@/db/queries/users'
import type { Preferences } from '@/db/schema'

/**
 * Resolve per-user preferences with fallback to global.
 * Returns the user's preferences if they exist and are non-empty,
 * otherwise returns the global preferences unchanged.
 *
 * Accepts either a Database instance (calls getUserById internally)
 * or a pre-bound lookup function (for routes using AppDependencies).
 */
export async function resolveUserPreferences(
  dbOrLookup: Database | ((id: number) => Promise<UserPublic | null>),
  globalPrefs: Partial<Preferences> | null,
  userId?: number,
): Promise<Partial<Preferences> | null> {
  if (!userId) return globalPrefs
  const user =
    typeof dbOrLookup === 'function'
      ? await dbOrLookup(userId)
      : await getUserById(dbOrLookup, userId)
  if (user?.preferences && Object.keys(user.preferences).length > 0) {
    return user.preferences
  }
  return globalPrefs
}

/**
 * Lidarr's quality/metadata profile and root folder are admin-only global
 * defaults, unlike everything else resolveUserPreferences resolves (score
 * threshold, weights, auto-approve, etc, which genuinely are per-user).
 * Callers that build a merged preferences object for pipeline/dispatch
 * purposes should route the result through this so these 3 fields always
 * come from the global settings row, regardless of what a user's own stored
 * preferences contain (including stale values from before this was global).
 */
export function withGlobalLidarrDefaults<T extends Partial<Preferences> | null>(
  resolved: T,
  globalPrefs: Partial<Preferences> | null,
): T {
  if (!resolved) return resolved
  return {
    ...resolved,
    qualityProfileId: globalPrefs?.qualityProfileId,
    metadataProfileId: globalPrefs?.metadataProfileId,
    rootFolderId: globalPrefs?.rootFolderId,
  }
}
