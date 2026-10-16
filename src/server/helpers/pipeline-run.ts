import type { AutoApproveDeps } from '@/core/pipeline/auto-approve'
import type { PipelineDeps } from '@/core/pipeline/orchestrator'
import { buildSimilarityProviders } from '@/core/similarity/providers'
import { getUserConnections } from '@/db/queries/users'
import type { AppDependencies } from '@/server'
import { resolveUserPreferences, withGlobalLidarrDefaults } from '@/server/helpers/preferences'

/**
 * Everything one discovery run needs for one user. Shared by the "Run scan"
 * route and the cron schedule so both get the same per-user preferences, Plex
 * connection (listening history), auto-request and job-history recording --
 * the scheduled path used to skip all four.
 */
export async function buildPipelineRun(
  deps: AppDependencies,
  userId: number | undefined,
  trigger: 'manual' | 'scheduled',
): Promise<PipelineDeps | null> {
  const settings = await deps.getSettings()
  if (!settings) return null

  const user = userId ? await deps.getUserById(userId) : null
  const userConnections = userId ? await getUserConnections(deps.db, userId) : null

  // Per-user preferences with global fallback. Lidarr's quality/metadata
  // profile and root folder are admin-only global defaults -- see
  // withGlobalLidarrDefaults.
  const userPreferences = withGlobalLidarrDefaults(
    await resolveUserPreferences(async () => user, settings.preferences, userId),
    settings.preferences,
  )

  const autoApproveDeps: AutoApproveDeps = {
    getRecommendationsByBatch: async (batchId) => {
      const result = await deps.listRecommendations({ batchId, limit: 1000 })
      return result.items.map((r) => ({
        id: r.id,
        score: r.score,
        status: r.status,
        artist: { mbid: r.artist.mbid, name: r.artist.name },
        recommendedReleaseGroupId: r.recommendedReleaseGroupId,
      }))
    },
    getEnabledTargets: () => (userId ? deps.getEnabledTargetsForUser(userId) : Promise.resolve([])),
    updateRecommendationStatus: (id, status, extra) =>
      deps.updateRecommendationStatus(id, status, extra),
    warmArtist: deps.skyhookWarmer
      ? (
          (warmer) => (mbid: string) =>
            warmer.warm(mbid)
        )(deps.skyhookWarmer)
      : undefined,
  }

  return {
    db: deps.storeDb,
    settings: { ...settings, preferences: userPreferences },
    userId,
    providerRegistry: deps.providerRegistry,
    userConnections,
    autoApproveDeps,
    librarySync: deps.librarySync,
    jobRecorder: deps.jobRecorder,
    getUserById: deps.getUserById,
    trigger,
    similarityProviders: buildSimilarityProviders(settings.lastfmApiKey),
  } as unknown as PipelineDeps
}
