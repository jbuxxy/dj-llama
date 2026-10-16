import { formatShortDate } from './intl'
import { describeSchedule } from './schedule'

export function formatSchedule(cron: string | null): string {
  if (!cron) return 'Manual'
  return describeSchedule(cron)
}

export function formatPlaylistRelativeTime(dateStr: string | null, neverLabel: string): string {
  if (!dateStr) return neverLabel
  const date = new Date(dateStr)
  const diffMinutes = Math.round((Date.now() - date.getTime()) / 60_000)
  const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
  if (Math.abs(diffMinutes) < 1) return formatter.format(0, 'second')
  if (Math.abs(diffMinutes) < 60) return formatter.format(-diffMinutes, 'minute')
  const diffHours = Math.round(diffMinutes / 60)
  if (Math.abs(diffHours) < 24) return formatter.format(-diffHours, 'hour')
  const diffDays = Math.round(diffHours / 24)
  if (Math.abs(diffDays) < 30) return formatter.format(-diffDays, 'day')
  return formatShortDate(date)
}

export const STRATEGY_BADGES: Record<string, { label: string; className: string }> = {
  weekly_digest: {
    label: 'Weekly Digest',
    className: 'bg-blue-500/15 text-blue-400',
  },
  genre_focus: {
    label: 'Genre Focus',
    className: 'bg-green-500/15 text-green-400',
  },
  mood_mix: { label: 'Mood Mix', className: 'bg-purple-500/15 text-purple-400' },
  rediscover: { label: 'Rediscover', className: 'bg-amber-500/15 text-amber-400' },
}

export function strategyBadge(strategy: string): { label: string; className: string } {
  return STRATEGY_BADGES[strategy] ?? { label: strategy, className: 'bg-accent/15 text-accent' }
}

export const STATUS_BADGES: Record<string, { label: string; className: string }> = {
  pending_review: {
    label: 'Pending review',
    className: 'bg-amber-500/15 text-amber-400',
  },
  expired: { label: 'Expired', className: 'bg-muted/20 text-muted' },
}
