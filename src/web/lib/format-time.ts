export function formatDuration(ms: number | null): string {
  if (ms === null || ms === 0) return '-'
  if (ms < 1000) return `${ms}ms`
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`
}

export function formatRelativeTime(iso: string | Date | null, fallback = '-'): string {
  if (!iso) return fallback
  const diffMinutes = Math.round((new Date(iso).getTime() - Date.now()) / 60_000)
  const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
  if (Math.abs(diffMinutes) < 1) return formatter.format(0, 'second')
  if (Math.abs(diffMinutes) < 60) return formatter.format(diffMinutes, 'minute')
  const diffHours = Math.round(diffMinutes / 60)
  if (Math.abs(diffHours) < 24) return formatter.format(diffHours, 'hour')
  return formatter.format(Math.round(diffHours / 24), 'day')
}

/** "42s", "3m 05s", "1h 07m". */
export function formatElapsedSeconds(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds))
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  if (m === 0) return `${s}s`
  if (m < 60) return `${m}m ${s.toString().padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${(m % 60).toString().padStart(2, '0')}m`
}
