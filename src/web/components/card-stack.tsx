import { useEffect, useRef, useState } from 'react'
import type { RejectionReason } from '@/core/recommendations/rejection-reasons'
import { cn } from '../lib/utils'
import { ArtistThumb } from './artist-thumb'
import type { Recommendation } from './recommendation-card'
import { RejectionPicker } from './rejection-picker'
import { StreamingLinks } from './streaming-links'
import { SwipeCard } from './swipe-card'
import { WhyRecommendedButton } from './why-recommended'

export type RejectPayload = {
  reason?: RejectionReason | null
  reasonText?: string | null
  permanent?: boolean
}

type CardStackProps = {
  recommendations: Recommendation[]
  onApprove: (id: number, prevStatus?: string) => void
  onReject: (id: number, prevStatus?: string, payload?: RejectPayload) => void
  onDetail: (id: number) => void
}

function StackCard({
  rec,
  onApprove,
  onReject,
  onDetail,
}: {
  rec: Recommendation
  onApprove: () => void
  onReject: () => void
  onDetail: () => void
}) {
  const isPending = rec.status === 'pending'
  const genres = rec.artist.genres ?? []
  const tags = rec.artist.tags ?? []
  const allTags = [...new Set([...genres, ...tags])].slice(0, 6)

  return (
    <div className="bg-surface border border-border rounded-2xl overflow-hidden shadow-lg flex flex-col h-full">
      <div className="relative h-48 sm:h-56 bg-bg overflow-hidden shrink-0">
        <ArtistThumb
          name={rec.artist.name}
          imageUrl={rec.artist.imageUrl}
          fill
          className="text-4xl"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-surface/90 via-surface/20 to-transparent" />
        <div className="absolute top-3 right-3">
          <WhyRecommendedButton reasoning={rec.aiReasoning} sources={rec.sources} variant="hero" />
        </div>
      </div>

      <div className="flex flex-col flex-1 p-4 gap-3">
        <div>
          {rec.kind === 'album' ? (
            <>
              <h2 className="text-xl font-bold text-text leading-tight line-clamp-2">
                {rec.recommendedReleaseGroupTitle ?? rec.artist.name}
              </h2>
              <p className="text-xs text-muted mt-0.5 truncate">{rec.artist.name}</p>
            </>
          ) : (
            <>
              <h2 className="text-xl font-bold text-text leading-tight line-clamp-2">
                {rec.artist.name}
              </h2>
              {rec.artist.disambiguation && (
                <p className="text-xs text-muted mt-0.5 truncate">{rec.artist.disambiguation}</p>
              )}
            </>
          )}
        </div>

        {allTags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {allTags.map((tag, i) => (
              <span
                key={tag}
                className={cn(
                  'text-micro px-1.5 py-0.5 rounded-full',
                  i % 4 === 0 && 'bg-accent/10 text-accent',
                  i % 4 === 1 && 'bg-info/10 text-info',
                  i % 4 === 2 && 'bg-approve/10 text-approve',
                  i % 4 === 3 && 'bg-reject/10 text-reject',
                )}
              >
                {tag}
              </span>
            ))}
          </div>
        )}

        {rec.aiReasoning && (
          <p className="text-xs text-muted italic leading-relaxed line-clamp-3">
            {rec.aiReasoning}
          </p>
        )}

        <StreamingLinks
          streamingUrls={rec.artist.streamingUrls}
          artistName={rec.artist.name}
          albumTitle={
            rec.kind === 'album' ? (rec.recommendedReleaseGroupTitle ?? undefined) : undefined
          }
          compact
        />

        <div className="flex-1" />

        <div className="flex items-center gap-2">
          {isPending && (
            <>
              <button
                type="button"
                onClick={onReject}
                aria-label="Reject"
                className="flex-1 py-2.5 rounded-xl bg-reject/10 text-reject border border-reject/30 font-medium text-sm hover:bg-reject/20 transition-colors"
              >
                Reject
              </button>
              <button
                type="button"
                onClick={onDetail}
                aria-label="View details"
                className="px-3 py-2.5 rounded-xl bg-surface border border-border text-muted hover:text-text transition-colors"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="w-4 h-4"
                  aria-hidden="true"
                >
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
              </button>
              <button
                type="button"
                onClick={onApprove}
                aria-label="Approve"
                className="flex-1 py-2.5 rounded-xl bg-approve/10 text-approve border border-approve/30 font-medium text-sm hover:bg-approve/20 transition-colors"
              >
                Approve
              </button>
            </>
          )}
          {!isPending && (
            <button
              type="button"
              onClick={onDetail}
              aria-label="View details"
              className="flex-1 py-2.5 rounded-xl bg-surface border border-border text-muted hover:text-text transition-colors text-sm font-medium"
            >
              View details
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * Dating-app style card stack: one card at a time, swipe left/right to act.
 * Arrow keys also navigate.
 */
export function CardStack({ recommendations, onApprove, onReject, onDetail }: CardStackProps) {
  const [index, setIndex] = useState(0)
  const [exiting, setExiting] = useState<'left' | 'right' | null>(null)
  const exitingRef = useRef(exiting)
  exitingRef.current = exiting
  const [pickerState, setPickerState] = useState<{
    id: number
    prevStatus?: string
    artistName?: string
  } | null>(null)

  const total = recommendations.length
  const rec = recommendations[index]

  // Keep stable refs for keyboard handler to avoid stale closures
  const approveRef = useRef<() => void>(() => {})
  const rejectRef = useRef<() => void>(() => {})

  // Reset to first card when the recommendations array identity changes.
  // We track the ref here and trigger via the effect below.
  const prevRecsRef = useRef(recommendations)
  const recsChanged = prevRecsRef.current !== recommendations
  if (recsChanged) prevRecsRef.current = recommendations

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally react to array identity change, not contents
  useEffect(() => {
    setIndex(0)
    setExiting(null)
  }, [recommendations])

  // Keyboard: left arrow = reject, right arrow = approve, up/down = navigate
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (exitingRef.current) return

      if (e.key === 'ArrowRight') {
        e.preventDefault()
        approveRef.current()
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        rejectRef.current()
      } else if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault()
        setIndex((i) => Math.min(i + 1, total - 1))
      } else if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault()
        setIndex((i) => Math.max(i - 1, 0))
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [total])

  function triggerApprove() {
    if (!rec || exiting) return
    setExiting('right')
    setTimeout(() => {
      onApprove(rec.id, rec.status)
      setIndex((i) => Math.min(i + 1, total - 1))
      setExiting(null)
    }, 250)
  }
  approveRef.current = triggerApprove

  function triggerReject() {
    if (!rec || exiting || pickerState) return
    setPickerState({ id: rec.id, prevStatus: rec.status, artistName: rec.artist?.name })
  }
  rejectRef.current = triggerReject

  function commitReject(payload: RejectPayload) {
    const target = pickerState
    if (!target) return
    setExiting('left')
    setTimeout(() => {
      onReject(target.id, target.prevStatus, payload)
      setIndex((i) => Math.min(i + 1, total - 1))
      setExiting(null)
    }, 250)
  }

  if (total === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-4 text-center">
        <div className="w-16 h-16 rounded-full bg-surface border border-border flex items-center justify-center">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="w-8 h-8 text-muted"
            aria-hidden="true"
          >
            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
          </svg>
        </div>
        <div>
          <p className="text-text font-medium">No more recommendations</p>
          <p className="text-xs text-muted mt-1">Run a scan to discover more artists</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center gap-4 w-full max-w-sm mx-auto">
      <div className="flex items-center gap-2 text-xs text-muted">
        <button
          type="button"
          onClick={() => setIndex((i) => Math.max(i - 1, 0))}
          disabled={index === 0}
          aria-label="Previous card"
          className="p-1 rounded hover:text-text disabled:opacity-30 transition-colors"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="w-4 h-4"
            aria-hidden="true"
          >
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <span className="tabular-nums font-medium">{`${index + 1} of ${total}`}</span>
        <button
          type="button"
          onClick={() => setIndex((i) => Math.min(i + 1, total - 1))}
          disabled={index >= total - 1}
          aria-label="Next card"
          className="p-1 rounded hover:text-text disabled:opacity-30 transition-colors"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="w-4 h-4"
            aria-hidden="true"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
      </div>

      {/* Card area with exit animation */}
      <div
        className="w-full transition-all duration-250"
        style={{
          transform: exiting
            ? `translateX(${exiting === 'right' ? '110%' : '-110%'}) rotate(${exiting === 'right' ? '8deg' : '-8deg'})`
            : 'translateX(0) rotate(0deg)',
          opacity: exiting ? 0 : 1,
          transition: exiting ? 'transform 0.25s ease-out, opacity 0.2s ease-out' : 'none',
        }}
      >
        {rec && (
          <SwipeCard
            enabled={rec.status === 'pending' && !exiting}
            onSwipeRight={rec.status === 'pending' ? triggerApprove : undefined}
            onSwipeLeft={rec.status === 'pending' ? triggerReject : undefined}
          >
            <StackCard
              rec={rec}
              onApprove={triggerApprove}
              onReject={triggerReject}
              onDetail={() => onDetail(rec.id)}
            />
          </SwipeCard>
        )}
      </div>

      {rec?.status === 'pending' && (
        <p className="text-micro text-muted">Swipe right to approve, left to reject</p>
      )}

      <RejectionPicker
        open={pickerState != null}
        artistName={pickerState?.artistName}
        onClose={() => setPickerState(null)}
        onSubmit={async (payload) => {
          commitReject(payload)
        }}
      />
    </div>
  )
}
