import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { getSimilarArtists } from '../lib/api'
import { ArtistThumb } from './artist-thumb'
import { Skeleton } from './ui/skeleton'

// "Sounds like": nearest artists by embedding (no AI call -- an in-memory
// lookup). Renders nothing when the AI provider can't embed or there's no
// vector for this artist yet, so it can be dropped in anywhere.
export function SimilarArtists({
  mbid,
  name,
  limit = 8,
  title = 'Sounds like',
}: {
  mbid?: string | null
  name: string
  limit?: number
  title?: string
}) {
  const { data, isLoading } = useQuery({
    queryKey: ['similar-artists', mbid ?? name, limit],
    queryFn: () => getSimilarArtists({ mbid, name }, limit),
    staleTime: 10 * 60_000,
  })
  if (isLoading) {
    return (
      <div className="flex gap-3">
        {['a', 'b', 'c', 'd'].map((k) => (
          <Skeleton key={k} className="h-14 w-14 rounded-full" />
        ))}
      </div>
    )
  }
  if (!data?.available || data.artists.length === 0) return null
  return (
    <div>
      <p className="text-xs text-muted uppercase tracking-wide mb-2">{title}</p>
      <ul className="flex gap-3 overflow-x-auto pb-1 -mx-1 px-1">
        {data.artists.map((a) => {
          const body = (
            <>
              <ArtistThumb name={a.name} imageUrl={a.imageUrl} size={14} className="mx-auto" />
              <p className="mt-1 text-xs text-text truncate group-hover:text-accent">{a.name}</p>
              {a.owned && <p className="text-micro text-muted">In library</p>}
            </>
          )
          return (
            <li key={a.mbid ?? a.name} className="shrink-0 w-16 text-center">
              {a.mbid ? (
                <Link to={`/requests/artist/${a.mbid}`} className="block group" title={a.name}>
                  {body}
                </Link>
              ) : (
                <div title={a.name}>{body}</div>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
