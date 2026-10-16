import { Hono } from 'hono'
import { deleteOAuthToken, getOAuthToken } from '@/db/queries/oauth-tokens'
import type { AppDependencies } from '@/server'
import { oauthInitiateSchema } from '@/server/schemas/oauth'
import { zJson } from '@/server/schemas/validator'
import type { HonoEnv } from '@/server/types'

export function oauthRoutes(deps: AppDependencies) {
  const router = new Hono<HonoEnv>()

  router.post('/api/v1/auth/oauth/:provider/initiate', zJson(oauthInitiateSchema), async (c) => {
    const provider = c.req.param('provider')
    const userId = c.get('userId')
    if (!userId) return c.json({ error: 'Authentication required' }, 401)

    return c.json({ error: `Unknown OAuth provider: ${provider}` }, 400)
  })

  router.get('/api/v1/auth/oauth/:provider/callback', async (c) => {
    const code = c.req.query('code')
    const state = c.req.query('state')
    const error = c.req.query('error') ?? c.req.query('error_reason')

    if (error) {
      return c.redirect(`/settings?oauth_error=${encodeURIComponent(error)}`)
    }

    if (!code || !state) {
      return c.redirect('/settings?oauth_error=missing_code_or_state')
    }

    return c.redirect('/settings?oauth_error=unknown_provider')
  })

  router.delete('/api/v1/auth/oauth/:provider', async (c) => {
    const provider = c.req.param('provider')
    const userId = c.get('userId')
    if (!userId) return c.json({ error: 'Authentication required' }, 401)

    await deleteOAuthToken(deps.db, userId, provider)
    return c.body(null, 204)
  })

  router.get('/api/v1/auth/oauth/:provider/status', async (c) => {
    const provider = c.req.param('provider')
    const userId = c.get('userId')
    if (!userId) return c.json({ error: 'Authentication required' }, 401)

    const token = await getOAuthToken(deps.db, userId, provider)
    const connected = !!token && !token.accessToken.startsWith('pending:')
    return c.json({
      connected,
      scopes: connected ? token?.scopes : null,
      expiresAt: connected ? token?.expiresAt : null,
      accountLabel: connected ? (token?.accountLabel ?? null) : null,
      accountTier: connected ? (token?.accountTier ?? null) : null,
    })
  })

  return router
}
