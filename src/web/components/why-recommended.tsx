import { Sparkles, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { useClickOutside } from '../hooks/use-click-outside'
import { cn } from '../lib/utils'

export const SOURCE_COLORS: Record<string, { label: string; color: string }> = {
  musicbrainz: { label: 'MB', color: 'var(--color-svc-musicbrainz)' },
  ai: { label: 'Rec', color: 'var(--color-svc-ai)' },
}

const SUBSCRIPTION_COLORS: Record<string, string> = {
  'genre-subscription': 'bg-indigo-500/20 text-indigo-400',
  'similar-subscription': 'bg-violet-500/20 text-violet-400',
  'spotify-playlist': 'bg-green-500/20 text-green-400',
  'spotify-charts': 'bg-green-500/20 text-green-400',
}

export function getSourceBadgeClass(sourceKey: string): string {
  const prefix = sourceKey.split(':')[0] ?? sourceKey
  return SUBSCRIPTION_COLORS[prefix] ?? 'bg-zinc-500/20 text-zinc-400'
}

const ANALYTICS_SOURCE_KEYS: Partial<Record<string, string>> = {
  similarity: 'Similarity',
  aiConfidence: 'AI Confidence',
  feedbackBoost: 'Feedback Boost',
  consensus: 'Consensus',
  genreOverlap: 'Genre Overlap',
  popularity: 'Popularity',
}

export function formatSourceLabel(sourceKey: string): string {
  const [type, detail] = sourceKey.split(':')
  switch (type) {
    case 'genre-subscription':
      return `Genre: ${detail}`
    case 'similar-subscription':
      return `Similar: ${detail}`
    case 'spotify-playlist':
      return 'Spotify Playlist'
    case 'spotify-charts':
      return 'Spotify Charts'
    default: {
      const analyticsKey = ANALYTICS_SOURCE_KEYS[sourceKey]
      return analyticsKey ? analyticsKey : sourceKey
    }
  }
}

function WhyRecommendedDialog({
  reasoning,
  sources,
  onClose,
}: {
  reasoning?: string | null
  sources?: Record<string, number> | null
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  // Also handles Escape-to-close.
  useClickOutside(ref, onClose, true)

  // Ranked by contribution, highest first -- but never shown as a number:
  // the ordering itself communicates "this mattered more," without the raw score the
  // user specifically asked to get rid of.
  const rankedSources = sources ? Object.entries(sources).sort((a, b) => b[1] - a[1]) : []

  return (
    <>
      <div
        className="fixed inset-0 bg-bg/70 backdrop-blur-sm z-50"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        className="fixed inset-0 z-50 flex items-center justify-center p-4"
        role="dialog"
        aria-modal="true"
        aria-label="Why this?"
      >
        <div
          ref={ref}
          className="bg-surface border border-border rounded-lg shadow-lg w-full max-w-sm p-4"
        >
          <div className="flex items-start justify-between gap-2">
            <h3 className="text-sm font-medium text-text">Why this?</h3>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="shrink-0 text-muted hover:text-text transition-colors"
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>

          {reasoning ? (
            <p className="text-sm text-text mt-3">{reasoning}</p>
          ) : (
            <p className="text-sm text-muted mt-3">No details available for this recommendation.</p>
          )}

          {rankedSources.length > 0 && (
            <div className="mt-3 pt-3 border-t border-border">
              <p className="text-xs text-muted uppercase tracking-wide mb-2">Matched from</p>
              <div className="flex flex-wrap gap-1.5">
                {rankedSources.map(([key]) => {
                  const classic = SOURCE_COLORS[key]
                  return (
                    <span
                      key={key}
                      className={cn(
                        'text-xs px-2 py-0.5 rounded-full',
                        !classic && getSourceBadgeClass(key),
                      )}
                      style={
                        classic
                          ? { backgroundColor: `${classic.color}33`, color: classic.color }
                          : undefined
                      }
                    >
                      {classic ? classic.label : formatSourceLabel(key)}
                    </span>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  )
}

// Replaces the old score-percentage badge everywhere a recommendation is
// shown (Discover grid/list/stack, Today's Pick): a small clickable trigger
// that opens a popup with the AI's actual reasoning instead of a bare
// number nobody could interpret. `variant` only changes the trigger's
// chrome to fit where it's dropped in -- 'subtle' for a plain card/row
// header, 'hero' for the dark overlay atop a banner image.
export function WhyRecommendedButton({
  reasoning,
  sources,
  variant = 'subtle',
}: {
  reasoning?: string | null
  sources?: Record<string, number> | null
  variant?: 'subtle' | 'hero'
}) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          setOpen(true)
        }}
        className={
          variant === 'hero'
            ? 'flex items-center gap-1 bg-black/60 backdrop-blur-sm rounded-lg px-2.5 py-1.5 text-white/90 hover:text-white transition-colors shrink-0'
            : 'flex items-center gap-1 bg-accent/10 text-accent text-xs font-medium px-2 py-1 rounded hover:bg-accent/20 transition-colors shrink-0'
        }
      >
        <Sparkles size={variant === 'hero' ? 14 : 12} aria-hidden="true" />
        <span className={variant === 'hero' ? 'text-xs uppercase tracking-wider' : undefined}>
          Why this?
        </span>
      </button>
      {open && (
        <WhyRecommendedDialog
          reasoning={reasoning}
          sources={sources}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}
