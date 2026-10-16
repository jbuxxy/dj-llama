import { isHttpUrl } from '@/core/validation'
import { cn } from '../lib/utils'

type StreamingLinksProps = {
  streamingUrls: Record<string, string> | null
  artistName: string
  // When set, this is an album-kind recommendation: streamingUrls (always
  // artist-level metadata) is ignored in favor of an artist+album search
  // link for every service, so links don't silently point at the artist's
  // page instead of the recommended album.
  albumTitle?: string
  // Spotify track URL for the recommended album's most popular song
  // (resolved by the caller via getAlbumPreview -- see todays-pick.tsx /
  // recommendation-card.tsx), used as the embed source in place of the
  // artist-level Spotify URL whenever albumTitle is set.
  spotifyTrackUrl?: string
  compact?: boolean
  onPlay?: () => void
  isPlaying?: boolean
  // Spread the links evenly across the full width of their row instead of
  // left-packing them -- opt-in so it doesn't change the other (narrower)
  // places this renders, like the swipe-stack card.
  fill?: boolean
}

function safeUrl(url: string): string {
  return isHttpUrl(url) ? url : '#'
}

type ServiceConfig = {
  label: string
  color: string
  fallback: (name: string) => string
}

const SERVICES: Record<string, ServiceConfig> = {
  spotify: {
    label: 'Spotify',
    color: 'var(--color-svc-spotify)',
    fallback: (name) => `https://open.spotify.com/search/${encodeURIComponent(name)}`,
  },
  youtube: {
    label: 'YT Music',
    color: 'var(--color-svc-youtube)',
    fallback: (name) => `https://music.youtube.com/search?q=${encodeURIComponent(name)}`,
  },
  appleMusic: {
    label: 'Apple Music',
    color: 'var(--color-svc-apple)',
    fallback: (name) => `https://music.apple.com/search?term=${encodeURIComponent(name)}`,
  },
  deezer: {
    label: 'Deezer',
    color: 'var(--color-svc-deezer)',
    fallback: (name) => `https://www.deezer.com/search/${encodeURIComponent(name)}`,
  },
  soundcloud: {
    label: 'SoundCloud',
    color: 'var(--color-svc-soundcloud)',
    fallback: () => '',
  },
}

const SERVICE_INITIALS: Record<string, string> = {
  spotify: 'SP',
  youtube: 'YT',
  appleMusic: 'AM',
  deezer: 'DZ',
  soundcloud: 'SC',
}

type SpotifyEmbedProps = {
  url: string
}

function extractSpotifyId(url: string): { type: string; id: string } | null {
  const match = url.match(/spotify\.com\/(artist|album|track)\/([A-Za-z0-9]+)/)
  if (!match?.[1] || !match[2]) return null
  return { type: match[1], id: match[2] }
}

function SpotifyEmbed({ url }: SpotifyEmbedProps) {
  const parsed = extractSpotifyId(url)
  if (!parsed) return null
  const embedUrl = `https://open.spotify.com/embed/${parsed.type}/${parsed.id}?utm_source=generator`
  return (
    <iframe
      src={embedUrl}
      width="100%"
      height="84"
      allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
      loading="lazy"
      className="rounded border border-border mt-2"
      title="Spotify preview"
    />
  )
}

export function StreamingLinks({
  streamingUrls,
  artistName,
  albumTitle,
  spotifyTrackUrl,
  compact = false,
  onPlay,
  isPlaying = false,
  fill = false,
}: StreamingLinksProps) {
  // Direct streamingUrls are always artist-level (extracted from the
  // artist's MB relations), so an album rec must never use them as-is --
  // fall through to a combined artist+album search for every service.
  const urls = albumTitle ? {} : (streamingUrls ?? {})
  const searchQuery = albumTitle ? `${artistName} ${albumTitle}` : artistName

  const links: Array<{ key: string; label: string; url: string; color: string }> = []

  for (const [key, config] of Object.entries(SERVICES)) {
    const direct = urls[key]
    if (direct) {
      links.push({ key, label: config.label, url: direct, color: config.color })
    } else if (config.fallback(searchQuery)) {
      links.push({
        key,
        label: config.label,
        url: config.fallback(searchQuery),
        color: config.color,
      })
    }
  }

  // Also include any extra keys from streamingUrls that aren't in SERVICES
  for (const [key, url] of Object.entries(urls)) {
    if (!SERVICES[key] && url) {
      links.push({ key, label: key, url, color: 'var(--color-svc-unknown)' })
    }
  }

  if (links.length === 0) return null

  // Never embed the artist's Spotify page on an album rec -- embed the
  // recommended album's most popular track instead (resolved by the
  // caller), or nothing if that lookup came up empty.
  const spotifyUrl = albumTitle ? spotifyTrackUrl : urls.spotify

  const columnCount = links.length + (onPlay ? 1 : 0)

  return (
    <div className="space-y-3">
      <div
        className={fill ? 'grid gap-1.5 w-full' : 'flex flex-wrap gap-1.5'}
        style={fill ? { gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))` } : undefined}
      >
        {onPlay && (
          <button
            type="button"
            onClick={onPlay}
            className={cn(
              'inline-flex items-center justify-center px-1.5 py-0.5 rounded text-micro font-bold border border-green-500/40 text-green-500 bg-surface/50 hover:opacity-80 transition-opacity',
              fill && 'w-full',
            )}
          >
            {isPlaying ? 'STOP' : 'PLAY'}
          </button>
        )}
        {links.map(({ key, label, url, color }) => (
          <a
            key={key}
            href={safeUrl(url)}
            target="_blank"
            rel="noopener noreferrer"
            title={label}
            style={{ borderColor: `${color}40`, color }}
            className={cn(
              'inline-flex items-center justify-center px-1.5 py-0.5 rounded text-micro font-bold border bg-surface/50 hover:opacity-80 transition-opacity',
              fill && 'w-full',
            )}
          >
            {SERVICE_INITIALS[key] ?? label.slice(0, 2).toUpperCase()}
          </a>
        ))}
      </div>
      {!compact && spotifyUrl && <SpotifyEmbed url={spotifyUrl} />}
    </div>
  )
}
