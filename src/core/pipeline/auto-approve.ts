import { dispatchToTargets } from '@/core/targets/dispatch'
import type { DestinationTarget, TargetAddOptions } from '@/core/targets/types'
import type { StatusUpdateExtra } from '@/db/queries/recommendations'

export type AutoApproveDeps = {
  getRecommendationsByBatch: (batchId: number) => Promise<
    Array<{
      id: number
      score: number
      status: string
      artist: { mbid: string; name: string }
      /** The rec's suggested album -- what 'recommended' monitor mode adds. */
      recommendedReleaseGroupId?: string | null
    }>
  >
  getEnabledTargets: () => Promise<DestinationTarget[]>
  updateRecommendationStatus: (
    id: number,
    status: string,
    extra?: StatusUpdateExtra,
  ) => Promise<void>
  jobRecorder?: import('@/core/jobs/types').JobRecorder
  userId?: number
}

/** 'recommended' = add only the rec's suggested album (falls back to an
 * unmonitored artist add when the rec has no suggested album). */
export type AutoApproveMonitorOption = 'recommended' | 'all' | 'new'

type AutoApproveConfig = {
  threshold: number
  monitorOption: AutoApproveMonitorOption
  qualityProfileId: number
  metadataProfileId: number
  rootFolderId?: number
}

export async function autoApprove(
  batchId: number,
  config: AutoApproveConfig,
  deps: AutoApproveDeps,
): Promise<{ approved: number; failed: number }> {
  const recs = await deps.getRecommendationsByBatch(batchId)
  const eligible = recs.filter((r) => r.status === 'pending' && r.score >= config.threshold)

  if (eligible.length === 0) return { approved: 0, failed: 0 }

  const targets = await deps.getEnabledTargets()
  const albumOnly = config.monitorOption === 'recommended'

  const addOptions: TargetAddOptions = {
    monitorOption: config.monitorOption === 'recommended' ? 'none' : config.monitorOption,
    qualityProfileId: config.qualityProfileId,
    metadataProfileId: config.metadataProfileId,
    rootFolderId: config.rootFolderId,
  }

  let approved = 0
  let failed = 0

  for (const rec of eligible) {
    const releaseGroupMbid = albumOnly ? rec.recommendedReleaseGroupId : null
    const capability = releaseGroupMbid ? 'addAlbum' : 'addArtist'
    if (!targets.some((t) => t.capabilities?.includes(capability))) {
      // No targets - mark as approved (discovery-only)
      await deps.updateRecommendationStatus(rec.id, 'approved', { targetActions: {} })
      approved++
      continue
    }

    const result = await dispatchToTargets(
      releaseGroupMbid
        ? {
            kind: 'album',
            artistMbid: rec.artist.mbid,
            artistName: rec.artist.name,
            releaseGroupMbid,
          }
        : { kind: 'artist', mbid: rec.artist.mbid, name: rec.artist.name },
      targets,
      addOptions,
      { jobRecorder: deps.jobRecorder, userId: deps.userId, recommendationId: rec.id },
    )

    const extra: StatusUpdateExtra = { targetActions: result.targetActions }
    if (result.lidarrArtistId) extra.lidarrArtistId = result.lidarrArtistId as number
    if (result.lidarrError) extra.lidarrError = result.lidarrError
    await deps.updateRecommendationStatus(rec.id, result.status, extra)
    if (result.status === 'add_failed') failed++
    else approved++
  }

  return { approved, failed }
}
