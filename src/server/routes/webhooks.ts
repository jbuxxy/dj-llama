import { Hono } from 'hono'
import { ListeningSessions, type PlexPlayEvent } from '@/core/listening/sessions'
import { realtimeBroker } from '@/core/realtime/broker'
import { recordListeningEvent } from '@/db/queries/listening-events'
import { getUserByPlexAccountId } from '@/db/queries/users'
import type { AppDependencies } from '@/server'
import type { HonoEnv } from '@/server/types'
import { clearListeningCache } from './listening'

// Plex's webhook payload -- POSTed as multipart/form-data with a `payload`
// field containing this JSON (plus an optional `thumb` image part we ignore).
// Only the fields this handler actually reads are typed.
type PlexWebhookPayload = {
  event: string
  Account?: { id?: number }
  Metadata?: {
    type?: string
    ratingKey?: string
    title?: string
    parentTitle?: string
    grandparentTitle?: string
    duration?: number
    viewOffset?: number
  }
}

const PLAY_EVENTS = new Set<string>([
  'media.play',
  'media.pause',
  'media.resume',
  'media.stop',
  'media.scrobble',
])

// One tracker for the process; it's keyed by Plex account, so users never mix.
const sessions = new ListeningSessions()

/**
 * Inbound webhook receiver for Plex's native "Webhooks" feature (Plex Pass
 * required on the Plex side). Unauthenticated -- Plex's webhook POSTs carry
 * no session/token DJ Llama would recognize, the same way an OAuth callback
 * redirect can't either. "Verified" here means every event is cross-checked
 * against a real registered user via the payload's plex.tv Account.id before
 * anything is recorded; an unmatched or malformed payload is silently
 * ignored (always 200, never leaks whether an account matched, never makes
 * Plex retry-storm on something we don't understand).
 *
 * Event types handled:
 * - `media.play` / `pause` / `resume` / `stop` / `scrobble`, fed through
 *   core/listening/sessions.ts so every play lands in listening_events as
 *   completed, partial or skipped (skips need the stop/next-play events --
 *   Plex only scrobbles past ~90%). Completed plays are a push-based
 *   alternative/supplement to the existing poll-based getRecentListening()
 *   -- see core/pipeline/collect-tracks.ts's collectRecentPlays, which
 *   prefers this cache for Plex when it has entries. Also broadcasts
 *   `listening-updated` over the realtime broker so an open dashboard tab's
 *   Listening History / Recently Played refresh within seconds instead of
 *   waiting on their 30s staleTime + a refocus.
 * - `library.new` (new media added to a library section), which triggers a
 *   debounced per-user library resync + fulfillment reconciliation (see
 *   index.ts's handleLibraryWebhookEvent) so requests/recommendations that
 *   just arrived get their "In Library" confirmation within seconds instead
 *   of waiting on the next periodic sync. Note: Plex's webhook feature has
 *   no equivalent event for *removed* media, so deletions still rely on the
 *   periodic library sync.
 *
 * No equivalent exists for other sources; those stay poll-based.
 */
export function webhookRoutes(deps: AppDependencies) {
  const router = new Hono<HonoEnv>()

  router.post('/api/v1/webhooks/plex', async (c) => {
    try {
      const body = await c.req.parseBody()
      const raw = body.payload
      if (typeof raw !== 'string') return c.body(null, 200)

      const payload = JSON.parse(raw) as PlexWebhookPayload

      const plexAccountId = payload.Account?.id
      if (typeof plexAccountId !== 'number') return c.body(null, 200)

      const user = await getUserByPlexAccountId(deps.db, plexAccountId)
      if (!user) return c.body(null, 200)

      if (payload.event === 'library.new') {
        deps.handleLibraryWebhookEvent?.(user.id)
        return c.body(null, 200)
      }

      if (!PLAY_EVENTS.has(payload.event)) return c.body(null, 200)
      const meta = payload.Metadata
      if (meta?.type !== 'track') return c.body(null, 200)

      const artistName = meta.grandparentTitle
      const trackName = meta.title
      if (!artistName || !trackName) return c.body(null, 200)

      const closed = sessions.handle(
        plexAccountId,
        payload.event as PlexPlayEvent,
        {
          // Without a ratingKey, name identity is the best session key we have.
          ratingKey: meta.ratingKey ?? `${artistName}\u0000${trackName}`,
          artistName,
          trackName,
          albumName: meta.parentTitle ?? null,
          durationMs: typeof meta.duration === 'number' ? meta.duration : null,
        },
        typeof meta.viewOffset === 'number' ? meta.viewOffset : null,
      )
      if (closed.length === 0) return c.body(null, 200)

      for (const play of closed) {
        await recordListeningEvent(deps.db, {
          userId: user.id,
          ratingKey: play.ratingKey.includes('\u0000') ? null : play.ratingKey,
          artistName: play.artistName,
          trackName: play.trackName,
          albumName: play.albumName ?? null,
          durationMs: play.durationMs ?? null,
          listenedMs: play.listenedMs,
          completed: play.completed,
          skipped: play.skipped,
          source: 'webhook',
          playedAt: play.playedAt,
        })
      }
      if (closed.some((p) => p.completed)) {
        clearListeningCache(user.id)
        realtimeBroker.publish(user.id, { type: 'listening-updated' })
      }
      return c.body(null, 200)
    } catch (err) {
      console.warn('[webhooks] Plex webhook failed:', err)
      return c.body(null, 200)
    }
  })

  return router
}
