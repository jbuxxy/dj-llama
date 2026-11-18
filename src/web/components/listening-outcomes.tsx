import { Link } from 'react-router-dom'
import type { DashboardOutcomes, OutcomeItem } from '../lib/api'
import { ArtistThumb } from './artist-thumb'
import { Skeleton } from './ui/skeleton'

// "Did it stick?" -- how approvals turned out once they reached the library,
// judged from Plex plays (see core/listening/outcomes.ts).
export function ListeningOutcomes({
  data,
  loading,
}: {
  data: DashboardOutcomes | undefined
  loading: boolean
}) {
  if (loading) {
    return (
      <div className="bg-surface border border-border rounded-lg p-4 space-y-3">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    )
  }
  if (!data) return null
  const { summary, hitRate, keepers, unplayed, rules } = data
  const decided = summary.keepers + summary.tried + summary.unplayed

  if (decided === 0) {
    return (
      <div className="bg-surface border border-border rounded-lg p-4">
        <p className="text-sm text-muted text-center py-2">
          {summary.pending > 0
            ? `Watching ${summary.pending} approval${summary.pending === 1 ? '' : 's'} that landed in your library. An artist becomes a keeper after ${rules.keeperPlays} plays on ${rules.keeperDays}+ days; others are judged after ${rules.windowDays} days.`
            : 'Once approved artists land in your library, DJ Llama watches whether you actually play them, and learns from it.'}
        </p>
      </div>
    )
  }

  return (
    <div className="bg-surface border border-border rounded-lg p-4 space-y-4">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
        <div>
          <p className="text-3xl font-semibold text-text tabular-nums">
            {hitRate == null ? '--' : `${Math.round(hitRate * 100)}%`}
          </p>
          <p className="text-xs text-muted">of approvals became keepers</p>
        </div>
        <dl className="flex gap-4 text-xs">
          <Stat label="Keepers" value={summary.keepers} />
          <Stat label="Tried" value={summary.tried} />
          <Stat label="Never played" value={summary.unplayed} />
          {summary.pending > 0 && <Stat label="Watching" value={summary.pending} />}
        </dl>
      </div>
      {keepers.length > 0 && <OutcomeRow title="Your keepers" items={keepers} showPlays />}
      {unplayed.length > 0 && <OutcomeRow title="Never played" items={unplayed} />}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-muted">{label}</dt>
      <dd className="text-sm font-medium text-text tabular-nums">{value}</dd>
    </div>
  )
}

function OutcomeRow({
  title,
  items,
  showPlays = false,
}: {
  title: string
  items: OutcomeItem[]
  showPlays?: boolean
}) {
  return (
    <div>
      <p className="text-xs font-medium text-muted mb-2">{title}</p>
      <ul className="flex gap-3 overflow-x-auto pb-1 -mx-1 px-1">
        {items.map((item) => (
          <li key={item.id} className="shrink-0 w-20">
            <Link
              to={`/requests/artist/${item.artistMbid}`}
              className="block group"
              title={item.albumTitle ? `${item.artistName} — ${item.albumTitle}` : item.artistName}
            >
              <ArtistThumb name={item.artistName} imageUrl={item.imageUrl} size={20} />
              <p className="mt-1 text-xs text-text truncate group-hover:text-accent">
                {item.artistName}
              </p>
              {showPlays && (
                <p className="text-[11px] text-muted tabular-nums">
                  {item.plays} play{item.plays === 1 ? '' : 's'}
                </p>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}
