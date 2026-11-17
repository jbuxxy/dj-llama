import { Hono } from 'hono'
import { isPrivateUrl } from '@/core/validation'
import type { AppDependencies } from '@/server'
import { apiError } from '@/server/helpers/problem'

const ALLOWED_HOSTS = new Set(['img.theaudiodb.com', 'theaudiodb.com', 'www.theaudiodb.com'])

export function mediaRoutes(deps: AppDependencies) {
  const router = new Hono()

  router.get('/api/v1/media/image-proxy', async (c) => {
    const settings = await deps.getSettings()
    if (!settings?.audiodbProxyImages) {
      return apiError(c, 404, 'Not found')
    }

    const src = c.req.query('src')
    if (!src) return apiError(c, 400, 'Missing src')

    let url: URL
    try {
      url = new URL(src)
    } catch {
      return apiError(c, 400, 'Invalid src URL')
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return apiError(c, 400, 'Only http/https supported')
    }
    if (!ALLOWED_HOSTS.has(url.hostname)) {
      return apiError(c, 400, 'Host not permitted')
    }
    if (isPrivateUrl(url.href)) {
      return apiError(c, 400, 'Private address rejected')
    }

    try {
      // The 10s limit covers getting the response headers only; the body is
      // streamed to the client afterwards and may legitimately take longer.
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 10_000)
      const upstream = await fetch(url.href, {
        redirect: 'manual',
        signal: controller.signal,
      }).finally(() => clearTimeout(timer))
      if (!upstream.ok) return apiError(c, 502, 'Upstream fetch failed')
      const contentType = upstream.headers.get('content-type') ?? 'application/octet-stream'
      if (!contentType.startsWith('image/')) {
        return apiError(c, 502, 'Non-image content-type')
      }
      return new Response(upstream.body, {
        status: 200,
        headers: {
          'content-type': contentType,
          'cache-control': 'public, max-age=86400',
        },
      })
    } catch {
      return apiError(c, 502, 'Upstream fetch failed')
    }
  })

  return router
}
