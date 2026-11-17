import { useQueryClient } from '@tanstack/react-query'
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  Clock,
  Disc3,
  Library,
  ListMusic,
  Radar,
  Send,
  Sparkles,
} from 'lucide-react'
import { type CSSProperties, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useClickOutside } from '../hooks/use-click-outside'
import {
  ACTIVITY_KEY,
  type ActivityJob,
  type ActivityKind,
  isActive,
  useActivity,
} from '../lib/activity'
import { cn } from '../lib/utils'

const KIND_ICON: Record<ActivityKind, typeof Activity> = {
  pipeline: Radar,
  quick_discover: Sparkles,
  library_sync: Library,
  artist_rescan: Disc3,
  playlist: ListMusic,
  lidarr_dispatch: Send,
  retry_failed: Send,
  bulk_action: Send,
  taste_profile: Sparkles,
}

export function formatElapsed(fromIso: string, toMs: number): string {
  const seconds = Math.max(0, Math.round((toMs - Date.parse(fromIso)) / 1000))
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  if (m === 0) return `${s}s`
  if (m < 60) return `${m}m ${s.toString().padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${(m % 60).toString().padStart(2, '0')}m`
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [active])
  return now
}

export function JobProgressBar({ job }: { job: ActivityJob }) {
  const determinate =
    job.status === 'running' &&
    job.current !== undefined &&
    job.total !== undefined &&
    job.total > 0
  const pct = determinate
    ? Math.min(100, Math.round(((job.current ?? 0) / (job.total ?? 1)) * 100))
    : 0
  if (job.status === 'done' || job.status === 'error') return null
  return (
    <div
      className="h-1 w-full rounded-full bg-bg overflow-hidden"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={determinate ? pct : undefined}
    >
      {determinate ? (
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-300"
          style={{ width: `${Math.max(pct, 3)}%` }}
        />
      ) : (
        // Indeterminate: a sliding sliver, so "working, no count yet" still
        // visibly moves instead of looking frozen.
        <div
          className={cn(
            'h-full w-1/3 rounded-full animate-[activity-slide_1.4s_ease-in-out_infinite]',
            job.status === 'queued' ? 'bg-muted/50' : 'bg-accent',
          )}
        />
      )}
    </div>
  )
}

function JobRow({
  job,
  now,
  onNavigate,
}: {
  job: ActivityJob
  now: number
  onNavigate: () => void
}) {
  const Icon = KIND_ICON[job.kind] ?? Activity
  const count =
    job.current !== undefined && job.total !== undefined && job.total > 0
      ? `${job.current}/${job.total}`
      : null
  const detail =
    job.status === 'queued'
      ? job.queuePosition
        ? `Queued - #${job.queuePosition} in line`
        : (job.message ?? 'Queued')
      : job.status === 'done'
        ? (job.resultSummary ?? 'Finished')
        : job.message
  return (
    <li className="px-3 py-2.5 space-y-1.5">
      <div className="flex items-start gap-2">
        <span
          className={cn(
            'mt-0.5 shrink-0',
            job.status === 'error'
              ? 'text-reject'
              : job.status === 'done'
                ? 'text-accent'
                : 'text-muted',
          )}
        >
          {job.status === 'done' ? (
            <CheckCircle2 size={15} />
          ) : job.status === 'error' ? (
            <AlertCircle size={15} />
          ) : job.status === 'queued' ? (
            <Clock size={15} />
          ) : (
            <Icon
              size={15}
              className={
                job.kind === 'pipeline' ? 'animate-spin [animation-duration:2.5s]' : undefined
              }
            />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-sm font-medium text-text truncate">{job.label}</p>
            <span className="shrink-0 text-micro text-muted tabular-nums">
              {isActive(job)
                ? formatElapsed(job.startedAt, now)
                : `${formatElapsed(job.finishedAt ?? job.updatedAt, now)} ago`}
            </span>
          </div>
          {detail && (
            <p
              className={cn(
                'text-xs truncate',
                job.status === 'error' ? 'text-reject' : 'text-muted',
              )}
              title={detail}
            >
              {detail}
              {count && job.status === 'running' ? ` · ${count}` : ''}
            </p>
          )}
          {job.status === 'done' && job.resultHref && (
            <Link
              to={job.resultHref}
              onClick={onNavigate}
              className="text-xs font-medium text-accent hover:underline"
            >
              View results →
            </Link>
          )}
        </div>
      </div>
      <JobProgressBar job={job} />
    </li>
  )
}

/**
 * Header "what's DJ Llama doing right now" indicator. Pulses while anything
 * is queued/running, briefly shows a check when something finishes, and opens
 * a live list of jobs with progress, elapsed time and result links.
 */
export function ActivityCenter() {
  const jobs = useActivity()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  // On phones the button sits mid-header, so a popover anchored to it runs
  // off the left edge. Below sm it's pinned to the viewport instead, just
  // under the button.
  const [mobileTop, setMobileTop] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  useClickOutside(ref, () => setOpen(false), open)

  const active = jobs.filter(isActive)
  const failedRecently = jobs.some((j) => j.status === 'error')
  const now = useNow(open || active.length > 0)

  // Flash a check for a few seconds after the last running job finishes.
  const [justFinished, setJustFinished] = useState(false)
  const prevActive = useRef(active.length)
  useEffect(() => {
    if (prevActive.current > 0 && active.length === 0) {
      setJustFinished(true)
      const t = setTimeout(() => setJustFinished(false), 4000)
      prevActive.current = active.length
      return () => clearTimeout(t)
    }
    prevActive.current = active.length
  }, [active.length])

  // Nothing ever happened this session: stay out of the way.
  if (jobs.length === 0 && !justFinished) return null

  const busy = active.length > 0
  const title = busy
    ? `${active.length} task${active.length === 1 ? '' : 's'} running`
    : 'Recent activity'

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={(e) => {
          setMobileTop(e.currentTarget.getBoundingClientRect().bottom + 4)
          setOpen((v) => !v)
        }}
        aria-label={title}
        title={title}
        aria-expanded={open}
        aria-haspopup="dialog"
        className={cn(
          'relative flex h-11 w-11 items-center justify-center rounded-md transition-colors focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2 sm:h-9 sm:w-9',
          busy ? 'text-accent' : 'text-muted hover:text-text',
        )}
      >
        {justFinished && !busy ? (
          <CheckCircle2 size={18} className="text-accent animate-[activity-pop_400ms_ease-out]" />
        ) : (
          <Activity size={18} />
        )}
        {busy && (
          <>
            <span
              className="absolute inset-1 rounded-md ring-2 ring-accent/40 animate-pulse"
              aria-hidden="true"
            />
            <span className="absolute -top-0.5 -right-0.5 min-w-4 h-4 px-1 rounded-full bg-accent text-accent-fg text-micro-sm leading-4 text-center font-semibold tabular-nums">
              {active.length}
            </span>
          </>
        )}
        {!busy && failedRecently && (
          <span
            className="absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-reject"
            aria-hidden="true"
          />
        )}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Activity"
          style={{ '--activity-top': `${mobileTop}px` } as CSSProperties}
          className="fixed inset-x-4 top-(--activity-top) sm:absolute sm:inset-x-auto sm:right-0 sm:top-full sm:mt-1 sm:w-80 bg-surface border border-border rounded-lg shadow-lg z-50"
        >
          <div className="flex items-center justify-between px-3 py-2 border-b border-border">
            <p className="text-sm font-medium text-text">Activity</p>
            {jobs.some((j) => !isActive(j)) && (
              <button
                type="button"
                className="text-xs text-muted hover:text-text"
                onClick={() =>
                  queryClient.setQueryData<ActivityJob[]>(ACTIVITY_KEY, (old = []) =>
                    old.filter(isActive),
                  )
                }
              >
                Clear finished
              </button>
            )}
          </div>
          {jobs.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted">All quiet.</p>
          ) : (
            <ul className="max-h-96 overflow-y-auto divide-y divide-border">
              {jobs.map((job) => (
                <JobRow key={job.id} job={job} now={now} onNavigate={() => setOpen(false)} />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
