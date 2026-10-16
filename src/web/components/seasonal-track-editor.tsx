import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Plus, X } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import {
  addPlaylistTrackApi,
  getPlaylist,
  getPlaylistSuggestions,
  type PlaylistSuggestion,
  removePlaylistTrackApi,
} from '../lib/api'

const REASON_LABEL: Record<string, string> = {
  classic: 'Seasonal classic',
  title: 'Seasonal title',
  genre: 'Genre match',
  pinned: 'Added by you',
}

// Expanded view of one seasonal playlist: its current songs (each
// removable) and the next-best seasonal songs from the library to add in
// their place. Removed songs never come back on regeneration and added ones
// always stay (the server keeps both lists on the playlist's config).
export function SeasonalTrackEditor({
  playlistId,
  onChanged,
}: {
  playlistId: number
  onChanged: () => void
}) {
  const queryClient = useQueryClient()
  const [busyKey, setBusyKey] = useState<string | null>(null)

  // Keyed under 'playlists' so a finished regeneration (SSE invalidates
  // ['playlists']) refreshes both lists.
  const tracksQuery = useQuery({
    queryKey: ['playlists', playlistId, 'tracks'],
    queryFn: () => getPlaylist(playlistId),
  })
  const suggestionsQuery = useQuery({
    queryKey: ['playlists', playlistId, 'suggestions'],
    queryFn: () => getPlaylistSuggestions(playlistId),
    staleTime: 60_000,
  })

  function refresh() {
    queryClient.invalidateQueries({ queryKey: ['playlists', playlistId] })
    onChanged()
  }

  async function remove(trackId: number) {
    setBusyKey(`t${trackId}`)
    try {
      await removePlaylistTrackApi(playlistId, trackId)
      refresh()
    } catch {
      toast.error('Failed to remove song')
    } finally {
      setBusyKey(null)
    }
  }

  async function add(s: PlaylistSuggestion) {
    setBusyKey(`s${s.artistName}|${s.trackName}`)
    try {
      await addPlaylistTrackApi(playlistId, s)
      refresh()
    } catch {
      toast.error('Failed to add song')
    } finally {
      setBusyKey(null)
    }
  }

  const tracks = (tracksQuery.data?.tracks ?? []).slice().sort((a, b) => a.position - b.position)
  const suggestions = suggestionsQuery.data ?? []

  return (
    <div className="space-y-3">
      {tracksQuery.isLoading ? (
        <p className="text-xs text-muted py-1">Loading...</p>
      ) : tracks.length === 0 ? (
        <p className="text-xs text-muted py-1">
          No songs yet. Hit Generate to build it from your library.
        </p>
      ) : (
        <ul className="rounded-md border border-border/60 divide-y divide-border/60 overflow-hidden">
          {tracks.map((track, i) => (
            <li key={track.id} className="flex items-center gap-2 pl-2 pr-1 py-1 text-xs">
              <span className="w-5 text-right text-muted shrink-0">{i + 1}</span>
              <div className="min-w-0 flex-1">
                <p className="text-text truncate">{track.trackName ?? 'Unknown track'}</p>
                <p className="text-muted truncate">{track.artistName}</p>
              </div>
              <button
                type="button"
                onClick={() => remove(track.id)}
                disabled={busyKey !== null}
                className="p-1.5 text-muted hover:text-reject transition-colors disabled:opacity-40 shrink-0"
                aria-label={`Remove ${track.trackName ?? 'song'}`}
                title="Remove (won't come back when regenerated)"
              >
                {busyKey === `t${track.id}` ? (
                  <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                ) : (
                  <X size={14} aria-hidden="true" />
                )}
              </button>
            </li>
          ))}
        </ul>
      )}

      <div>
        <p className="text-micro font-semibold uppercase tracking-wide text-muted mb-1.5">
          Suggested replacements
        </p>
        {suggestionsQuery.isLoading ? (
          <p className="text-xs text-muted py-1 flex items-center gap-1.5">
            <Loader2 size={12} className="animate-spin" aria-hidden="true" />
            Searching your library for seasonal songs...
          </p>
        ) : suggestions.length === 0 ? (
          <p className="text-xs text-muted py-1">
            No other seasonal songs found in your library right now.
          </p>
        ) : (
          <ul className="rounded-md border border-dashed border-border/80 divide-y divide-border/60 overflow-hidden">
            {suggestions.map((s) => {
              const key = `s${s.artistName}|${s.trackName}`
              return (
                <li key={key} className="flex items-center gap-2 pl-2 pr-1 py-1 text-xs">
                  <div className="min-w-0 flex-1">
                    <p className="text-text truncate">{s.trackName}</p>
                    <p className="text-muted truncate">
                      {s.artistName}
                      {REASON_LABEL[s.reason] && (
                        <span className="text-muted/70"> · {REASON_LABEL[s.reason]}</span>
                      )}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => add(s)}
                    disabled={busyKey !== null}
                    className="p-1.5 text-muted hover:text-approve transition-colors disabled:opacity-40 shrink-0"
                    aria-label={`Add ${s.trackName}`}
                    title="Add to playlist (stays when regenerated)"
                  >
                    {busyKey === key ? (
                      <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                    ) : (
                      <Plus size={14} aria-hidden="true" />
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
