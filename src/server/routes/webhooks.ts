import { Hono } from 'hono'
import { realtimeBroker } from '@/core/realtime/broker'
import { recordPlexScrobble } from '@/db/queries/plex-scrobbles'
import { getUserByPlexAccountId } from '@/db/queries/users'
import type { AppDependencies } from '@/server'
import type { HonoEnv } from '@/server/types'

// Plex's webhook payload -- POSTed as multipart/form-data with a `payload`
// field containing this JSON (plus an optional `thumb` image part we ignore).
// Only the fields this handler actually reads are typed.
type PlexWebhookPayload = {
  event: string
  Account?: { id?: number }
  Metadata?: {
    type?: string
    title?: string
    grandparentTitle?: string
  }
}

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
 * Two event types handled:
 * - `media.scrobble` (a completed play), recorded as a push-based
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

      if (payload.event !== 'media.scrobble') return c.body(null, 200)
      if (payload.Metadata?.type !== 'track') return c.body(null, 200)

      const artistName = payload.Metadata.grandparentTitle
      const trackName = payload.Metadata.title
      if (!artistName || !trackName) return c.body(null, 200)

      await recordPlexScrobble(deps.db, {
        userId: user.id,
        artistName,
        trackName,
        playedAt: new Date(),
      })
      realtimeBroker.publish(user.id, { type: 'listening-updated' })
      return c.body(null, 200)
    } catch (err) {
      console.warn('[webhooks] Plex webhook failed:', err)
      return c.body(null, 200)
    }
  })

  return router
}
