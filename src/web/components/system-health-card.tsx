import { useQuery } from '@tanstack/react-query'
import { CheckCircle2, CircleAlert, Loader2, TriangleAlert } from 'lucide-react'
import { getJobHealth, type JobHealth, type JobHealthEntry, type JobHealthStatus } from '../lib/api'
import { formatRelativeTime } from '../lib/format-time'

type Tone = 'ok' | 'warning' | 'failing' | 'idle'

const SOURCE_LABELS: Record<string, string> = {
  ai: 'AI suggestions',
  plex: 'Plex listening history',
  lastfm: 'Last.fm similar tracks',
  listenbrainz: 'ListenBrainz similar tracks',
  deezer: 'Deezer',
  spotify: 'Spotify',
}

function sourceDetail(s: JobHealth['sources'][number]): string {
  if (s.role === 'history') {
    if (!s.ok) return 'No listening history'
    return s.artists ? `${s.artists} of your top artists used as a starting point` : 'Working'
  }
  if (!s.ok) return 'Not contributing'
  if (!s.artists) return 'Working'
  return s.role === 'tracks'
    ? `Found ${s.artists} similar track${s.artists === 1 ? '' : 's'}`
    : `Suggested ${s.artists} artist${s.artists === 1 ? '' : 's'}`
}

function toneOf(status: JobHealthStatus): Tone {
  return status === 'never' ? 'idle' : status
}

const DOT: Record<Tone, string> = {
  ok: 'bg-approve',
  warning: 'bg-amber-400',
  failing: 'bg-reject',
  idle: 'bg-muted/50',
}

function formatUntil(iso: string): string {
  const mins = Math.round((new Date(iso).getTime() - Date.now()) / 60_000)
  if (mins < 1) return 'any moment'
  if (mins < 60) return `in ${mins} min`
  const hours = Math.round(mins / 60)
  if (hours < 48) return `in ${hours} hour${hours === 1 ? '' : 's'}`
  return `in ${Math.round(hours / 24)} days`
}

function lastLine(entry: JobHealthEntry, verb: string): string {
  if (entry.lastSuccessAt) return `Last ${verb} ${formatRelativeTime(entry.lastSuccessAt)}`
  return entry.status === 'never' ? "Hasn't run yet" : `Hasn't ${verb} successfully yet`
}

function Row({
  tone,
  title,
  detail,
  problem,
  running,
}: {
  tone: Tone
  title: string
  detail: string
  problem?: string | null
  running?: boolean
}) {
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center" aria-hidden>
        {running ? (
          <Loader2 size={14} className="animate-spin text-accent" />
        ) : (
          <span className={`h-2.5 w-2.5 rounded-full ${DOT[tone]}`} />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-text">{title}</p>
        <p className="text-xs text-muted">{running ? `Running now · ${detail}` : detail}</p>
        {problem && (
          <p
            className={`mt-1 text-xs break-words ${tone === 'failing' ? 'text-reject' : 'text-amber-400'}`}
          >
            {problem}
          </p>
        )}
      </div>
    </li>
  )
}

export function SystemHealthCard({ embedded = false }: { embedded?: boolean }) {
  const { data, isLoading } = useQuery({
    queryKey: ['job-health'],
    queryFn: getJobHealth,
    staleTime: 60_000,
    refetchInterval: 60_000,
  })

  if (isLoading || !data) {
    return (
      <div className="rounded-lg border border-border bg-surface p-4">
        <div className="h-24 animate-pulse rounded bg-surface-alt" />
      </div>
    )
  }

  const { discovery, playlists, librarySync, sources } = data
  const failedSources = sources.filter((s) => !s.ok)

  const discoveryDetail = [
    lastLine(discovery, 'finished'),
    discovery.nextRunAt ? `next ${formatUntil(discovery.nextRunAt)}` : 'not scheduled',
  ].join(' · ')

  const playlistDetail =
    playlists.recentRuns > 0
      ? playlists.recentFailures > 0
        ? `${playlists.recentFailures} of ${playlists.recentRuns} refreshes failed in the last day`
        : `${playlists.recentRuns} refresh${playlists.recentRuns === 1 ? '' : 'es'} in the last day, all fine`
      : lastLine(playlists, 'refreshed')

  const tones: Tone[] = [
    toneOf(discovery.status),
    toneOf(playlists.status),
    toneOf(librarySync.status),
    ...failedSources.map((): Tone => 'warning'),
  ]
  const overall: Tone = tones.includes('failing')
    ? 'failing'
    : tones.includes('warning')
      ? 'warning'
      : 'ok'
  const attention = tones.filter((t) => t === 'failing' || t === 'warning').length

  const Banner =
    overall === 'ok' ? CheckCircle2 : overall === 'failing' ? CircleAlert : TriangleAlert
  const bannerClass =
    overall === 'ok'
      ? 'border-approve/30 bg-approve/10 text-approve'
      : overall === 'failing'
        ? 'border-reject/30 bg-reject/10 text-reject'
        : 'border-amber-400/30 bg-amber-400/10 text-amber-400'

  return (
    <div className="space-y-4">
      <h2 className={embedded ? 'sr-only' : 'text-sm font-medium text-text'}>System Health</h2>

      <div className={`flex items-center gap-3 rounded-lg border px-4 py-3 ${bannerClass}`}>
        <Banner size={20} className="shrink-0" aria-hidden />
        <p className="text-sm font-medium">
          {overall === 'ok'
            ? 'Everything is running normally'
            : `${attention} thing${attention === 1 ? ' needs' : 's need'} attention`}
        </p>
      </div>

      <section aria-labelledby="health-jobs">
        <h3 id="health-jobs" className="px-1 mb-2 text-sm font-semibold text-text">
          Background jobs
        </h3>
        <ul className="rounded-lg border border-border bg-surface divide-y divide-border">
          <Row
            tone={toneOf(discovery.status)}
            title="Discovery"
            detail={discoveryDetail}
            problem={discovery.lastProblem?.error}
            running={discovery.running}
          />
          <Row
            tone={toneOf(playlists.status)}
            title="Playlist refreshes"
            detail={playlistDetail}
            problem={playlists.status !== 'ok' ? playlists.lastProblem?.error : null}
            running={playlists.running}
          />
          <Row
            tone={toneOf(librarySync.status)}
            title="Library sync"
            detail={lastLine(librarySync, 'synced')}
            problem={librarySync.lastProblem?.error}
            running={librarySync.running}
          />
        </ul>
      </section>

      {sources.length > 0 && (
        <section aria-labelledby="health-sources">
          <h3 id="health-sources" className="px-1 text-sm font-semibold text-text">
            Discovery sources
          </h3>
          <p className="px-1 mb-2 text-xs text-muted">What the last discovery run drew on.</p>
          <ul className="rounded-lg border border-border bg-surface divide-y divide-border">
            {sources.map((s) => (
              <Row
                key={s.name}
                tone={s.ok ? 'ok' : 'warning'}
                title={SOURCE_LABELS[s.name] ?? s.name}
                detail={sourceDetail(s)}
                problem={s.error}
              />
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
