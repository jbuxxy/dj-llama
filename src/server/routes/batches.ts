import { Hono } from 'hono'
import type { AppDependencies } from '@/server'
import { readPagination } from '@/server/helpers/pagination'
import { encodeCursor } from '@/server/helpers/pagination-cursor'
import { parsePositiveIntParam } from '@/server/helpers/parse-int-clamp'
import { apiError } from '@/server/helpers/problem'
import { adminGuard } from '@/server/middleware/admin-guard'

export function batchRoutes(deps: AppDependencies) {
  const router = new Hono()

  router.get('/api/v1/batches', adminGuard(deps.getUserById), async (c) => {
    const page = readPagination(c)
    if (page === null) {
      const batches = await deps.listBatches()
      return c.json(batches)
    }
    const rows = await deps.listBatches({ limit: page.limit + 1, cursor: page.cursor })
    const hasMore = rows.length > page.limit
    const data = hasMore ? rows.slice(0, page.limit) : rows
    const last = data[data.length - 1]
    const nextCursor =
      hasMore && last ? encodeCursor({ id: last.id, ts: last.createdAt.toISOString() }) : null
    return c.json({ data, meta: { limit: page.limit, nextCursor } })
  })

  router.get('/api/v1/batches/:id', adminGuard(deps.getUserById), async (c) => {
    const id = parsePositiveIntParam(c.req.param('id'))
    if (id == null) return apiError(c, 400, 'Invalid batch ID')
    const batch = await deps.getBatch(id)
    if (!batch) {
      return apiError(c, 404, 'Batch not found')
    }
    return c.json(batch)
  })

  return router
}
