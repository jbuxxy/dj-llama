// @vitest-environment node
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { realtimeBroker } from '@/core/realtime/broker'
import { realtimeRoutes } from '@/server/routes/realtime'
import type { HonoEnv } from '@/server/types'

function makeApp(userId?: number) {
  const app = new Hono<HonoEnv>()
  app.use('*', async (c, next) => {
    if (userId !== undefined) c.set('userId', userId)
    await next()
  })
  app.route('/', realtimeRoutes())
  return app
}

async function readFrame(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const { value } = await reader.read()
  return new TextDecoder().decode(value)
}

describe('GET /api/v1/realtime/events', () => {
  it('requires authentication', async () => {
    const app = makeApp()
    const res = await app.request('/api/v1/realtime/events')
    expect(res.status).toBe(401)
  })

  it('opens an event-stream response with the expected headers for an authenticated user', async () => {
    const app = makeApp(1)
    const res = await app.request('/api/v1/realtime/events')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    expect(res.headers.get('cache-control')).toBe('no-cache')
    expect(res.headers.get('connection')).toBe('keep-alive')

    const reader = res.body?.getReader()
    if (!reader) throw new Error('missing body reader')
    const first = await readFrame(reader)
    expect(first.startsWith('retry: ')).toBe(true)
    await reader.cancel()
  })

  it('streams events published on the broker for that user, scoped to their own id', async () => {
    const app = makeApp(42)
    const res = await app.request('/api/v1/realtime/events')
    const reader = res.body?.getReader()
    if (!reader) throw new Error('missing body reader')
    await readFrame(reader) // retry frame

    realtimeBroker.publish(99, { type: 'library-updated' }) // different user - must not appear
    realtimeBroker.publish(42, { type: 'library-updated' })

    const frame = await readFrame(reader)
    expect(frame).toContain('id: 1')
    expect(frame).toContain(JSON.stringify({ type: 'library-updated' }))

    await reader.cancel()
  })
})
