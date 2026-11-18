import { useQuery } from '@tanstack/react-query'
import { Download, Pencil } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { strategyPolicy } from '@/core/playlists/policy'
import { Hint } from '../components/hint'
import { EnergyArc, OrderToggle, TrackAudioBadges } from '../components/playlist-energy'
import { GenerateButton, SweepLiveTracksButton } from '../components/playlist-row-actions'
import { Skeleton } from '../components/ui/skeleton'
import {
  exportPlaylistApi,
  getPlaylist,
  getPlaylistMissingTracks,
  type PlaylistMissingTrack,
  type PlaylistRow,
  type PlaylistTrackRow,
} from '../lib/api'
import { formatPlaylistRelativeTime, formatSchedule, strategyBadge } from '../lib/playlist-format'

const SOURCE_BADGES: Record<string, { label: string; className: string }> = {
  local: { label: 'Local', className: 'bg-surface text-muted border border-border' },
  spotify: { label: 'Spotify', className: 'bg-green-500/15 text-green-400' },
  deezer: { label: 'Deezer', className: 'bg-purple-500/15 text-purple-400' },
  musicbrainz: { label: 'MusicBrainz', className: 'bg-blue-500/15 text-blue-400' },
}

function detectSource(track: PlaylistTrackRow): string {
  if (track.localPath) return 'local'
  if (track.spotifyUri) return 'spotify'
  if (track.deezerId) return 'deezer'
  if (track.mbid) return 'musicbrainz'
  return 'local'
}

function DetailSkeleton() {
  return (
    <div className="p-6 space-y-6 max-w-4xl mx-auto">
      <Skeleton className="h-4 w-24" />
      <div className="space-y-2">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-48" />
      </div>
      <div className="flex gap-2">
        <Skeleton className="h-8 w-28 rounded-md" />
        <Skeleton className="h-8 w-16 rounded-md" />
      </div>
      <div className="space-y-2">
        {[1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className="h-10 w-full rounded-lg" />
        ))}
      </div>
    </div>
  )
}

// Imports mirror a source playlist into Plex, so what matters per track is
// whether it's in the library yet, not where the metadata came from.
const IMPORT_BADGES = {
  found: { label: 'In library', className: 'bg-accent/15 text-accent' },
  missing: { label: 'Missing', className: 'bg-amber-500/15 text-amber-400' },
}

const trackKey = (artistName: string, trackName: string | null) =>
  `${artistName.toLowerCase()}::${(trackName ?? '').toLowerCase()}`

function TrackRow({
  track,
  index,
  missing,
}: {
  track: PlaylistTrackRow
  index: number
  /** Imports only: undefined = not an import, null = matched in Plex. */
  missing?: PlaylistMissingTrack | null
}) {
  const source = detectSource(track)
  const badge =
    missing !== undefined
      ? IMPORT_BADGES[missing ? 'missing' : 'found']
      : (SOURCE_BADGES[source] ?? {
          label: source,
          className: 'bg-surface text-muted border border-border',
        })
  const requesting = missing?.resolvedAlbumTitle

  return (
    <div className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-surface transition-colors">
      <span className="w-6 text-right text-xs text-muted shrink-0">{index + 1}</span>
      <div className="flex-1 min-w-0">
        <p className="text-sm text-text truncate">
          {track.trackName ?? <span className="text-muted italic">Unknown track</span>}
        </p>
        <p className="text-xs text-muted truncate">
          {track.artistName}
          {requesting && ` · Requesting ${requesting}`}
        </p>
      </div>
      <TrackAudioBadges audio={track.audio} />
      <span
        className={`shrink-0 text-micro font-medium px-1.5 py-0.5 rounded ${badge.className}`}
        title={
          missing
            ? missing.reason === 'search_error'
              ? 'Plex search failed last sync -- this may resolve on its own next sync.'
              : 'Not in your Plex library yet -- DJ Llama requests it from Lidarr.'
            : undefined
        }
      >
        {badge.label}
      </span>
    </div>
  )
}

function countMissing(
  tracks: PlaylistTrackRow[],
  missingByKey: Map<string, PlaylistMissingTrack>,
): number {
  return tracks.filter((t) => missingByKey.has(trackKey(t.artistName, t.trackName))).length
}

function PlaylistActions({
  playlist,
  onEdit,
  onRefetch,
}: {
  playlist: PlaylistRow
  onEdit: () => void
  onRefetch: () => void
}) {
  const [exporting, setExporting] = useState<string | null>(null)

  async function handleExport(format: 'm3u' | 'xspf') {
    setExporting(format)
    try {
      await exportPlaylistApi(playlist.id, format)
      toast.success(`${format.toUpperCase()} downloaded`)
    } catch {
      toast.error('Failed to download playlist')
    } finally {
      setExporting(null)
    }
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <GenerateButton playlistId={playlist.id} onGenerated={onRefetch} size="lg" />
      {playlist.pushedToPlex && <SweepLiveTracksButton playlistId={playlist.id} labeled />}
      {(['m3u', 'xspf'] as const).map((format) => (
        <button
          key={format}
          type="button"
          onClick={() => handleExport(format)}
          disabled={exporting !== null}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-surface border border-border rounded-md text-sm text-muted hover:text-text transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
        >
          <Download size={14} aria-hidden="true" />
          {exporting === format ? 'Downloading...' : `Download ${format.toUpperCase()}`}
        </button>
      ))}
      <button
        type="button"
        onClick={onEdit}
        className="flex items-center gap-1.5 px-3 py-1.5 bg-surface border border-border rounded-md text-sm text-muted hover:text-text transition-colors"
      >
        <Pencil size={14} aria-hidden="true" />
        Edit
      </button>
    </div>
  )
}

export function PlaylistDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const numId = Number(id)

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['playlists', numId],
    queryFn: () => getPlaylist(numId),
    enabled: !Number.isNaN(numId),
  })

  const isImport = !!data && strategyPolicy(data.playlist.strategy).generation === 'import'
  // Same key as the Playlists page's missing-tracks list, so both stay in
  // sync and refresh on the same 'playlists' invalidation.
  const { data: missingTracks } = useQuery({
    queryKey: ['playlists', numId, 'missing-tracks'],
    queryFn: () => getPlaylistMissingTracks(numId),
    enabled: isImport,
  })
  const missingByKey = useMemo(
    () => new Map((missingTracks ?? []).map((m) => [trackKey(m.artistName, m.trackName), m])),
    [missingTracks],
  )

  function handleEdit() {
    // Navigate back to playlists and trigger edit via state
    navigate('/playlists', { state: { editId: numId } })
  }

  if (isLoading) return <DetailSkeleton />

  if (error || !data) {
    return (
      <div className="p-6 max-w-4xl mx-auto">
        <button
          type="button"
          onClick={() => navigate('/playlists')}
          className="text-sm text-muted hover:text-text transition-colors"
        >
          &larr; Back to Playlists
        </button>
        <div className="py-16 text-center">
          <p className="text-muted text-sm">Playlist not found.</p>
        </div>
      </div>
    )
  }

  const { playlist, tracks } = data
  const badge = strategyBadge(playlist.strategy)

  return (
    <div className="p-6 space-y-6 max-w-4xl mx-auto pb-24 md:pb-6">
      {/* Back nav */}
      <button
        type="button"
        onClick={() => navigate('/playlists')}
        className="text-sm text-muted hover:text-text transition-colors"
      >
        &larr; Back to Playlists
      </button>

      {/* Title + meta */}
      <div className="space-y-3">
        <div className="flex items-start gap-3 flex-wrap">
          <h1 className="text-2xl font-bold text-text leading-tight">{playlist.name}</h1>
          <span
            className={`mt-0.5 text-micro-lg font-medium px-2 py-0.5 rounded-full ${badge.className}`}
          >
            {badge.label}
          </span>
        </div>
        <div className="flex flex-wrap gap-4 text-xs text-muted">
          <span>
            Schedule: <span className="text-text">{formatSchedule(playlist.schedule)}</span>
          </span>
          <span>
            Last generated:{' '}
            <span className="text-text">
              {formatPlaylistRelativeTime(playlist.lastGeneratedAt, 'Never')}
            </span>
          </span>
          {playlist.trackCount != null && (
            <span>
              Tracks: <span className="text-text">{playlist.trackCount}</span>
            </span>
          )}
          {!playlist.enabled && <span className="text-muted/60 italic">Disabled</span>}
        </div>
      </div>

      {isImport ? (
        <Hint id="playlist-detail-import-tip" type="inline">
          This playlist mirrors one from another service. Each sync matches its songs against your
          Plex library and requests the missing ones from Lidarr. Generate syncs it now.
        </Hint>
      ) : (
        <Hint id="playlist-detail-intro-tip" type="inline">
          This playlist was generated from your approved recommendations. Click Generate to refresh
          it with new picks, download it as M3U or XSPF, or add a playlist target to push future
          runs to Plex automatically.
        </Hint>
      )}

      {/* Actions */}
      <PlaylistActions playlist={playlist} onEdit={handleEdit} onRefetch={() => refetch()} />

      {!isImport && <EnergyArc tracks={[...tracks].sort((a, b) => a.position - b.position)} />}

      {/* Track listing */}
      <div className="space-y-1">
        <div className="flex items-center justify-between mb-2 gap-2">
          <p className="text-xs text-muted uppercase tracking-wide font-semibold">Tracks</p>
          <div className="flex items-center gap-3">
            {strategyPolicy(playlist.strategy).sequencing === 'dj' && (
              <OrderToggle
                playlistId={playlist.id}
                config={playlist.config}
                onSaved={() => refetch()}
              />
            )}
            {tracks.length > 0 && (
              <span className="text-xs text-muted">
                {isImport && missingTracks
                  ? `${tracks.length} total · ${countMissing(tracks, missingByKey)} missing`
                  : `${tracks.length} total`}
              </span>
            )}
          </div>
        </div>
        {tracks.length === 0 ? (
          <div className="py-12 text-center bg-surface border border-border rounded-lg">
            <p className="text-muted text-sm">
              {isImport
                ? 'No tracks yet. Generate to sync it from the source playlist.'
                : 'No tracks yet. Generate the playlist to populate it.'}
            </p>
          </div>
        ) : (
          <div className="bg-surface border border-border rounded-lg divide-y divide-border overflow-hidden">
            {tracks
              .slice()
              .sort((a, b) => a.position - b.position)
              .map((track, i) => (
                <TrackRow
                  key={track.id}
                  track={track}
                  index={i}
                  missing={
                    isImport
                      ? (missingByKey.get(trackKey(track.artistName, track.trackName)) ?? null)
                      : undefined
                  }
                />
              ))}
          </div>
        )}
      </div>
    </div>
  )
}
