import { useState } from 'react'
import { hueFromName } from '../lib/utils'
import { ArtistThumb } from './artist-thumb'

/**
 * Playlist artwork: the playlist's own cover (imports) when it has one,
 * otherwise a 2x2 collage of album covers from its tracks. Falls back to a
 * single cover with fewer than four, then ArtistThumb's letter placeholder.
 *
 * size - grid unit (Tailwind style, multiplied by 4 to get px). Default: 12.
 */
export function PlaylistCover({
  name,
  coverUrl,
  collageUrls,
  size = 12,
}: {
  name: string
  coverUrl?: string | null
  collageUrls?: string[]
  size?: number
}) {
  const [failed, setFailed] = useState<Set<string>>(new Set())
  const urls = (collageUrls ?? []).filter((u) => !failed.has(u))

  if (coverUrl || urls.length < 4) {
    return <ArtistThumb name={name} imageUrl={coverUrl ?? urls[0]} size={size} />
  }

  const px = size * 4
  return (
    <div
      className="grid grid-cols-2 grid-rows-2 rounded-md overflow-hidden shrink-0"
      style={{
        width: `${px}px`,
        height: `${px}px`,
        background: `hsl(${hueFromName(name)}, 40%, 35%)`,
      }}
      role="img"
      aria-label={name}
    >
      {urls.slice(0, 4).map((url) => (
        <img
          key={url}
          src={url}
          alt=""
          loading="lazy"
          decoding="async"
          className="w-full h-full object-cover"
          onError={() => setFailed((prev) => new Set(prev).add(url))}
        />
      ))}
    </div>
  )
}
