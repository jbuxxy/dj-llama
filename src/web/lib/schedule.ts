import { Cron } from 'croner'
import { formatDate } from './intl'

// Friendly view of a cron string. Every schedule in the app is stored as cron
// (pipeline scheduleCron, digestCron, playlist.schedule), but nobody should
// have to read or write one -- the picker edits this shape and describeSchedule
// turns any stored value back into a sentence.
export type Schedule =
  | { kind: 'daily'; time: string }
  | { kind: 'weekly'; time: string; weekDays: number[] }
  | { kind: 'monthly'; time: string; monthDays: number[] }
  | { kind: 'hourly'; everyHours: number }
  | { kind: 'custom'; cron: string }

export type ScheduleKind = Schedule['kind']

export const HOURLY_OPTIONS = [1, 2, 3, 4, 6, 8, 12] as const

// 2023-01-01 was a Sunday -- a stable anchor for locale weekday names.
const WEEK_ANCHOR = new Date(2023, 0, 1)

export const WEEKDAYS = Array.from({ length: 7 }, (_, day) => {
  const d = new Date(WEEK_ANCHOR)
  d.setDate(d.getDate() + day)
  return {
    day,
    short: formatDate(d, { weekday: 'short' }),
    long: formatDate(d, { weekday: 'long' }),
  }
})

const WORKWEEK = [1, 2, 3, 4, 5]
const WEEKEND = [0, 6]

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function parseSingleInt(field: string | undefined, min: number, max: number): number | null {
  if (field === undefined || !/^\d+$/.test(field)) return null
  const n = Number(field)
  return n >= min && n <= max ? n : null
}

function parseIntList(field: string | undefined, min: number, max: number): number[] | null {
  if (field === undefined) return null
  const nums: number[] = []
  for (const part of field.split(',')) {
    const n = parseSingleInt(part, min, max)
    if (n === null) return null
    nums.push(n)
  }
  return nums.length > 0 ? [...new Set(nums)].sort((a, b) => a - b) : null
}

/**
 * Cron shapes the friendly UI can represent: a fixed time daily, on certain
 * weekdays, or on certain dates; or "every N hours". Anything else (ranges,
 * steps elsewhere, both dom+dow set, 6-field) stays 'custom' so a hand-written
 * expression is never silently rewritten.
 */
export function parseSchedule(cron: string): Schedule {
  const custom: Schedule = { kind: 'custom', cron }
  const fields = cron.trim().split(/\s+/)
  if (fields.length !== 5) return custom
  const [minField, hourField, domField, monthField, dowField] = fields
  if (monthField !== '*') return custom

  const minute = parseSingleInt(minField, 0, 59)
  if (minute === null) return custom

  if (domField === '*' && dowField === '*') {
    if (minute === 0 && hourField === '*') return { kind: 'hourly', everyHours: 1 }
    const step = hourField?.match(/^(?:\*|0)\/(\d+)$/)
    if (minute === 0 && step) {
      const everyHours = Number(step[1])
      if ((HOURLY_OPTIONS as readonly number[]).includes(everyHours)) {
        return { kind: 'hourly', everyHours }
      }
      return custom
    }
  }

  const hour = parseSingleInt(hourField, 0, 23)
  if (hour === null) return custom
  const time = `${pad2(hour)}:${pad2(minute)}`

  if (domField === '*' && dowField === '*') return { kind: 'daily', time }
  if (domField === '*') {
    // Cron allows 7 for Sunday too.
    const days = parseIntList(dowField, 0, 7)
    if (!days) return custom
    const weekDays = [...new Set(days.map((d) => d % 7))].sort((a, b) => a - b)
    return { kind: 'weekly', time, weekDays }
  }
  if (dowField === '*') {
    const monthDays = parseIntList(domField, 1, 31)
    if (!monthDays) return custom
    return { kind: 'monthly', time, monthDays }
  }
  return custom
}

/** Returns null while the schedule is incomplete (e.g. no days picked). */
export function buildCron(schedule: Schedule): string | null {
  if (schedule.kind === 'custom') {
    const cron = schedule.cron.trim()
    return cron && isValidCron(cron) ? cron : null
  }
  if (schedule.kind === 'hourly') {
    return schedule.everyHours === 1 ? '0 * * * *' : `0 */${schedule.everyHours} * * *`
  }

  const [h, m] = schedule.time.split(':').map(Number)
  if (h === undefined || m === undefined || Number.isNaN(h) || Number.isNaN(m)) return null

  switch (schedule.kind) {
    case 'daily':
      return `${m} ${h} * * *`
    case 'weekly':
      if (schedule.weekDays.length === 0) return null
      return `${m} ${h} * * ${[...schedule.weekDays].sort((a, b) => a - b).join(',')}`
    case 'monthly':
      if (schedule.monthDays.length === 0) return null
      return `${m} ${h} ${[...schedule.monthDays].sort((a, b) => a - b).join(',')} * *`
  }
}

export function isValidCron(cron: string): boolean {
  try {
    new Cron(cron, { paused: true })
    return true
  } catch {
    return false
  }
}

export function nextRun(cron: string, from = new Date()): Date | null {
  try {
    return new Cron(cron, { paused: true }).nextRun(from) ?? null
  } catch {
    return null
  }
}

export function formatTime(time: string): string {
  const [h, m] = time.split(':').map(Number)
  const d = new Date(2023, 0, 1, h ?? 0, m ?? 0)
  return formatDate(d, { hour: 'numeric', minute: '2-digit' })
}

export function ordinal(n: number): string {
  const rem100 = n % 100
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`
  return `${n}${{ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th'}`
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items.join('')
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

function sameDays(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((d, i) => d === b[i])
}

export function describeWeekDays(weekDays: number[]): string {
  const days = [...weekDays].sort((a, b) => a - b)
  if (days.length === 7) return 'Every day'
  if (sameDays(days, WORKWEEK)) return 'Weekdays'
  if (sameDays(days, WEEKEND)) return 'Weekends'
  if (days.length === 1) return `Every ${WEEKDAYS[days[0] as number]?.long}`
  return joinList(days.map((d) => `${WEEKDAYS[d]?.long}s`))
}

/** One-line plain-English description, e.g. "Every Monday at 6:00 AM". */
export function describeSchedule(cron: string): string {
  const schedule = parseSchedule(cron)
  switch (schedule.kind) {
    case 'daily':
      return `Every day at ${formatTime(schedule.time)}`
    case 'weekly':
      return `${describeWeekDays(schedule.weekDays)} at ${formatTime(schedule.time)}`
    case 'monthly':
      return `Monthly on the ${joinList(schedule.monthDays.map(ordinal))} at ${formatTime(schedule.time)}`
    case 'hourly':
      return schedule.everyHours === 1 ? 'Every hour' : `Every ${schedule.everyHours} hours`
    case 'custom':
      return 'Custom schedule'
  }
}

export function formatNextRun(date: Date): string {
  return formatDate(date, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}
