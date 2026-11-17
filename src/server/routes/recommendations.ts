import { type Context, Hono } from 'hono'
import { envConfig } from '@/config/env'
import { decryptChannelSecrets, safeCompare } from '@/core/crypto'
import { activityTracker } from '@/core/jobs/activity'
import { dispatch, logDispatchFailures } from '@/core/notifications'
import { realtimeBroker } from '@/core/realtime/broker'
import {
  deriveDispatchStatus,
  dispatchToTargets,
  isTargetSuccess,
  targetTypeResolver,
} from '@/core/targets/dispatch'
import type { TargetAddOptions } from '@/core/targets/types'
import { errMsg } from '@/core/validation'
import { getOwnerUserId } from '@/db/queries/users'
import { mergePreferences } from '@/db/schema'
import type { AppDependencies } from '@/server'
import {
  buildAddOptions,
  type MonitorOption,
  PopularAlbumsError,
} from '@/server/helpers/add-options'
import { apiError, problem } from '@/server/helpers/problem'
import {
  bulkRecommendationSchema,
  listRecommendationsQuerySchema,
  recommendationIdParamSchema,
  rejectStatusSchema,
  updateRecommendationSchema,
} from '@/server/schemas/recommendations'
import { zJson, zParam, zQuery } from '@/server/schemas/validator'
import type { HonoEnv } from '@/server/types'

type TargetActionRecord = { status?: string; error?: string; warning?: string } | null

type TargetSummary = {
  total: number
  succeeded: number
  failed: number
  failures: Array<{ id: string; name: string; error?: string }>
  warnings: string[]
}

/** Per-target outcome of a single approve attempt, for submit-time UI surfacing. */
function summarizeTargetActions(
  targetActions: Record<string, unknown>,
  targetsById: Map<string, { name: string }>,
): TargetSummary {
  const entries = Object.entries(targetActions) as [string, TargetActionRecord][]
  const failures: TargetSummary['failures'] = []
  const warnings: string[] = []
  let succeeded = 0
  for (const [id, action] of entries) {
    if (isTargetSuccess(action)) {
      succeeded++
      if (action?.warning) warnings.push(action.warning)
    } else {
      failures.push({ id, name: targetsById.get(id)?.name ?? id, error: action?.error })
    }
  }
  return { total: entries.length, succeeded, failed: failures.length, failures, warnings }
}

function isOwned(rec: { userId?: number | null }, callerId?: number): boolean {
  if (!rec.userId) return true // legacy recs (null userId) are visible to everyone
  return rec.userId === callerId
}

export function recommendationRoutes(deps: AppDependencies) {
  const router = new Hono<HonoEnv>()

  // Missing and non-owned both 404 (don't leak ownership); on failure returns the Response to return as-is.
  const loadOwnedRecommendation = async (
    c: Context<HonoEnv>,
    id: number,
  ): Promise<
    | {
        rec: NonNullable<Awaited<ReturnType<AppDependencies['getRecommendation']>>>
        userId?: number
      }
    | Response
  > => {
    const rec = await deps.getRecommendation(id)
    const userId = c.get('userId')
    if (!rec || !isOwned(rec, userId))
      return problem(
        c,
        'recommendation-not-found',
        'Recommendation not found',
        404,
        undefined,
        undefined,
        'errors.recommendation.notFound',
      )
    return { rec, userId }
  }

  // Fire-and-forget, admin-facing only (mirrors requests.ts's notifyRequestEvent).
  // Only called when a dispatch to a target was actually attempted (status is
  // 'added_to_lidarr' or 'add_failed') -- an approve with no actionable targets
  // never reaches a real target, so it stays silent rather than notifying about
  // nothing having happened.
  async function notifyRecommendationApproved(
    rec: { id: number; kind: string; artist: { name: string; imageUrl: string | null } },
    subjectTitle: string | undefined,
    status: 'added_to_lidarr' | 'add_failed',
  ): Promise<void> {
    const settings = await deps.getSettings()
    const prefs = mergePreferences(settings?.preferences)
    const channels = decryptChannelSecrets(prefs.channels ?? [])
    if (channels.length === 0) return

    const dispatchStatus: 'dispatched' | 'failed' =
      status === 'added_to_lidarr' ? 'dispatched' : 'failed'
    const label = subjectTitle ? `${rec.artist.name} — ${subjectTitle}` : rec.artist.name

    dispatch(channels, 'recommendation_approved', {
      event: 'recommendation_approved',
      recommendationId: rec.id,
      artistName: rec.artist.name,
      subjectTitle,
      imageUrl: rec.artist.imageUrl ?? undefined,
      status: dispatchStatus,
      message:
        dispatchStatus === 'failed'
          ? `${label} was approved but dispatch to Lidarr failed.`
          : `${label} was approved and sent to Lidarr.`,
      timestamp: new Date().toISOString(),
    })
      .then(logDispatchFailures)
      .catch((err) => console.error('Notification dispatch failed:', err))
  }

  router.get('/api/v1/recommendations', zQuery(listRecommendationsQuerySchema), async (c) => {
    const userId = c.get('userId')
    const query = c.req.valid('query')
    const filters = {
      status: query.status,
      batchId: query.batchId,
      userId,
      decades: query.decades || undefined,
      kind:
        query.kind === 'artist' || query.kind === 'album'
          ? (query.kind as 'artist' | 'album')
          : undefined,
      sort: query.sort,
      limit: query.limit,
      offset: query.offset,
    }
    const result = await deps.listRecommendations(filters)
    return c.json(result)
  })

  // Machine-to-machine, read-only -- e.g. BuxFlix's landing page pulling
  // recommendations into its Music carousel. Not session/legacy-token auth
  // (see middleware/auth.ts's PUBLIC_PATHS entry for this path): validates
  // its own Authorization: Bearer against DJLLAMA_INTEGRATIONS_TOKEN, scoped
  // to the owner account (getOwnerUserId -- there's no session here to scope
  // by, and DJ Llama's own recommendation flow is single-primary-user in
  // practice) and trimmed to only the fields worth showing on an external
  // page plus the mbids needed to deep-link back into DJ Llama's own
  // /requests/album/:mbid or /requests/artist/:mbid (see album-details.tsx /
  // artist-discography.tsx) so the card can actually be requested -- no
  // aiReasoning, no internal ids.
  router.get('/api/v1/integrations/recommendations', async (c) => {
    if (!envConfig.integrationsToken) {
      return problem(
        c,
        'integrations-not-configured',
        'Integrations not configured',
        503,
        'DJLLAMA_INTEGRATIONS_TOKEN is not set.',
      )
    }
    const header = c.req.header('Authorization')
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined
    if (!token || !safeCompare(token, envConfig.integrationsToken)) {
      return problem(c, 'integrations-unauthorized', 'Unauthorized', 401)
    }
    const ownerId = await getOwnerUserId(deps.db)
    if (ownerId === null) {
      return c.json({ items: [] })
    }
    const result = await deps.listRecommendations({
      userId: ownerId,
      status: 'pending',
      sort: 'score_desc',
      limit: 12,
    })
    return c.json({
      items: result.items.map((item) => ({
        artist: item.artist.name,
        album: item.kind === 'album' ? item.recommendedReleaseGroupTitle : null,
        // Album art for album-kind recs (same coverartarchive release-group convention
        // used by todays-pick.tsx/recently-approved.tsx), falling back to the artist
        // photo only for artist-kind recs, which have no specific album to show.
        coverUrl:
          item.kind === 'album' && item.recommendedReleaseGroupId
            ? `https://coverartarchive.org/release-group/${item.recommendedReleaseGroupId}/front-500`
            : item.artist.imageUrl,
        score: item.score,
        kind: item.kind,
        artistMbid: item.artist.mbid,
        releaseGroupMbid: item.kind === 'album' ? item.recommendedReleaseGroupId : null,
      })),
    })
  })

  router.get('/api/v1/recommendations/feedback-summary', async (c) => {
    const userId = c.get('userId')
    const history = await deps.getFeedbackHistory(userId)
    const summary = [...history.entries()]
      .map(([genre, { approved, total }]) => ({
        genre,
        approved,
        rejected: total - approved,
        total,
        rate: total > 0 ? approved / total : 0,
      }))
      .filter((e) => e.total >= 3)
      .sort((a, b) => b.rate - a.rate)
      .slice(0, 20)

    return c.json({ summary })
  })

  // Backs the approve menu's "Popular albums" gating: true when a signed-in
  // user is present (Spotify catalog access needs no per-user connection --
  // see core/clients/spotify.ts).
  router.get('/api/v1/recommendations/popular-albums/availability', async (c) => {
    const userId = c.get('userId')
    if (!userId) return c.json({ available: false, spotify: false })
    return c.json({ available: true, spotify: true })
  })

  router.get('/api/v1/recommendations/:id', zParam(recommendationIdParamSchema), async (c) => {
    const { id } = c.req.valid('param')
    const loaded = await loadOwnedRecommendation(c, id)
    if (loaded instanceof Response) return loaded
    return c.json(loaded.rec)
  })

  router.patch(
    '/api/v1/recommendations/:id',
    zParam(recommendationIdParamSchema),
    zJson(updateRecommendationSchema),
    async (c) => {
      const { id } = c.req.valid('param')
      const body = c.req.valid('json')
      const {
        status,
        monitorOption,
        selectedAlbumIds,
        targetId,
        qualityProfileId: qpOverride,
        metadataProfileId: mpOverride,
        rootFolderId: rfOverride,
        expandToDiscography,
      } = body

      if (status === 'approved') {
        const loaded = await loadOwnedRecommendation(c, id)
        if (loaded instanceof Response) return loaded
        const { rec, userId } = loaded

        const targets = userId ? await deps.getEnabledTargetsForUser(userId) : []
        const effectiveTargets = targetId ? targets.filter((t) => t.id === targetId) : targets

        if (targetId && effectiveTargets.length === 0) {
          return apiError(c, 400, `Unknown targetId: ${targetId}`)
        }
        if (targetId && !effectiveTargets.some((t) => t.capabilities?.includes('addArtist'))) {
          return apiError(c, 400, `Target does not support artist approval: ${targetId}`)
        }

        // Pre-warm SkyHook if any Lidarr target exists
        if (
          deps.skyhookWarmer &&
          rec.artist?.mbid &&
          effectiveTargets.some((t) => t.type === 'lidarr')
        ) {
          try {
            await deps.skyhookWarmer.warm(rec.artist.mbid)
          } catch {
            // Best-effort
          }
        }

        // Album recs resolve the target album via releaseGroupMbid and ignore
        // selectedAlbumIds entirely, so skip the popular/selected resolution
        // (which hits Spotify/MusicBrainz and can 400 when Spotify is unset).
        // expandToDiscography deliberately opts an album-kind rec OUT of this
        // -- the explicit "approve whole discography" action routes it
        // through the normal whole-artist monitorOption path below instead.
        const isAlbumRec = rec.kind === 'album' && !expandToDiscography

        let addOptions: TargetAddOptions
        try {
          addOptions = await buildAddOptions(
            deps,
            userId,
            {
              mbid: rec.artist.mbid,
              name: rec.artist.name,
              streamingUrls: rec.artist.streamingUrls,
            },
            {
              monitorOption: isAlbumRec ? undefined : ((monitorOption ?? 'none') as MonitorOption),
              selectedAlbumIds: isAlbumRec ? undefined : selectedAlbumIds,
              qualityProfileId: qpOverride,
              metadataProfileId: mpOverride,
              rootFolderId: rfOverride,
            },
          )
        } catch (err) {
          if (monitorOption !== 'popular') throw err
          return apiError(
            c,
            400,
            err instanceof Error ? err.message : 'Popular albums could not be resolved',
            { code: err instanceof PopularAlbumsError ? err.code : undefined },
          )
        }

        const result = await dispatchToTargets(
          isAlbumRec && rec.recommendedReleaseGroupId
            ? {
                kind: 'album',
                artistMbid: rec.artist.mbid,
                artistName: rec.artist.name,
                releaseGroupMbid: rec.recommendedReleaseGroupId,
              }
            : { kind: 'artist', mbid: rec.artist.mbid, name: rec.artist.name },
          effectiveTargets,
          addOptions,
          { jobRecorder: deps.jobRecorder, userId, recommendationId: id },
        )

        // Merge this attempt over any prior target actions so a single-target
        // retry preserves the outcomes of targets that already succeeded.
        const priorActions =
          (rec.targetActions as Record<string, { status?: string } | null> | null) ?? {}
        const mergedActions = { ...priorActions, ...result.targetActions }
        const lidarrArtistId = result.lidarrArtistId ?? rec.lidarrArtistId ?? undefined
        // Only re-derive across the merged map when retrying a rec that already
        // had outcomes; a first approve keeps this attempt's own status (which
        // also covers the no-actionable-targets "approved" special case).
        const finalStatus =
          Object.keys(priorActions).length > 0
            ? deriveDispatchStatus(mergedActions, targetTypeResolver(targets))
            : result.status

        const extra: Record<string, unknown> = { targetActions: mergedActions }
        if (lidarrArtistId) extra.lidarrArtistId = lidarrArtistId
        if (result.lidarrError) extra.lidarrError = result.lidarrError

        await deps.updateRecommendationStatus(id, finalStatus, extra)
        if (userId) realtimeBroker.publish(userId, { type: 'activity-updated' })
        if (finalStatus === 'added_to_lidarr' || finalStatus === 'add_failed') {
          void notifyRecommendationApproved(
            rec,
            rec.kind === 'album' ? (rec.recommendedReleaseGroupTitle ?? undefined) : undefined,
            finalStatus,
          )
        }

        const targetsById = new Map(targets.map((target) => [target.id, target]))
        return c.json({
          status: finalStatus,
          targetActions: mergedActions,
          targetSummary: summarizeTargetActions(result.targetActions, targetsById),
          ...(result.lidarrError ? { lidarrError: result.lidarrError } : {}),
        })
      }

      const loaded = await loadOwnedRecommendation(c, id)
      if (loaded instanceof Response) return loaded
      const { userId } = loaded

      if (status === 'rejected') {
        const validated = rejectStatusSchema.safeParse(body)
        if (!validated.success) {
          return problem(
            c,
            'validation-failed',
            'Invalid rejection payload',
            400,
            undefined,
            { issues: validated.error.issues },
            'errors.validation.failed',
          )
        }
        await deps.rejectRecommendation({
          recommendationId: id,
          userId,
          reason: validated.data.reason ?? null,
          reasonText: validated.data.reasonText ?? null,
          permanent: validated.data.permanent,
        })
        if (userId) realtimeBroker.publish(userId, { type: 'activity-updated' })
        return c.json({ status: 'rejected' })
      }

      await deps.updateRecommendationStatus(id, status)
      if (userId) realtimeBroker.publish(userId, { type: 'activity-updated' })
      return c.json({ status })
    },
  )

  router.post('/api/v1/recommendations/bulk', zJson(bulkRecommendationSchema), async (c) => {
    const {
      ids,
      action,
      targetId,
      qualityProfileId: qpOverride,
      metadataProfileId: mpOverride,
      rootFolderId: rfOverride,
      reason,
      permanent,
    } = c.req.valid('json')

    const userId = c.get('userId')

    if (action === 'delete') {
      const ownedIds = await deps.filterOwnedIds(ids, userId)
      const deletedCount = ownedIds.length > 0 ? await deps.bulkDelete(ownedIds) : 0
      return c.json({ updated: deletedCount })
    }

    if (action === 'reject') {
      const ownedIds = await deps.filterOwnedIds(ids, userId)
      // Fast path: no shared reason/permanent => a single bulk status update,
      // preserving the prior reason-less behaviour.
      if (!reason && !permanent) {
        if (ownedIds.length > 0) {
          await deps.bulkUpdateStatus(ownedIds, 'rejected')
          if (userId) realtimeBroker.publish(userId, { type: 'activity-updated' })
        }
        return c.json({ updated: ownedIds.length })
      }
      // Shared-reason path: route each id through rejectRecommendation so the
      // reason is recorded and the optional permanent block is created per artist.
      for (const id of ownedIds) {
        await deps.rejectRecommendation({
          recommendationId: id,
          userId,
          reason: reason ?? null,
          reasonText: null,
          permanent,
        })
      }
      if (userId && ownedIds.length > 0) {
        realtimeBroker.publish(userId, { type: 'activity-updated' })
      }
      return c.json({ updated: ownedIds.length })
    }

    // Approve: route through targets
    const targets = userId ? await deps.getEnabledTargetsForUser(userId) : []
    const effectiveTargets = targetId ? targets.filter((t) => t.id === targetId) : targets
    if (targetId && effectiveTargets.length === 0) {
      return apiError(c, 400, `Unknown targetId: ${targetId}`)
    }
    if (targetId && !effectiveTargets.some((t) => t.capabilities?.includes('addArtist'))) {
      return apiError(c, 400, `Target does not support artist approval: ${targetId}`)
    }

    const addOptions = await buildAddOptions(deps, userId, undefined, {
      qualityProfileId: qpOverride,
      metadataProfileId: mpOverride,
      rootFolderId: rfOverride,
    })

    // Each item goes through the serialized Lidarr write path, so a big batch
    // takes a while -- show it moving item by item (header + live toast).
    const activity =
      userId && ids.length > 1
        ? activityTracker.start(userId, {
            kind: 'bulk_action',
            label: `Sending ${ids.length} picks to Lidarr`,
            current: 0,
            total: ids.length,
          })
        : null

    const runBatch = async () => {
      const results: Array<{ id: number; status: string; error?: string }> = []
      for (const id of ids) {
        const rec = await deps.getRecommendation(id)
        if (!rec || !isOwned(rec, userId)) {
          results.push({ id, status: 'not_found' })
          activity?.update({ current: results.length })
          continue
        }

        const result = await dispatchToTargets(
          { kind: 'artist', mbid: rec.artist.mbid, name: rec.artist.name },
          effectiveTargets,
          addOptions,
          { jobRecorder: deps.jobRecorder, userId, recommendationId: id },
        )

        const extra: Record<string, unknown> = { targetActions: result.targetActions }
        if (result.lidarrArtistId) extra.lidarrArtistId = result.lidarrArtistId
        if (result.lidarrError) extra.lidarrError = result.lidarrError
        await deps.updateRecommendationStatus(id, result.status, extra)
        results.push({ id, status: result.status })
        activity?.update({ current: results.length, message: `Sent ${rec.artist.name}` })
        // The Dashboard activity feed updates as each one lands, not all at the end.
        if (userId && activity) realtimeBroker.publish(userId, { type: 'activity-updated' })
        // One notification per approved item, same as the single-approve route --
        // a large "Approve All Above X%" batch will fan out into that many pings.
        if (result.status === 'added_to_lidarr' || result.status === 'add_failed') {
          void notifyRecommendationApproved(
            rec,
            rec.kind === 'album' ? (rec.recommendedReleaseGroupTitle ?? undefined) : undefined,
            result.status,
          )
        }
      }

      if (userId && results.length > 0) {
        realtimeBroker.publish(userId, { type: 'activity-updated' })
      }
      if (activity) {
        const failed = results.filter((r) => r.status === 'add_failed').length
        const sent = results.filter(
          (r) => r.status !== 'not_found' && r.status !== 'add_failed',
        ).length
        activity.done({
          current: undefined,
          total: undefined,
          resultSummary: failed > 0 ? `${sent} sent, ${failed} failed` : `${sent} sent to Lidarr`,
          resultHref: '/discover',
        })
      }
      return results
    }

    // A multi-item batch returns right away (202) and finishes in the
    // background -- no HTTP timeout on a big "approve all", and the activity
    // feed reports progress and refreshes the page as items land. A single
    // approve still answers with its result, which the UI reports directly.
    if (activity) {
      void runBatch().catch((err: unknown) => {
        console.error('[recommendations] bulk approve failed:', err)
        activity.fail(errMsg(err))
      })
      return c.json({ queued: ids.length, jobId: activity.id }, 202)
    }
    return c.json({ results: await runBatch() })
  })

  return router
}
