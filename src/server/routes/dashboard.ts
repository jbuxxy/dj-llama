import { Hono } from 'hono'
import { MIN_SAMPLES } from '@/core/listening/learn-weights'
import { KEEPER_DAYS, KEEPER_PLAYS, OUTCOME_WINDOW_DAYS } from '@/core/listening/outcomes'
import { getLearnedWeights, getOutcomeSummary, listByOutcome } from '@/db/queries/outcomes'
import type { AppDependencies } from '@/server'
import { parseOptionalClampedInt } from '@/server/helpers/parse-int-clamp'
import { apiError } from '@/server/helpers/problem'
import { resolveAdmin } from '@/server/middleware/admin-guard'
import type { HonoEnv } from '@/server/types'

export function dashboardRoutes(deps: AppDependencies) {
  const router = new Hono<HonoEnv>()

  router.get('/api/v1/dashboard/taste', async (c) => {
    const userId = c.get('userId')
    const taste = await deps.dashboardQueries.getTasteProfile(userId)
    return c.json(taste)
  })

  router.get('/api/v1/dashboard/genre-coverage', async (c) => {
    const userId = c.get('userId')
    const coverage = await deps.dashboardQueries.getLatestGenreCoverage(userId)
    return c.json(coverage)
  })

  router.get('/api/v1/dashboard/activity', async (c) => {
    const userId = c.get('userId')
    const limit = parseOptionalClampedInt(c.req.query('limit'), { min: 1, max: 20, default: 5 })
    if (limit == null) {
      return apiError(c, 400, 'limit must be an integer')
    }

    const isAdmin = await resolveAdmin(userId, deps.getUserById, c.get('legacyTokenAuth'))

    const activity = await deps.dashboardQueries.getRecentActivity(userId, isAdmin, limit)
    return c.json(activity)
  })

  // "Did it stick?" -- how this user's approvals turned out once they landed
  // in the library (core/listening/outcomes.ts), plus the learned weights.
  router.get('/api/v1/dashboard/outcomes', async (c) => {
    const userId = c.get('userId')
    if (userId == null) return apiError(c, 400, 'A user session is required')
    const [summary, keepers, unplayed, learned] = await Promise.all([
      getOutcomeSummary(deps.db, userId),
      listByOutcome(deps.db, userId, 'keeper'),
      listByOutcome(deps.db, userId, 'unplayed'),
      getLearnedWeights(deps.db, userId),
    ])
    const decided = summary.keepers + summary.tried + summary.unplayed
    return c.json({
      summary,
      hitRate: decided > 0 ? summary.keepers / decided : null,
      keepers,
      unplayed,
      learned,
      rules: {
        windowDays: OUTCOME_WINDOW_DAYS,
        keeperPlays: KEEPER_PLAYS,
        keeperDays: KEEPER_DAYS,
        minSamples: MIN_SAMPLES,
      },
    })
  })

  return router
}
