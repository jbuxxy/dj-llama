import { CalendarClock } from 'lucide-react'
import { useId, useRef, useState } from 'react'
import {
  buildCron,
  describeSchedule,
  formatNextRun,
  HOURLY_OPTIONS,
  nextRun,
  parseSchedule,
  type Schedule,
  type ScheduleKind,
  WEEKDAYS,
} from '../lib/schedule'
import { Input } from './ui/input'
import { Select } from './ui/select'

type CronPickerProps = {
  value: string
  onChange: (cron: string) => void
}

// Each mode remembers its own last values, so flipping between "Every day"
// and "Certain days" and back doesn't lose the time or day picks.
type Draft = {
  kind: ScheduleKind
  time: string
  weekDays: number[]
  monthDays: number[]
  everyHours: number
  cron: string
}

const KINDS: { value: Exclude<ScheduleKind, 'custom'>; label: string }[] = [
  { value: 'daily', label: 'Every day' },
  { value: 'weekly', label: 'Certain days' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'hourly', label: 'Every few hours' },
]

const DAY_SHORTCUTS = [
  { label: 'Weekdays', days: [1, 2, 3, 4, 5] },
  { label: 'Weekends', days: [0, 6] },
  { label: 'All', days: [0, 1, 2, 3, 4, 5, 6] },
]

function draftFrom(cron: string, prev?: Draft): Draft {
  const s = parseSchedule(cron)
  const base: Draft = prev ?? {
    kind: 'daily',
    time: '06:00',
    weekDays: [1],
    monthDays: [1],
    everyHours: 6,
    cron,
  }
  return {
    ...base,
    kind: s.kind,
    cron,
    ...('time' in s ? { time: s.time } : {}),
    ...(s.kind === 'weekly' ? { weekDays: s.weekDays } : {}),
    ...(s.kind === 'monthly' ? { monthDays: s.monthDays } : {}),
    ...(s.kind === 'hourly' ? { everyHours: s.everyHours } : {}),
  }
}

function toSchedule(d: Draft): Schedule {
  switch (d.kind) {
    case 'daily':
      return { kind: 'daily', time: d.time }
    case 'weekly':
      return { kind: 'weekly', time: d.time, weekDays: d.weekDays }
    case 'monthly':
      return { kind: 'monthly', time: d.time, monthDays: d.monthDays }
    case 'hourly':
      return { kind: 'hourly', everyHours: d.everyHours }
    case 'custom':
      return { kind: 'custom', cron: d.cron }
  }
}

function toggle(list: number[], n: number): number[] {
  return list.includes(n) ? list.filter((x) => x !== n) : [...list, n].sort((a, b) => a - b)
}

const chipBase =
  'flex items-center justify-center rounded-md border text-sm font-medium transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-accent'
const chipOn = 'bg-accent text-accent-fg border-accent'
const chipOff = 'bg-surface border-border text-muted hover:text-text hover:border-muted'

export function CronPicker({ value, onChange }: CronPickerProps) {
  const id = useId()
  const [draft, setDraft] = useState<Draft>(() => draftFrom(value))
  // Last cron *we* emitted -- distinguishes an external value change (e.g.
  // a different playlist opened in the same form) from our own round-trip.
  const lastEmitted = useRef(value)

  if (value !== lastEmitted.current) {
    lastEmitted.current = value
    setDraft((prev) => draftFrom(value, prev))
  }

  function update(patch: Partial<Draft>) {
    const next = { ...draft, ...patch }
    setDraft(next)
    const cron = buildCron(toSchedule(next))
    if (cron !== null && cron !== lastEmitted.current) {
      lastEmitted.current = cron
      onChange(cron)
    }
  }

  const cron = buildCron(toSchedule(draft))
  const next = cron ? nextRun(cron) : null
  const showTime = draft.kind === 'daily' || draft.kind === 'weekly' || draft.kind === 'monthly'

  return (
    <div className="space-y-4">
      {draft.kind !== 'custom' && (
        <fieldset className="space-y-1.5">
          <legend className="text-xs font-medium text-muted mb-1.5">Repeat</legend>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-1 bg-bg border border-border rounded-lg p-1">
            {KINDS.map((k) => {
              const selected = draft.kind === k.value
              return (
                <button
                  key={k.value}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => update({ kind: k.value })}
                  className={`px-2 py-2 sm:py-1.5 rounded text-sm font-medium transition-colors ${
                    selected ? 'bg-accent text-accent-fg' : 'text-muted hover:text-text'
                  }`}
                >
                  {k.label}
                </button>
              )
            })}
          </div>
        </fieldset>
      )}

      {draft.kind === 'weekly' && (
        <fieldset>
          <div className="flex items-baseline justify-between gap-2 mb-1.5">
            <legend className="text-xs font-medium text-muted">On these days</legend>
            <div className="flex gap-3">
              {DAY_SHORTCUTS.map((s) => (
                <button
                  key={s.label}
                  type="button"
                  onClick={() => update({ weekDays: s.days })}
                  className="text-xs text-accent hover:underline"
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-7 gap-1 sm:max-w-sm">
            {WEEKDAYS.map(({ day, short, long }) => {
              const active = draft.weekDays.includes(day)
              return (
                <button
                  key={day}
                  type="button"
                  aria-pressed={active}
                  aria-label={long}
                  title={long}
                  onClick={() => update({ weekDays: toggle(draft.weekDays, day) })}
                  className={`${chipBase} h-10 sm:h-9 text-xs ${active ? chipOn : chipOff}`}
                >
                  {short}
                </button>
              )
            })}
          </div>
          {draft.weekDays.length === 0 && (
            <p className="text-xs text-reject mt-1.5">Pick at least one day.</p>
          )}
        </fieldset>
      )}

      {draft.kind === 'monthly' && (
        <fieldset>
          <legend className="text-xs font-medium text-muted mb-1.5">On these dates</legend>
          <div className="grid grid-cols-7 gap-1 sm:max-w-sm">
            {Array.from({ length: 31 }, (_, i) => i + 1).map((day) => {
              const active = draft.monthDays.includes(day)
              return (
                <button
                  key={day}
                  type="button"
                  aria-pressed={active}
                  onClick={() => update({ monthDays: toggle(draft.monthDays, day) })}
                  className={`${chipBase} h-9 text-xs ${active ? chipOn : chipOff}`}
                >
                  {day}
                </button>
              )
            })}
          </div>
          {draft.monthDays.length === 0 ? (
            <p className="text-xs text-reject mt-1.5">Pick at least one date.</p>
          ) : (
            draft.monthDays.some((d) => d > 28) && (
              <p className="text-xs text-muted mt-1.5">
                Months that don't have that date are skipped.
              </p>
            )
          )}
        </fieldset>
      )}

      {draft.kind === 'hourly' && (
        <div>
          <label htmlFor={`${id}-hours`} className="block text-xs font-medium text-muted mb-1.5">
            How often
          </label>
          <Select
            id={`${id}-hours`}
            value={draft.everyHours}
            onChange={(e) => update({ everyHours: Number(e.target.value) })}
            className="sm:w-56"
          >
            {HOURLY_OPTIONS.map((h) => (
              <option key={h} value={h}>
                {h === 1 ? 'Every hour' : `Every ${h} hours`}
              </option>
            ))}
          </Select>
        </div>
      )}

      {showTime && (
        <div>
          <label htmlFor={`${id}-time`} className="block text-xs font-medium text-muted mb-1.5">
            At
          </label>
          <Input
            id={`${id}-time`}
            type="time"
            value={draft.time}
            onChange={(e) => e.target.value && update({ time: e.target.value })}
            className="sm:w-44"
          />
        </div>
      )}

      {draft.kind === 'custom' && (
        <div>
          <label htmlFor={`${id}-cron`} className="block text-xs font-medium text-muted mb-1.5">
            Cron expression
          </label>
          <Input
            id={`${id}-cron`}
            type="text"
            value={draft.cron}
            onChange={(e) => update({ cron: e.target.value })}
            placeholder="0 6 * * 1"
            spellCheck={false}
            autoCapitalize="off"
            className="font-mono"
          />
          <p className={`text-xs mt-1.5 ${cron ? 'text-muted' : 'text-reject'}`}>
            {cron
              ? 'Five fields: minute, hour, day of month, month, day of week.'
              : "That isn't a valid cron expression."}
          </p>
        </div>
      )}

      <div
        aria-live="polite"
        className="flex items-start gap-3 rounded-lg border border-border bg-bg px-3 py-2.5"
      >
        <CalendarClock size={18} className="text-accent shrink-0 mt-0.5" aria-hidden />
        <div className="min-w-0">
          <p className="text-sm font-medium text-text">
            {cron ? describeSchedule(cron) : 'Not scheduled yet'}
          </p>
          {next && <p className="text-xs text-muted">Next run: {formatNextRun(next)}</p>}
        </div>
      </div>

      <button
        type="button"
        onClick={() =>
          draft.kind === 'custom'
            ? update(draftFrom(cron && parseSchedule(cron).kind !== 'custom' ? cron : '0 6 * * *'))
            : update({ kind: 'custom', cron: cron ?? '' })
        }
        className="text-xs text-muted hover:text-text underline underline-offset-2"
      >
        {draft.kind === 'custom' ? 'Back to simple options' : 'Advanced: use a cron expression'}
      </button>
    </div>
  )
}
