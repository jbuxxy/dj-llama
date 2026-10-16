import { Cron } from 'croner'
import { isMaintenance } from '@/core/ops/maintenance'
import type { SyncOrchestrator } from './sync'

export type LibrarySchedulerDeps = {
  intervalHours: number
  orchestrator: SyncOrchestrator
  listUserIds: () => Promise<number[]>
  // Re-checks this user's pending/dispatched requests and added_to_lidarr
  // recommendations against the library rows the sync above just refreshed,
  // stamping libraryConfirmedAt on anything that's now actually present.
  // Previously this only ever ran from the Plex webhook path (which needs
  // Plex Pass), so an admin without it -- or whose library grew via a plain
  // Lidarr download rather than a Plex scan -- never got "in library"
  // reflected on their requests page. Optional so tests/callers that don't
  // care about fulfillment tracking don't need to stub it.
  reconcileFulfillment?: (userId: number) => Promise<void>
}

/**
 * Build a cron pattern from an integer-hours interval.
 *
 * - < 1h → fall back to every-5-minutes (defensive; settings stores integer hours)
 * - 1-23h → "at minute 0 of every N hours" (`0 * / N * * *`)
 * - >= 24h → capped to 23h (croner rejects step values >= 24 in the hours field)
 */
function buildCronPattern(intervalHours: number): string {
  if (intervalHours < 1) return '*/5 * * * *'
  const hours = Math.min(23, Math.round(intervalHours))
  return `0 */${hours} * * *`
}

/**
 * Background library sync scheduler. Joins the existing schedulers
 * (pipeline, subscription, playlist, stuck detector) in src/index.ts.
 *
 * Each tick:
 *  1. syncGlobal() once (handles Lidarr)
 *  2. syncForUser(uid) for each user (handles Plex/Jellyfin)
 *
 * Per-source coalescing in the orchestrator gracefully skips fresh sources,
 * so a tick is cheap when nothing is stale.
 *
 * The interval is captured at construction time; runtime settings changes
 * require a restart to take effect. This matches the other schedulers in the
 * codebase (SubscriptionScheduler, PlaylistScheduler).
 */
export function startLibrarySyncScheduler(deps: LibrarySchedulerDeps): Cron {
  const pattern = buildCronPattern(deps.intervalHours)
  console.log(
    `[library-sync-scheduler] started, interval=${deps.intervalHours}h, pattern="${pattern}"`,
  )
  const cron = new Cron(pattern, async () => {
    if (isMaintenance()) {
      console.log('[library-sync-scheduler] tick skipped: maintenance in progress')
      return
    }
    try {
      await deps.orchestrator.syncGlobal()
      const users = await deps.listUserIds()
      for (const uid of users) {
        await deps.orchestrator.syncForUser(uid)
        try {
          await deps.reconcileFulfillment?.(uid)
        } catch (err: unknown) {
          console.error(
            `[library-sync-scheduler] fulfillment reconciliation failed for user ${uid}:`,
            err,
          )
        }
      }
    } catch (err: unknown) {
      console.error('[library-sync-scheduler] tick failed:', err)
    }
  })
  return cron
}
