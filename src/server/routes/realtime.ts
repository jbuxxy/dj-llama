import { Hono } from 'hono'
import { notAuthenticated } from '@/server/helpers/auth-problems'
import { createRealtimeSSEStream } from '@/server/sse'
import type { HonoEnv } from '@/server/types'

/**
 * Per-user push channel for library/request/recommendation status changes
 * (see core/realtime/broker.ts) -- the Plex library.new webhook, missing-
 * playlist-track auto-requests, and fulfillment reconciliation all publish
 * here so an open browser tab updates within seconds instead of waiting on
 * its next refetch.
 */
export function realtimeRoutes() {
  const router = new Hono<HonoEnv>()

  router.get('/api/v1/realtime/events', (c) => {
    const userId = c.get('userId')
    if (!userId) return notAuthenticated(c)

    const stream = createRealtimeSSEStream(userId)
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    })
  })

  return router
}
