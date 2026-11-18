import { useState } from 'react'
import { toast } from 'sonner'
import { type PlaylistConfig, type PlaylistTrackRow, updatePlaylistApi } from '../lib/api'
import { cn } from '../lib/utils'

// The playlist's energy, track by track -- one column per track in play
// order, so a DJ-ordered list reads as warm-up, peak, cool-down. Tracks not
// analyzed yet are a short muted stub rather than a gap.
export function EnergyArc({ tracks }: { tracks: PlaylistTrackRow[] }) {
  const [hover, setHover] = useState<number | null>(null)
  const analyzed = tracks.filter((t) => t.audio?.energy != null).length
  if (analyzed < 3) return null
  const active = hover != null ? tracks[hover] : null
  return (
    <div className="bg-surface border border-border rounded-lg p-3">
      <div className="flex items-baseline justify-between mb-2 gap-2">
        <p className="text-xs text-muted uppercase tracking-wide font-semibold">Energy</p>
        <p className="text-xs text-text truncate min-h-4" aria-live="polite">
          {active
            ? `${hover != null ? hover + 1 : ''}. ${active.trackName ?? active.artistName}${
                active.audio?.energy != null
                  ? ` · energy ${Math.round(active.audio.energy * 100)}`
                  : ''
              }${active.audio?.bpm ? ` · ${Math.round(active.audio.bpm)} BPM` : ''}${
                active.audio?.camelot ? ` · ${active.audio.camelot}` : ''
              }`
            : `${analyzed} of ${tracks.length} tracks analyzed`}
        </p>
      </div>
      <div className="flex items-end gap-[2px] h-12">
        {tracks.map((t, i) => {
          const e = t.audio?.energy
          return (
            <button
              type="button"
              key={t.id}
              className="flex-1 h-full flex flex-col justify-end focus:outline-none group"
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(null)}
              aria-label={`Track ${i + 1}: ${e != null ? `energy ${Math.round(e * 100)}` : 'not analyzed'}`}
            >
              <span
                className={cn(
                  'block w-full rounded-t-[3px]',
                  e == null ? 'bg-border' : hover === i ? 'bg-accent' : 'bg-accent/70',
                  'group-focus-visible:ring-2 group-focus-visible:ring-accent',
                )}
                style={{ height: e == null ? '2px' : `${Math.max(6, e * 100)}%` }}
              />
            </button>
          )
        })}
      </div>
    </div>
  )
}

export function TrackAudioBadges({ audio }: { audio: PlaylistTrackRow['audio'] }) {
  if (!audio || (audio.bpm == null && !audio.camelot)) return null
  return (
    <span className="hidden sm:flex shrink-0 items-center gap-1.5 text-micro text-muted tabular-nums">
      {audio.bpm != null && <span title="Tempo">{Math.round(audio.bpm)} BPM</span>}
      {audio.camelot && (
        <span
          className="px-1 rounded border border-border"
          title={audio.keyName ? `Key: ${audio.keyName}` : 'Key'}
        >
          {audio.camelot}
        </span>
      )}
    </span>
  )
}

/** DJ order vs plain shuffle for one playlist; applies on the next Generate. */
export function OrderToggle({
  playlistId,
  config,
  onSaved,
}: {
  playlistId: number
  config: PlaylistConfig | null | undefined
  onSaved: () => void
}) {
  const current = config?.order ?? 'dj'
  const [saving, setSaving] = useState(false)
  async function set(order: 'dj' | 'shuffle') {
    if (order === current || saving) return
    setSaving(true)
    try {
      await updatePlaylistApi(playlistId, {
        config: { ...(config ?? { trackSourcePriority: ['local'] }), order } as PlaylistConfig,
      })
      toast.success(
        order === 'dj'
          ? 'DJ order on: the next Generate sequences by key, tempo and energy'
          : 'Shuffle on: the next Generate keeps a plain shuffle',
      )
      onSaved()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }
  return (
    <fieldset
      className="flex rounded-md border border-border overflow-hidden text-xs"
      disabled={saving}
    >
      <legend className="sr-only">Track order</legend>
      {(
        [
          ['dj', 'DJ order'],
          ['shuffle', 'Shuffle'],
        ] as const
      ).map(([value, label]) => (
        <button
          key={value}
          type="button"
          aria-pressed={current === value}
          onClick={() => set(value)}
          className={cn(
            'px-2.5 py-1',
            current === value ? 'bg-accent text-accent-fg' : 'text-muted hover:text-text',
          )}
        >
          {label}
        </button>
      ))}
    </fieldset>
  )
}
