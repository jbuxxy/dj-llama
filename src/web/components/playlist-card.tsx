import { Pencil, Upload } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { deletePlaylistApi, type PlaylistRow, pushPlaylistApi } from '../lib/api'
import {
  formatPlaylistRelativeTime,
  formatSchedule,
  STATUS_BADGES,
  strategyBadge,
} from '../lib/playlist-format'
import {
  DeleteButton,
  DuplicateButton,
  EnabledToggle,
  GenerateButton,
  SweepLiveTracksButton,
} from './playlist-row-actions'

export { formatSchedule } from '../lib/playlist-format'
export { Toggle } from './toggle'

type PlaylistCardProps = {
  playlist: PlaylistRow
  onEdit: () => void
  onRefetch: () => void
}

export function PlaylistCard({ playlist, onEdit, onRefetch }: PlaylistCardProps) {
  const [pushing, setPushing] = useState(false)
  const navigate = useNavigate()

  const badge = strategyBadge(playlist.strategy)
  const statusBadge = STATUS_BADGES[playlist.status]
  const pendingReview = playlist.status === 'pending_review'

  async function handlePush() {
    setPushing(true)
    try {
      await pushPlaylistApi(playlist.id)
      toast.success('Pushed to Plex')
      onRefetch()
    } catch {
      toast.error('Failed to push playlist')
    } finally {
      setPushing(false)
    }
  }

  // Rejecting a still-pending AI suggestion before it's ever been pushed is
  // low-stakes by design -- unlike DeleteButton's confirm-gated delete of a
  // real playlist, this deliberately skips confirmation.
  async function handleReject() {
    try {
      await deletePlaylistApi(playlist.id)
      toast.success('Playlist rejected')
      onRefetch()
    } catch {
      toast.error('Failed to reject playlist')
    }
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: intentional div[role=button] - action buttons nested inside prevent using <button>
    <div
      role="button"
      tabIndex={0}
      onClick={() => navigate(`/playlists/${playlist.id}`)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') navigate(`/playlists/${playlist.id}`)
      }}
      className="bg-surface border border-border rounded-lg p-4 hover:border-accent/40 transition-colors space-y-3 cursor-pointer"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p
            className="font-semibold text-text text-sm leading-snug truncate"
            title={playlist.name}
          >
            {playlist.name}
          </p>
          {playlist.description && (
            <p className="text-xs text-muted mt-0.5 line-clamp-2">{playlist.description}</p>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {statusBadge && (
            <span
              className={`text-micro-lg font-medium px-2 py-0.5 rounded-full ${statusBadge.className}`}
            >
              {statusBadge.label}
            </span>
          )}
          <span className={`text-micro-lg font-medium px-2 py-0.5 rounded-full ${badge.className}`}>
            {badge.label}
          </span>
        </div>
      </div>

      <div className="space-y-1 text-xs text-muted">
        <div className="flex items-center gap-3">
          <span>
            Schedule: <span className="text-text">{formatSchedule(playlist.schedule)}</span>
          </span>
          {playlist.trackCount != null && (
            <span>
              Tracks: <span className="text-text">{playlist.trackCount}</span>
            </span>
          )}
        </div>
        <div>
          Last generated:{' '}
          <span className="text-text">
            {formatPlaylistRelativeTime(playlist.lastGeneratedAt, 'Never')}
          </span>
        </div>
        {pendingReview && playlist.reviewExpiresAt && (
          <div>
            Expires:{' '}
            <span className="text-text">
              {formatPlaylistRelativeTime(playlist.reviewExpiresAt, 'Never')}
            </span>
          </div>
        )}
      </div>

      <div
        className="flex items-center justify-between gap-2 pt-1 border-t border-border"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        role="none"
      >
        {/* Left: (push + reject when pending review, else generate) + edit + delete */}
        <div className="flex items-center gap-1">
          {pendingReview ? (
            <>
              <button
                type="button"
                onClick={handlePush}
                disabled={pushing}
                className="flex items-center gap-1 px-2.5 py-1.5 text-xs bg-approve/15 text-approve rounded hover:bg-approve/25 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                title="Push to Plex"
              >
                <Upload size={12} aria-hidden="true" />
                {pushing ? 'Pushing…' : 'Push to Plex'}
              </button>
              <button
                type="button"
                onClick={handleReject}
                className="px-2.5 py-1.5 text-xs text-reject rounded hover:bg-reject/10 transition-colors"
                title="Reject"
              >
                Reject
              </button>
            </>
          ) : (
            <GenerateButton playlistId={playlist.id} onGenerated={onRefetch} />
          )}
          <button
            type="button"
            onClick={onEdit}
            className="p-1.5 text-muted hover:text-text transition-colors"
            title="Edit playlist"
            aria-label="Edit playlist"
          >
            <Pencil size={14} aria-hidden="true" />
          </button>
          <DuplicateButton playlistId={playlist.id} />
          {playlist.pushedToPlex && <SweepLiveTracksButton playlistId={playlist.id} />}
          <DeleteButton playlistId={playlist.id} onDeleted={onRefetch} />
        </div>

        <EnabledToggle playlistId={playlist.id} enabled={playlist.enabled} />
      </div>

      {!playlist.enabled && (
        <p className="text-micro-lg text-muted/60 text-center -mt-1">Disabled</p>
      )}
    </div>
  )
}
