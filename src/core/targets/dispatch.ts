// One path for sending an artist or album to the destination targets
// (Lidarr today). Manual approve, bulk approve, auto-approve, requests and
// playlist-import auto-requests all go through dispatchToTargets, so job
// recording and the resulting recommendation status follow one rule.

import { recordFailureSafely } from '@/core/jobs/record-failure-safely'
import type { JobRecorder } from '@/core/jobs/types'
import type { DestinationTarget, TargetAddOptions, TargetType } from './types'

export type DispatchItem =
  | { kind: 'artist'; mbid: string; name: string }
  | { kind: 'album'; artistMbid: string; artistName: string; releaseGroupMbid: string }

export type TargetAction = {
  status: 'added' | 'queued' | 'failed'
  externalId?: number | string
  error?: string
  warning?: string
}

export type DispatchStatus = 'added_to_lidarr' | 'approved' | 'add_failed'

export type DispatchResult = {
  status: DispatchStatus
  targetActions: Record<string, TargetAction>
  /** Lidarr's artist id from an artist add; album adds return an album id, kept in targetActions. */
  lidarrArtistId?: number | string
  lidarrError?: string
}

type DispatchContext = {
  jobRecorder?: JobRecorder
  userId?: number
  recommendationId?: number
}

/** The target type that owns the library -- its outcome decides the status. */
const LIBRARY_TARGET_TYPE: TargetType = 'lidarr'

export function isTargetSuccess(action: { status?: string } | null | undefined): boolean {
  return action?.status === 'added' || action?.status === 'queued'
}

/**
 * The status a recommendation lands in, from the outcome of every target it
 * was sent to (prior attempts merged with this one):
 * - a library target was involved: its outcome decides (added or failed);
 * - otherwise any success means 'approved', none means 'add_failed'.
 *
 * `targetTypeOf` maps a stored target id to its type; stored ids outlive the
 * targets that wrote them, so it may return undefined.
 */
export function deriveDispatchStatus(
  actions: Record<string, { status?: string } | null | undefined>,
  targetTypeOf: (id: string) => TargetType | undefined,
): DispatchStatus {
  const entries = Object.entries(actions)
  const library = entries.filter(([id]) => targetTypeOf(id) === LIBRARY_TARGET_TYPE)
  if (library.length > 0) {
    return library.some(([, a]) => isTargetSuccess(a)) ? 'added_to_lidarr' : 'add_failed'
  }
  return entries.some(([, a]) => isTargetSuccess(a)) ? 'approved' : 'add_failed'
}

/** Resolves a target id to its type, preferring the live targets over the id's prefix. */
export function targetTypeResolver(
  targets: ReadonlyArray<Pick<DestinationTarget, 'id' | 'type'>>,
): (id: string) => TargetType | undefined {
  const byId = new Map(targets.map((t) => [t.id, t.type]))
  return (id) => byId.get(id) ?? (id.startsWith(`${LIBRARY_TARGET_TYPE}-`) ? 'lidarr' : undefined)
}

function itemLabel(item: DispatchItem) {
  return item.kind === 'artist'
    ? { artistName: item.name, mbid: item.mbid, action: 'add' }
    : {
        artistName: item.artistName,
        mbid: item.artistMbid,
        releaseGroupMbid: item.releaseGroupMbid,
        action: 'addAlbum',
      }
}

/**
 * Sends one item to every enabled target that can take it, recording a
 * `target` job per attempt. With no capable target, an artist is simply
 * 'approved' (discovery only) while an album is 'add_failed' -- an album
 * pick exists to be downloaded.
 */
export async function dispatchToTargets(
  item: DispatchItem,
  targets: DestinationTarget[],
  addOptions: TargetAddOptions,
  ctx: DispatchContext = {},
): Promise<DispatchResult> {
  const capability = item.kind === 'artist' ? 'addArtist' : 'addAlbum'
  const capable = targets.filter((t) => t.capabilities?.includes(capability))
  if (capable.length === 0) {
    return { status: item.kind === 'artist' ? 'approved' : 'add_failed', targetActions: {} }
  }

  const { jobRecorder, userId, recommendationId } = ctx
  const options: TargetAddOptions = { ...addOptions, userId, recommendationId }
  const label = itemLabel(item)
  const targetActions: Record<string, TargetAction> = {}
  let lidarrArtistId: number | string | undefined
  let lidarrError: string | undefined

  for (const target of capable) {
    const jobId = jobRecorder
      ? await jobRecorder.start({
          type: 'target',
          userId,
          metadata: {
            targetType: target.type,
            ...label,
            ...(options.monitorOption ? { monitorOption: options.monitorOption } : {}),
            ...(options.selectedAlbumIds?.length
              ? { selectedAlbumIds: options.selectedAlbumIds }
              : {}),
          },
        })
      : null

    const result =
      item.kind === 'artist'
        ? await target.addArtist?.({ mbid: item.mbid, name: item.name }, options)
        : await target.addAlbum?.(
            {
              artistMbid: item.artistMbid,
              artistName: item.artistName,
              releaseGroupMbid: item.releaseGroupMbid,
            },
            options,
          )

    if (!result) {
      if (jobId != null && jobRecorder) {
        await jobRecorder.complete(jobId, {
          metadata: { targetType: target.type, artistName: label.artistName, skipped: true },
        })
      }
      continue
    }

    if (jobId != null && jobRecorder) {
      if (result.success) {
        await jobRecorder.complete(jobId, {
          metadata: {
            targetType: target.type,
            artistName: label.artistName,
            externalId: result.externalId,
          },
        })
      } else {
        await recordFailureSafely(jobRecorder, jobId, result.error ?? 'Target returned failure')
      }
    }

    targetActions[target.id] = {
      status: result.success ? 'added' : 'failed',
      externalId: result.externalId,
      error: result.error,
      ...(result.warning ? { warning: result.warning } : {}),
    }
    if (target.type === LIBRARY_TARGET_TYPE) {
      if (result.success && item.kind === 'artist') lidarrArtistId = result.externalId
      if (result.error) lidarrError = result.error
    }
  }

  return {
    status: deriveDispatchStatus(targetActions, targetTypeResolver(capable)),
    targetActions,
    lidarrArtistId,
    lidarrError,
  }
}
