import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Disc3 } from 'lucide-react'
import { Link, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { errMsg } from '@/core/validation'
import { Button } from '../components/ui/button'
import { createRequest, getRequestAlbumDetail } from '../lib/api'

function formatDuration(ms?: number): string | null {
  if (!ms || ms <= 0) return null
  const totalSeconds = Math.round(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

export function AlbumDetailsPage() {
  const { mbid } = useParams<{ mbid: string }>()
  const queryClient = useQueryClient()

  const albumQuery = useQuery({
    queryKey: ['request-album', mbid],
    queryFn: () => getRequestAlbumDetail(mbid as string),
    enabled: !!mbid,
  })

  const submit = useMutation({
    mutationFn: createRequest,
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['requests-mine'] })
      toast.success(
        result.status === 'dispatched'
          ? 'Request sent to Lidarr'
          : result.status === 'failed'
            ? 'Request approved, but Lidarr could not add it'
            : 'Request submitted for admin approval',
      )
    },
    onError: (err) => toast.error(errMsg(err)),
  })

  function requestThisAlbum() {
    const album = albumQuery.data
    if (!album || !mbid || !album.artistMbid || !album.artistName) return
    submit.mutate({
      kind: 'album',
      artistMbid: album.artistMbid,
      artistName: album.artistName,
      releaseGroupMbid: mbid,
      albumTitle: album.albumTitle,
      coverUrl: album.coverUrl,
    })
  }

  const album = albumQuery.data

  return (
    <div className="max-w-3xl mx-auto px-4 py-6 space-y-6">
      <Link
        to="/requests"
        className="text-sm text-muted hover:text-text inline-flex items-center gap-1"
      >
        <ArrowLeft size={14} />
        Back to search
      </Link>

      {albumQuery.isLoading && (
        <div className="bg-surface border border-border rounded-lg p-4 h-32 animate-pulse" />
      )}

      {albumQuery.isError && (
        <p className="text-sm text-reject text-center pt-8">Failed to load album</p>
      )}

      {album && (
        <div className="flex items-start gap-4 p-4 rounded-lg border border-border bg-surface">
          {album.coverUrl ? (
            <img
              src={album.coverUrl}
              alt=""
              className="w-24 h-24 rounded object-cover flex-shrink-0"
            />
          ) : (
            <div className="w-24 h-24 rounded bg-bg flex items-center justify-center flex-shrink-0">
              <Disc3 size={32} className="text-muted" />
            </div>
          )}
          <div className="flex-1 min-w-0">
            <h1 className="text-xl font-bold text-text">{album.albumTitle}</h1>
            {album.artistMbid ? (
              <Link
                to={`/requests/artist/${album.artistMbid}`}
                className="text-sm text-accent hover:underline"
              >
                {album.artistName}
              </Link>
            ) : (
              album.artistName && <p className="text-sm text-muted">{album.artistName}</p>
            )}
            {album.releaseDate && (
              <p className="text-xs text-muted mt-1">{album.releaseDate.slice(0, 4)}</p>
            )}
            {album.alreadyOwned ? (
              <span className="mt-3 inline-block text-xs text-approve px-2 py-1">
                Already in your library
              </span>
            ) : (
              <Button
                size="sm"
                className="mt-3"
                onClick={requestThisAlbum}
                disabled={submit.isPending || !album.artistMbid}
              >
                Request
              </Button>
            )}
          </div>
        </div>
      )}

      {album && album.tracks.length > 0 && (
        <div className="space-y-1">
          <h2 className="text-sm font-semibold text-muted uppercase tracking-wide mb-2">
            Tracklist
          </h2>
          {album.tracks.map((track) => (
            <div
              key={`${track.position}-${track.title}`}
              className="flex items-center gap-3 px-3 py-2 rounded-lg border border-border bg-surface text-sm"
            >
              <span className="text-muted w-6 text-right flex-shrink-0">{track.position}</span>
              <span className="flex-1 min-w-0 truncate text-text">{track.title}</span>
              {formatDuration(track.length) && (
                <span className="text-muted flex-shrink-0">{formatDuration(track.length)}</span>
              )}
            </div>
          ))}
        </div>
      )}

      {album && album.tracks.length === 0 && (
        <p className="text-sm text-muted text-center pt-4">No tracklist available</p>
      )}
    </div>
  )
}
