import { describe, expect, it } from 'vitest'
import { buildCron, describeSchedule, nextRun, parseSchedule } from '@/web/lib/schedule'

describe('parseSchedule / buildCron', () => {
  it.each(['30 6 * * *', '0 8 * * 1,4', '0 8 1,15 * *', '0 * * * *', '0 */6 * * *'])(
    'round-trips %s',
    (cron) => {
      expect(buildCron(parseSchedule(cron))).toBe(cron)
    },
  )

  it('keeps shapes the friendly UI cannot represent as custom', () => {
    for (const cron of ['0 9 * * 1-5', '*/15 * * * *', '0 8 1 * 1', '0 8 * 1 *', '0 */5 * * *']) {
      expect(parseSchedule(cron)).toEqual({ kind: 'custom', cron })
    }
  })

  it('treats day-of-week 7 as Sunday', () => {
    expect(parseSchedule('0 8 * * 7')).toEqual({ kind: 'weekly', time: '08:00', weekDays: [0] })
  })

  it('returns null for incomplete or invalid schedules', () => {
    expect(buildCron({ kind: 'weekly', time: '08:00', weekDays: [] })).toBeNull()
    expect(buildCron({ kind: 'custom', cron: 'not a cron' })).toBeNull()
  })
})

describe('describeSchedule', () => {
  it.each([
    ['0 0 * * *', 'Every day at 12:00 AM'],
    ['0 6 * * 1', 'Every Monday at 6:00 AM'],
    ['0 8 * * 1,4', 'Mondays and Thursdays at 8:00 AM'],
    ['0 8 * * 1,2,3,4,5', 'Weekdays at 8:00 AM'],
    ['0 8 * * 0,6', 'Weekends at 8:00 AM'],
    ['0 8 1,15 * *', 'Monthly on the 1st and 15th at 8:00 AM'],
    ['0 */6 * * *', 'Every 6 hours'],
    ['0 * * * *', 'Every hour'],
    ['0 9 * * 1-5', 'Custom schedule'],
  ])('%s -> %s', (cron, text) => {
    expect(describeSchedule(cron)).toBe(text)
  })
})

describe('nextRun', () => {
  it('finds the next matching time', () => {
    const next = nextRun('0 6 * * 1', new Date(2026, 9, 16, 12, 0)) // Fri
    expect(next?.getDay()).toBe(1)
    expect(next?.getHours()).toBe(6)
  })

  it('returns null for an invalid cron', () => {
    expect(nextRun('nope')).toBeNull()
  })
})
