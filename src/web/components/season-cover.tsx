import { Ghost, type LucideIcon, Music, Snowflake, Sun, TreePalm, TreePine } from 'lucide-react'

// Fixed artwork per seasonal preset -- deliberately not theme tokens: this is
// cover art, so it looks the same in light and dark mode like album art does.
const SEASON_ART: Record<
  string,
  { icon: LucideIcon; accent?: LucideIcon; background: string; label: string }
> = {
  halloween: {
    icon: Ghost,
    background: 'linear-gradient(135deg, #f97316 0%, #9a3412 45%, #3b0764 100%)',
    label: 'Halloween',
  },
  christmas: {
    icon: TreePine,
    accent: Snowflake,
    background: 'linear-gradient(135deg, #dc2626 0%, #991b1b 45%, #14532d 100%)',
    label: 'Christmas',
  },
  summer: {
    icon: Sun,
    accent: TreePalm,
    background: 'linear-gradient(135deg, #facc15 0%, #f97316 50%, #0ea5e9 100%)',
    label: 'Summer',
  },
}

/** size - grid unit (Tailwind style, multiplied by 4 to get px). Default: 12. */
export function SeasonCover({ presetKey, size = 12 }: { presetKey: string; size?: number }) {
  const art = SEASON_ART[presetKey]
  const px = size * 4
  const Icon = art?.icon ?? Music
  const Accent = art?.accent
  return (
    <div
      className="relative rounded-md overflow-hidden shrink-0 flex items-center justify-center text-white"
      style={{
        width: `${px}px`,
        height: `${px}px`,
        background: art?.background ?? 'linear-gradient(135deg, #475569, #1e293b)',
      }}
      role="img"
      aria-label={art?.label ?? 'Seasonal playlist'}
    >
      <Icon size={px * 0.55} strokeWidth={1.75} className="drop-shadow-md" aria-hidden="true" />
      {Accent && (
        <Accent
          size={px * 0.3}
          strokeWidth={2}
          className="absolute top-0.5 right-0.5 opacity-80"
          aria-hidden="true"
        />
      )}
    </div>
  )
}
