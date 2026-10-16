import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Disc3, ListPlus, User as UserIcon } from 'lucide-react'
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { errMsg } from '@/core/validation'
import { ConfirmDialog } from '../components/confirm-dialog'
import { LibraryAlbumCoverageBadge } from '../components/library-album-coverage-badge'
import { Button } from '../components/ui/button'
import {
  createRequest,
  getAlbums,
  getLibraryAlbumCoverage,
  getRequestArtistDetail,
  type ReleaseGroup,
} from '../lib/api'

export function ArtistDiscographyPage() {
  const { mbid } = useParams<{ mbid: string }>()
  const queryClient = useQueryClient()
  const [confirmDiscography, setConfirmDiscography] = useState(false)

  const artistQuery = useQuery({
    queryKey: ['request-artist', mbid],
    queryFn: () => getRequestArtistDetail(mbid as string),
    enabled: !!mbid,
  })

  const albumsQuery = useQuery({
    queryKey: ['request-artist-albums', mbid],
    queryFn: () => getAlbums(mbid as string),
    enabled: !!mbid,
  })

  // Reused for both the header's aggregate badge and per-row "owned" marks,
  // rather than fetching coverage twice.
  const coverageQuery = useQuery({
    queryKey: ['library-album-coverage', mbid],
    queryFn: () => getLibraryAlbumCoverage(mbid as string),
    enabled: !!mbid,
    staleTime: 5 * 60_000,
  })
  const ownedAlbumMbids = new Set(coverageQuery.data?.owned.map((a) => a.albumMbid) ?? [])

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

  function requestAlbum(album: ReleaseGroup) {
    if (!artistQuery.data || !mbid) return
    submit.mutate({
      kind: 'album',
      artistMbid: mbid,
      artistName: artistQuery.data.artistName,
      releaseGroupMbid: album.id,
      albumTitle: album.title,
    })
  }

  function requestDiscography() {
    if (!artistQuery.data || !mbid) return
    submit.mutate({ kind: 'artist', artistMbid: mbid, artistName: artistQuery.data.artistName })
    setConfirmDiscography(false)
  }

  const albums = [...(albumsQuery.data ?? [])].sort((a, b) => {
    const ay = a.firstReleaseDate ? Number.parseInt(a.firstReleaseDate.slice(0, 4), 10) : 9999
    const by = b.firstReleaseDate ? Number.parseInt(b.firstReleaseDate.slice(0, 4), 10) : 9999
    return ay - by
  })

  return (
    <div className="max-w-3xl mx-auto px-4 py-6 space-y-6">
      <Link
        to="/requests"
        className="text-sm text-muted hover:text-text inline-flex items-center gap-1"
      >
        <ArrowLeft size={14} />
        Back to search
      </Link>

      {artistQuery.isLoading && (
        <div className="bg-surface border border-border rounded-lg p-4 h-24 animate-pulse" />
      )}

      {artistQuery.isError && (
        <p className="text-sm text-reject text-center pt-8">Failed to load artist</p>
      )}

      {artistQuery.data && (
        <div className="flex items-center gap-4 p-4 rounded-lg border border-border bg-surface">
          {artistQuery.data.coverUrl ? (
            <img
              src={artistQuery.data.coverUrl}
              alt=""
              className="w-16 h-16 rounded-full object-cover flex-shrink-0"
            />
          ) : (
            <div className="w-16 h-16 rounded-full bg-bg flex items-center justify-center flex-shrink-0">
              <UserIcon size={28} className="text-muted" />
            </div>
          )}
          <div className="flex-1 min-w-0">
            <h1 className="text-xl font-bold text-text truncate">{artistQuery.data.artistName}</h1>
            {artistQuery.data.genres.length > 0 && (
              <p className="text-xs text-muted truncate">
                {artistQuery.data.genres.slice(0, 4).join(', ')}
              </p>
            )}
            <LibraryAlbumCoverageBadge artistMbid={mbid as string} />
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setConfirmDiscography(true)}
            disabled={submit.isPending}
          >
            <ListPlus size={14} className="mr-1" />
            Add discography
          </Button>
        </div>
      )}

      {albumsQuery.isLoading && (
        <div className="grid gap-2">
          {['disc-skeleton-1', 'disc-skeleton-2', 'disc-skeleton-3'].map((key) => (
            <div
              key={key}
              className="bg-surface border border-border rounded-lg p-3 h-14 animate-pulse"
            />
          ))}
        </div>
      )}

      {albumsQuery.isError && (
        <p className="text-sm text-reject text-center pt-4">Failed to load discography</p>
      )}

      {!albumsQuery.isLoading && albums.length === 0 && (
        <p className="text-sm text-muted text-center pt-4">No albums found for this artist</p>
      )}

      {albums.length > 0 && (
        <div className="space-y-2">
          {albums.map((album) => (
            <div
              key={album.id}
              className="flex items-center gap-3 p-3 rounded-lg border border-border bg-surface"
            >
              <div className="w-10 h-10 rounded bg-bg flex items-center justify-center flex-shrink-0">
                <Disc3 size={18} className="text-muted" />
              </div>
              <Link to={`/requests/album/${album.id}`} className="flex-1 min-w-0 hover:underline">
                <p className="text-sm font-medium text-text truncate">{album.title}</p>
                <p className="text-xs text-muted truncate">
                  {album.type}
                  {album.firstReleaseDate ? ` · ${album.firstReleaseDate.slice(0, 4)}` : ''}
                  {ownedAlbumMbids.has(album.id) && (
                    <span className="ml-2 text-approve">Owned</span>
                  )}
                </p>
              </Link>
              <Button
                size="icon"
                variant="outline"
                onClick={() => requestAlbum(album)}
                disabled={submit.isPending}
                aria-label="Request"
                title="Request"
              >
                <ListPlus size={16} />
              </Button>
            </div>
          ))}
        </div>
      )}

      {confirmDiscography && artistQuery.data && (
        <ConfirmDialog
          title="Request entire discography?"
          message={`This will monitor and download every album by ${artistQuery.data.artistName} -- not just one. It always needs admin approval, even for trusted accounts. Continue?`}
          confirmLabel="Request whole discography"
          onConfirm={requestDiscography}
          onCancel={() => setConfirmDiscography(false)}
        />
      )}
    </div>
  )
}
