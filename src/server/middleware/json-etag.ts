import type { Context, Next } from 'hono'
import { etag } from 'hono/etag'

// hono's etag() hashes the whole response body, which would never finish
// for an SSE stream and would buffer large downloads. Only apply it to
// fully-buffered JSON / HTML GET responses.
const ETAG_TYPES = /^\s*(?:application\/(?:json|problem\+json)|text\/html)\b/i
const inner = etag()
const noop = async () => {}

export async function jsonEtag(c: Context, next: Next): Promise<void> {
  await next()
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return
  const type = c.res.headers.get('Content-Type')
  if (!type || !ETAG_TYPES.test(type)) return
  // Already encoded (precompressed static file) -- its bytes differ per
  // encoding, so leave validation to Last-Modified.
  if (c.res.headers.has('Content-Encoding')) return
  await inner(c, noop)
}
