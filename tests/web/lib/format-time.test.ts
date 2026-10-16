import { describe, expect, it, vi } from 'vitest'
import { formatRelativeTime } from '@/web/lib/format-time'

describe('formatRelativeTime', () => {
  it('formats past timestamps as English relative time', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-12T10:00:00.000Z'))

    expect(formatRelativeTime('2026-04-12T08:00:00.000Z')).toBe('2 hours ago')
  })

  it('returns the fallback for missing timestamps', () => {
    expect(formatRelativeTime(null)).toBe('-')
  })
})
