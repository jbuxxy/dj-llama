import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { getPipelineStatus } from '../lib/api'
import { useSSE } from '../lib/hooks'

type SSEProgress = {
  stage: string
  current?: number
  total?: number
  message?: string
}

const STAGES = ['collect', 'analyze', 'discover', 'resolve', 'score', 'filter', 'store', 'complete']

const STAGE_LABELS: Record<string, string> = {
  collect: 'Reading library',
  analyze: 'Building taste profile',
  discover: 'Finding new artists',
  resolve: 'Looking up metadata',
  score: 'Ranking matches',
  filter: 'Removing duplicates',
  store: 'Saving results',
  complete: 'Done',
}

const STAGE_DESCRIPTIONS: Record<string, string> = {
  collect: 'Checking which artists you already have',
  analyze: 'Learning your music preferences from your library and listening history',
  discover: 'Asking for recommendations based on your taste',
  resolve: 'Fetching artist details, genres, and images',
  score: 'Scoring how well each artist matches your taste',
  filter: "Filtering out artists you've already seen",
  store: 'Saving your new recommendations',
  complete: 'Your new recommendations are ready to explore!',
}

const FIRST_SCAN_DESCRIPTIONS: Record<string, string> = {
  ...STAGE_DESCRIPTIONS,
  complete:
    'Your first recommendations are ready! Head to the Discover page to see what DJ Llama found.',
}

function stageIndex(stage: string): number {
  const idx = STAGES.indexOf(stage)
  return idx === -1 ? 0 : idx
}

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  if (m === 0) return `${s}s`
  return `${m}m ${s.toString().padStart(2, '0')}s`
}

const STALL_THRESHOLD_MS = 30_000

export function PipelineProgress({
  onComplete,
  isFirstScan = false,
}: {
  onComplete?: () => void
  isFirstScan?: boolean
}) {
  const { data: status } = useQuery({
    queryKey: ['pipelineStatus'],
    queryFn: getPipelineStatus,
  })
  const { data: sseData } = useSSE('/api/v1/pipeline/events')
  const completeFired = useRef(false)

  const [elapsed, setElapsed] = useState(0)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const startedRef = useRef(false)

  const lastEventRef = useRef<number>(Date.now())
  const [stalled, setStalled] = useState(false)

  const progress = sseData as SSEProgress | null
  const isRunning = status?.running ?? false

  const stage = progress?.stage ?? (status?.running ? (status.stage ?? 'collect') : null)
  const stageIdx = stage ? stageIndex(stage) : 0
  const label = stage ? (STAGE_LABELS[stage] ? STAGE_LABELS[stage] : stage) : ''
  const descriptions = isFirstScan ? FIRST_SCAN_DESCRIPTIONS : STAGE_DESCRIPTIONS
  const description = stage ? (descriptions[stage] ? descriptions[stage] : '') : ''

  const current = progress?.current
  const total = progress?.total
  // Blend real item-level progress (collect/resolve emit current+total as they
  // work through artists) into the stage-boundary percentage, so the bar
  // actually moves during the long stages instead of jumping straight to the
  // stage's end value and sitting there until the next stage starts.
  const stageFraction =
    current !== undefined && total !== undefined && total > 0 ? Math.min(current / total, 1) : 0
  const pct = stage
    ? stage === 'complete'
      ? 100
      : Math.round(((stageIdx + stageFraction) / STAGES.length) * 100)
    : 0

  // Start timer on first SSE event
  useEffect(() => {
    if (progress && !startedRef.current) {
      startedRef.current = true
      setElapsed(0)
      timerRef.current = setInterval(() => setElapsed((e) => e + 1), 1000)
    }
    if (progress) {
      lastEventRef.current = Date.now()
      setStalled(false)
    }
  }, [progress])

  useEffect(() => {
    if (!stage || stage === 'complete') return
    const interval = setInterval(() => {
      if (Date.now() - lastEventRef.current > STALL_THRESHOLD_MS) {
        setStalled(true)
      }
    }, 5000)
    return () => clearInterval(interval)
  }, [stage])

  useEffect(() => {
    if (stage === 'complete' && timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [stage])

  useEffect(() => {
    if (!isRunning && !progress) {
      startedRef.current = false
      setElapsed(0)
      setStalled(false)
    }
  }, [isRunning, progress])

  // Fire onComplete exactly once when pipeline finishes
  useEffect(() => {
    if (stage === 'complete' && onComplete && !completeFired.current) {
      completeFired.current = true
      setTimeout(onComplete, 500)
    }
    if (stage && stage !== 'complete') {
      completeFired.current = false
    }
  }, [stage, onComplete])

  if (!isRunning && !progress) return null

  return (
    <div className="bg-surface border border-border rounded-lg p-4 space-y-3">
      {isFirstScan && stage !== 'complete' && (
        <div className="space-y-1">
          <p className="text-sm font-medium text-text">Running your first scan</p>
          <p className="text-xs text-muted">
            DJ Llama is analyzing your music taste and finding artists you might like. This usually
            takes 2-5 minutes on the first run.
          </p>
        </div>
      )}

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {stage !== 'complete' && (
            <span className="inline-block h-2 w-2 rounded-full bg-accent animate-pulse" />
          )}
          <span className="text-sm font-medium text-text">{label}</span>
        </div>
        <div className="flex items-center gap-3 text-xs text-muted">
          {startedRef.current && stage !== 'complete' && (
            <span>Running for {formatElapsed(elapsed)}</span>
          )}
          {current !== undefined && total !== undefined && (
            <span>
              {current}/{total}
            </span>
          )}
          <span>{pct}%</span>
        </div>
      </div>

      <div className="flex gap-1">
        {STAGES.slice(0, -1).map((s, i) => (
          <div key={s} className="h-1.5 flex-1 rounded-full bg-bg overflow-hidden">
            <div
              className={[
                'h-full rounded-full transition-all duration-300',
                i < stageIdx ? 'bg-accent w-full' : i === stageIdx ? 'bg-accent' : 'bg-bg w-0',
              ].join(' ')}
              style={i === stageIdx ? { width: `${Math.max(stageFraction * 100, 6)}%` } : undefined}
            />
          </div>
        ))}
      </div>

      {description && <p className="text-xs text-muted">{description}</p>}

      {stalled && stage !== 'complete' && (
        <p className="text-xs text-muted italic">This is taking longer than usual - hang tight</p>
      )}

      {/* SSE message -- kept visible even when stalled: a MusicBrainz-backlog
          note explains a long gap between events better than the generic
          stall warning alone. */}
      {(progress?.message ?? status?.message) && (
        <p className="text-xs text-muted">{progress?.message ?? status?.message}</p>
      )}
    </div>
  )
}
