import { recordFailureSafely } from '@/core/jobs/record-failure-safely'
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
  warmArtist?: (mbid: string) => Promise<void>
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
  const hasLidarr = targets.some((t) => t.type === 'lidarr')
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
    // Pre-warm SkyHook if Lidarr target exists
    if (deps.warmArtist && hasLidarr) {
      await deps.warmArtist(rec.artist.mbid).catch(() => {})
    }

    const releaseGroupMbid = albumOnly ? rec.recommendedReleaseGroupId : null
    const addTargets = targets.filter((t) =>
      t.capabilities?.includes(releaseGroupMbid ? 'addAlbum' : 'addArtist'),
    )

    if (addTargets.length === 0) {
      // No targets - mark as approved (discovery-only)
      await deps.updateRecommendationStatus(rec.id, 'approved', { targetActions: {} })
      approved++
      continue
    }

    const targetActions: Record<string, unknown> = {}
    let anySuccess = false
    let lidarrResult: {
      success: boolean
      externalId?: number | string
      error?: string
    } | null = null

    for (const target of addTargets) {
      const targetJobId = deps.jobRecorder
        ? await deps.jobRecorder.start({
            type: 'target',
            userId: deps.userId,
            metadata: {
              targetType: target.type,
              artistName: rec.artist.name,
              mbid: rec.artist.mbid,
              ...(releaseGroupMbid ? { releaseGroupMbid, action: 'addAlbum' } : { action: 'add' }),
            },
          })
        : null

      const result = releaseGroupMbid
        ? await target.addAlbum?.(
            { artistMbid: rec.artist.mbid, artistName: rec.artist.name, releaseGroupMbid },
            { ...addOptions, userId: deps.userId, recommendationId: rec.id },
          )
        : await target.addArtist?.({ mbid: rec.artist.mbid, name: rec.artist.name }, addOptions)

      if (!result) {
        if (targetJobId != null && deps.jobRecorder) {
          await deps.jobRecorder.complete(targetJobId, {
            metadata: { targetType: target.type, artistName: rec.artist.name, skipped: true },
          })
        }
        continue
      }

      targetActions[target.id] = {
        status: result.success ? 'added' : 'failed',
        externalId: result.externalId,
        error: result.error,
      }
      if (result.success) anySuccess = true
      if (target.type === 'lidarr') lidarrResult = result

      if (targetJobId != null && deps.jobRecorder) {
        if (result.success) {
          await deps.jobRecorder.complete(targetJobId, {
            metadata: {
              targetType: target.type,
              artistName: rec.artist.name,
              externalId: result.externalId,
            },
          })
        } else {
          await recordFailureSafely(
            deps.jobRecorder,
            targetJobId,
            result.error ?? 'Target returned failure',
          )
        }
      }
    }

    const extra: StatusUpdateExtra = { targetActions }
    if (lidarrResult) {
      // The album path returns a Lidarr ALBUM id -- wrong for lidarrArtistId
      // (it stays in targetActions instead), matching approveAlbumToTargets.
      if (lidarrResult.externalId && !releaseGroupMbid)
        extra.lidarrArtistId = lidarrResult.externalId as number
      if (lidarrResult.error) extra.lidarrError = lidarrResult.error
    }

    const lidarrSucceeded = lidarrResult?.success === true
    const lidarrFailed = hasLidarr && lidarrResult != null && !lidarrResult.success
    const finalStatus = lidarrSucceeded
      ? 'added_to_lidarr'
      : lidarrFailed
        ? 'add_failed'
        : anySuccess
          ? 'approved'
          : 'add_failed'

    await deps.updateRecommendationStatus(rec.id, finalStatus, extra)
    if (anySuccess) approved++
    else failed++
  }

  return { approved, failed }
}
