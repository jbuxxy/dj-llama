import { gte, sql } from 'drizzle-orm'
import type { UsageRecord } from '@/core/providers/metered'
import { estimateCostUsd, type ModelPrice, priceFor } from '@/core/providers/pricing'
import type { Database } from '@/db'
import { aiUsage } from '@/db/schema'

export async function recordAiUsage(
  db: Database,
  record: UsageRecord,
  overrides?: Record<string, ModelPrice> | null,
): Promise<void> {
  const price = priceFor(record.provider, record.model, overrides)
  const costUsd = estimateCostUsd(
    price,
    { input: record.inputTokens, output: record.outputTokens, cached: record.cachedTokens },
    record.batch,
  )
  await db.insert(aiUsage).values({
    userId: record.userId ?? null,
    jobRunId: record.jobRunId ?? null,
    feature: record.feature,
    provider: record.provider,
    model: record.model,
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    cachedTokens: record.cachedTokens,
    batch: record.batch,
    costUsd,
  })
}

export function startOfMonth(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
}

/** Estimated spend since the start of this calendar month (UTC). */
export async function getMonthSpendUsd(db: Database, now = new Date()): Promise<number> {
  const [row] = await db
    .select({ usd: sql<number>`coalesce(sum(${aiUsage.costUsd}), 0)::float` })
    .from(aiUsage)
    .where(gte(aiUsage.createdAt, startOfMonth(now)))
  return row?.usd ?? 0
}

export type AiUsageSummary = {
  since: string
  totals: {
    calls: number
    inputTokens: number
    outputTokens: number
    cachedTokens: number
    costUsd: number
    /** Calls whose model had no known price (tokens recorded, cost unknown). */
    unpricedCalls: number
    batchSavingsUsd: number
  }
  byFeature: Array<{ feature: string; calls: number; costUsd: number; tokens: number }>
  byDay: Array<{ day: string; costUsd: number; calls: number }>
  byModel: Array<{ provider: string; model: string; calls: number; costUsd: number }>
}

export async function getAiUsageSummary(db: Database, since: Date): Promise<AiUsageSummary> {
  const where = gte(aiUsage.createdAt, since)
  const [totals] = await db
    .select({
      calls: sql<number>`count(*)::int`,
      inputTokens: sql<number>`coalesce(sum(${aiUsage.inputTokens}), 0)::float`,
      outputTokens: sql<number>`coalesce(sum(${aiUsage.outputTokens}), 0)::float`,
      cachedTokens: sql<number>`coalesce(sum(${aiUsage.cachedTokens}), 0)::float`,
      costUsd: sql<number>`coalesce(sum(${aiUsage.costUsd}), 0)::float`,
      unpricedCalls: sql<number>`count(*) filter (where ${aiUsage.costUsd} is null)::int`,
      // Batch rows are recorded at half price, so what they saved equals what they cost.
      batchSavingsUsd: sql<number>`coalesce(sum(${aiUsage.costUsd}) filter (where ${aiUsage.batch}), 0)::float`,
    })
    .from(aiUsage)
    .where(where)
  const byFeature = await db
    .select({
      feature: aiUsage.feature,
      calls: sql<number>`count(*)::int`,
      costUsd: sql<number>`coalesce(sum(${aiUsage.costUsd}), 0)::float`,
      tokens: sql<number>`coalesce(sum(${aiUsage.inputTokens} + ${aiUsage.outputTokens}), 0)::float`,
    })
    .from(aiUsage)
    .where(where)
    .groupBy(aiUsage.feature)
    .orderBy(sql`4 desc`)
  const day = sql<string>`to_char(date_trunc('day', ${aiUsage.createdAt} at time zone 'UTC'), 'YYYY-MM-DD')`
  const byDay = await db
    .select({
      day,
      costUsd: sql<number>`coalesce(sum(${aiUsage.costUsd}), 0)::float`,
      calls: sql<number>`count(*)::int`,
    })
    .from(aiUsage)
    .where(where)
    .groupBy(day)
    .orderBy(day)
  const byModel = await db
    .select({
      provider: aiUsage.provider,
      model: aiUsage.model,
      calls: sql<number>`count(*)::int`,
      costUsd: sql<number>`coalesce(sum(${aiUsage.costUsd}), 0)::float`,
    })
    .from(aiUsage)
    .where(where)
    .groupBy(aiUsage.provider, aiUsage.model)
    .orderBy(sql`4 desc`)
  return {
    since: since.toISOString(),
    totals: totals ?? {
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      costUsd: 0,
      unpricedCalls: 0,
      batchSavingsUsd: 0,
    },
    byFeature,
    byDay,
    byModel,
  }
}
