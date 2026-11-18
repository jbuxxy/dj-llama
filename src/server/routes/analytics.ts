import { Hono } from 'hono'
import { getAiUsageSummary, getMonthSpendUsd, startOfMonth } from '@/db/queries/ai-usage'
import {
  getApprovalTrend,
  getBatchesWithCounts,
  getOverviewStats,
  getTopGenres,
} from '@/db/queries/analytics'
import type { AppDependencies } from '@/server'
import { readPagination } from '@/server/helpers/pagination'
import { encodeCursor } from '@/server/helpers/pagination-cursor'
import { parseOptionalClampedInt } from '@/server/helpers/parse-int-clamp'
import { apiError } from '@/server/helpers/problem'

export function analyticsRoutes(deps: AppDependencies) {
  const router = new Hono()

  router.get('/api/v1/analytics/overview', async (c) => {
    const stats = await getOverviewStats(deps.db)
    return c.json(stats)
  })

  router.get('/api/v1/analytics/batches', async (c) => {
    const page = readPagination(c)
    if (page === null) {
      const batches = await getBatchesWithCounts(deps.db)
      return c.json(batches)
    }
    const rows = await getBatchesWithCounts(deps.db, {
      limit: page.limit + 1,
      cursor: page.cursor,
    })
    const hasMore = rows.length > page.limit
    const data = hasMore ? rows.slice(0, page.limit) : rows
    const last = data[data.length - 1]
    const nextCursor = hasMore && last ? encodeCursor({ id: last.id, ts: last.createdAt }) : null
    return c.json({ data, meta: { limit: page.limit, nextCursor } })
  })

  router.get('/api/v1/analytics/genres', async (c) => {
    const genres = await getTopGenres(deps.db)
    return c.json(genres)
  })

  // AI usage dashboard: spend over the last `days` days, plus this month's
  // spend against the budget (Settings > Analytics > AI usage).
  router.get('/api/v1/analytics/ai-usage', async (c) => {
    const days = parseOptionalClampedInt(c.req.query('days'), { min: 1, max: 365, default: 30 })
    if (days == null) return apiError(c, 400, 'days must be an integer')
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    const [summary, monthSpendUsd, settings] = await Promise.all([
      getAiUsageSummary(deps.db, since),
      getMonthSpendUsd(deps.db),
      deps.getSettings(),
    ])
    const prefs = settings?.preferences as
      | { aiMonthlyBudgetUsd?: number; aiPricingOverrides?: Record<string, unknown> }
      | null
      | undefined
    return c.json({
      ...summary,
      days,
      month: {
        since: startOfMonth().toISOString(),
        spentUsd: monthSpendUsd,
        budgetUsd: prefs?.aiMonthlyBudgetUsd ?? null,
      },
    })
  })

  router.get('/api/v1/analytics/trend', async (c) => {
    const trend = await getApprovalTrend(deps.db)
    return c.json(trend)
  })

  return router
}
