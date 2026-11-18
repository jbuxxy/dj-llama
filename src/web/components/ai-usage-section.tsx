import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import { type AiUsageReport, getAiUsage, updateSettings } from '../lib/api'
import { formatShortDate } from '../lib/intl'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Skeleton } from './ui/skeleton'

const FEATURE_LABEL: Record<string, string> = {
  pipeline_artists: 'Scans: artists',
  pipeline_tracks: 'Scans: tracks',
  quick_discover: 'Quick discover',
  album_resolve: 'Album matching',
  mood: 'Mood search',
  playlist: 'Playlists',
  taste_title: 'Taste profile',
  embedding: 'Embeddings',
  other: 'Other',
}

export function usd(v: number): string {
  if (v === 0) return '$0'
  if (v < 0.01) return '<$0.01'
  return `$${v.toFixed(v < 10 ? 2 : 0)}`
}

function compact(n: number): string {
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(
    n,
  )
}

// Settings > Analytics > AI usage: what the AI calls cost, by day and by
// feature, and this month's spend against the optional budget.
export function AiUsageSection() {
  const { data, isLoading } = useQuery({
    queryKey: ['analytics', 'ai-usage', 30],
    queryFn: () => getAiUsage(30),
  })

  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold text-text uppercase tracking-wide">AI Usage</h2>
      <p className="text-xs text-muted -mt-2">
        Estimated from token counts and list prices; your provider's bill is the source of truth.
      </p>
      {isLoading || !data ? (
        <div className="bg-surface border border-border rounded-lg p-4 space-y-3">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : (
        <div className="bg-surface border border-border rounded-lg p-4 space-y-5">
          <BudgetMeter month={data.month} />
          {data.totals.calls === 0 ? (
            <p className="text-sm text-muted">No AI calls recorded in the last {data.days} days.</p>
          ) : (
            <>
              <Totals data={data} />
              <DailySpend days={data.byDay} windowDays={data.days} />
              <FeatureBreakdown rows={data.byFeature} />
            </>
          )}
        </div>
      )}
    </div>
  )
}

function BudgetMeter({ month }: { month: AiUsageReport['month'] }) {
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(month.budgetUsd ? String(month.budgetUsd) : '')
  const [saving, setSaving] = useState(false)
  const budget = month.budgetUsd && month.budgetUsd > 0 ? month.budgetUsd : null
  const share = budget ? Math.min(1, month.spentUsd / budget) : 0
  const over = budget != null && month.spentUsd >= budget

  async function save() {
    const n = value.trim() === '' ? 0 : Number(value)
    if (!Number.isFinite(n) || n < 0) {
      toast.error('Enter a dollar amount, or leave it empty for no limit')
      return
    }
    setSaving(true)
    try {
      await updateSettings({ preferences: { aiMonthlyBudgetUsd: n } })
      await queryClient.invalidateQueries({ queryKey: ['analytics', 'ai-usage'] })
      toast.success(n > 0 ? `Monthly AI budget set to ${usd(n)}` : 'Monthly AI budget removed')
      setEditing(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save budget')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-3xl font-semibold text-text tabular-nums">{usd(month.spentUsd)}</p>
          <p className="text-xs text-muted">
            this month{budget ? ` of ${usd(budget)} budget` : ' (no budget set)'}
          </p>
        </div>
        {editing ? (
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted">$</span>
            <Input
              type="number"
              min={0}
              step="1"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="No limit"
              className="w-24 text-right"
              aria-label="Monthly AI budget in dollars"
            />
            <Button size="sm" onClick={save} disabled={saving}>
              {saving ? 'Saving...' : 'Save'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
            {budget ? 'Change budget' : 'Set budget'}
          </Button>
        )}
      </div>
      {budget && (
        <>
          <div
            className="h-2 bg-bg rounded-full overflow-hidden"
            // The figure above states spend and budget as text; the bar is decoration.
            aria-hidden="true"
          >
            <div
              className={`h-full rounded-full ${over ? 'bg-warning' : 'bg-accent'}`}
              style={{ width: `${Math.max(share * 100, 1)}%` }}
            />
          </div>
          {over && (
            <p className="text-xs text-text">
              <span aria-hidden="true">⚠ </span>Budget reached: scheduled scans are paused and AI
              features are off until next month, or until you raise the budget.
            </p>
          )}
        </>
      )}
    </div>
  )
}

function Totals({ data }: { data: AiUsageReport }) {
  const t = data.totals
  const cacheShare = t.inputTokens > 0 ? t.cachedTokens / t.inputTokens : 0
  return (
    <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
      <Stat label={`Last ${data.days} days`} value={usd(t.costUsd)} />
      <Stat label="AI calls" value={compact(t.calls)} />
      <Stat
        label="Tokens in / out"
        value={`${compact(t.inputTokens)} / ${compact(t.outputTokens)}`}
      />
      <Stat label="From prompt cache" value={`${Math.round(cacheShare * 100)}%`} />
      {t.batchSavingsUsd > 0 && <Stat label="Saved by batch mode" value={usd(t.batchSavingsUsd)} />}
      {t.unpricedCalls > 0 && (
        <p className="col-span-full text-muted">
          {t.unpricedCalls} call{t.unpricedCalls === 1 ? '' : 's'} used a model with no known price,
          so the total is low.
        </p>
      )}
    </dl>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted">{label}</dt>
      <dd className="text-sm font-medium text-text tabular-nums">{value}</dd>
    </div>
  )
}

// One column per day in the window (zero-filled), single hue, value on hover.
function DailySpend({ days, windowDays }: { days: AiUsageReport['byDay']; windowDays: number }) {
  const byKey = new Map(days.map((d) => [d.day, d]))
  const series: Array<{ day: string; costUsd: number; calls: number }> = []
  const today = new Date()
  for (let i = windowDays - 1; i >= 0; i--) {
    const d = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i),
    )
    const key = d.toISOString().slice(0, 10)
    series.push(byKey.get(key) ?? { day: key, costUsd: 0, calls: 0 })
  }
  const max = Math.max(...series.map((d) => d.costUsd), 0.0001)
  const [hover, setHover] = useState<number | null>(null)
  const active = hover != null ? series[hover] : null
  const first = series[0]
  const last = series[series.length - 1]

  return (
    <div>
      <div className="flex items-baseline justify-between mb-2">
        <p className="text-xs font-medium text-muted">Spend per day</p>
        <p className="text-xs text-text tabular-nums min-h-4" aria-live="polite">
          {active
            ? `${formatShortDate(`${active.day}T12:00:00Z`)}: ${usd(active.costUsd)} · ${active.calls} call${active.calls === 1 ? '' : 's'}`
            : ''}
        </p>
      </div>
      <div className="flex items-end gap-[2px] h-20">
        {series.map((d, i) => (
          <button
            type="button"
            key={d.day}
            className="flex-1 h-full flex flex-col justify-end focus:outline-none group"
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
            onFocus={() => setHover(i)}
            onBlur={() => setHover(null)}
            aria-label={`${d.day}: ${usd(d.costUsd)}, ${d.calls} calls`}
          >
            <span
              className={`block w-full rounded-t-[4px] ${hover === i ? 'bg-accent' : 'bg-accent/70'} group-focus-visible:ring-2 group-focus-visible:ring-accent`}
              style={{ height: d.costUsd > 0 ? `${Math.max((d.costUsd / max) * 100, 3)}%` : '1px' }}
            />
          </button>
        ))}
      </div>
      <div className="flex justify-between mt-1 text-micro text-muted">
        <span>{first ? formatShortDate(`${first.day}T12:00:00Z`) : ''}</span>
        <span>{last ? formatShortDate(`${last.day}T12:00:00Z`) : ''}</span>
      </div>
    </div>
  )
}

// Ranked horizontal bars: one hue, label and value as text beside the bar.
function FeatureBreakdown({ rows }: { rows: AiUsageReport['byFeature'] }) {
  const max = Math.max(...rows.map((r) => r.costUsd), 0.0001)
  return (
    <div>
      <p className="text-xs font-medium text-muted mb-2">By feature</p>
      <ul className="space-y-2">
        {rows.map((r) => (
          <li key={r.feature}>
            <div className="flex items-center justify-between text-xs mb-1">
              <span className="text-text truncate">{FEATURE_LABEL[r.feature] ?? r.feature}</span>
              <span className="text-muted shrink-0 ml-2 tabular-nums">
                {usd(r.costUsd)} · {compact(r.calls)} call{r.calls === 1 ? '' : 's'}
              </span>
            </div>
            <div className="h-2 bg-bg rounded-full overflow-hidden">
              <div
                className="h-full bg-accent rounded-full"
                style={{ width: `${Math.max((r.costUsd / max) * 100, 1)}%` }}
              />
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
