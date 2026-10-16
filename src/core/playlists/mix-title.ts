// Generates a short, evocative title for an auto-refreshed mix (Spotify
// Daily Mix / mediasage style) instead of a bare index or genre label --
// e.g. "Golden Hour Groove - Jul 2026". Regenerated fresh on every run so
// the date suffix stays current and the phrase varies day to day.

const TIME_OR_MOOD = [
  'Golden Hour',
  'Midnight',
  'Late Night',
  'Early Morning',
  'Sunday Morning',
  'Rainy Day',
  'Summer Nights',
  'Evenings',
  'Daybreak',
  'Afterglow',
  'Twilight',
  'Weekend',
  'Quiet Hours',
  'Open Road',
  'Slow Sunday',
] as const

const DESCRIPTORS = [
  'Gentle',
  'Wild',
  'Hazy',
  'Electric',
  'Velvet',
  'Quiet',
  'Restless',
  'Dreamy',
  'Neon',
  'Warm',
  'Easy',
  'Bright',
  'Soft',
  'Endless',
] as const

const NOUNS = [
  'Groove',
  'Whisper',
  'Drift',
  'Pulse',
  'Echo',
  'Reverie',
  'Bloom',
  'Static',
  'Wanderlust',
  'Glow',
  'Waves',
  'Motion',
  'Haze',
] as const

function pick<T>(pool: readonly T[]): T {
  return pool[Math.floor(Math.random() * pool.length)] as T
}

export function generateMixTitle(now: Date = new Date()): string {
  const parts: string[] = [pick(TIME_OR_MOOD)]
  if (Math.random() < 0.6) parts.push(pick(DESCRIPTORS))
  parts.push(pick(NOUNS))

  const month = now.toLocaleDateString('en-US', { month: 'short' })
  return `${parts.join(' ')} - ${month} ${now.getFullYear()}`
}

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase())
}

// Genre with the most artist hits across a bucket -- "good enough" as a
// stand-in for the bucket's defining genre (clusterIntoMixes in daily-mix.ts
// already grouped these artists by a shared genre tag in the first place)
// without threading that bucket metadata through the generic
// PlaylistStrategyImpl.selectArtists return type just for this one strategy.
export function pickDominantGenre(artists: Array<{ genres?: string[] | null }>): string | null {
  const counts = new Map<string, number>()
  for (const artist of artists) {
    for (const genre of artist.genres ?? []) {
      const key = genre.trim().toLowerCase()
      if (!key) continue
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  let best: string | null = null
  let bestCount = 0
  for (const [genre, count] of counts) {
    if (count > bestCount) {
      best = genre
      bestCount = count
    }
  }
  return best
}

// Daily Mix keeps its fixed "Daily Mix N" identity (so it stays recognizable
// slot-to-slot day over day) but pairs it with an evocative, genre-aware
// subtitle -- e.g. "Daily Mix 1: Golden Hour Indie Rock" -- instead of either
// a bare index or a fully random phrase disconnected from what's actually in
// the mix. Falls back to a plain evocative title when the bucket has no
// single dominant genre (the 'mixed' catch-all bucket in daily-mix.ts).
export function generateDailyMixTitle(
  mixIndex: number,
  genre: string | null,
  now: Date = new Date(),
): string {
  const label = `Daily Mix ${mixIndex + 1}`
  if (!genre || genre === 'mixed') return `${label}: ${generateMixTitle(now)}`

  const parts: string[] = [pick(TIME_OR_MOOD)]
  if (Math.random() < 0.5) parts.push(pick(DESCRIPTORS))
  parts.push(titleCase(genre))
  return `${label}: ${parts.join(' ')}`
}

const OPENERS = [
  'A rotating stretch of',
  'A curated run of',
  'A moving pocket of',
  'An evolving set of',
  'A quiet drift through',
  'A loose collection of',
] as const

// Mediasage's mood-quiz answers (energy/familiarity/vibe) as short adjective
// fragments -- lines up with the `fragment` strings buildQuizPrompt() already
// sends the AI in mediasage-section.tsx, just condensed for a one-line blurb.
const ENERGY_PHRASES: Record<string, string> = {
  chill: 'mellow, laid-back',
  upbeat: 'upbeat, energetic',
  intense: 'high-energy',
}
const VIBE_PHRASES: Record<string, string> = {
  focus: 'built for focus',
  party: 'built for a crowd',
  emotional: 'leaning emotional and introspective',
  background: 'easy to leave on in the background',
}

export type MixDescriptionContext = {
  genres?: string[]
  decades?: number[]
  energy?: string | null
  vibe?: string | null
}

// Generates a short, one-sentence blurb for a Mediasage playlist -- shown
// alongside its generated title (generateMixTitle above). Weaves in whatever
// the user actually picked (genre/decade filters, mood-quiz answers) instead
// of being purely random, falling back to the same evocative word banks when
// nothing was picked.
export function generateMixDescription(context: MixDescriptionContext = {}): string {
  const descriptors: string[] = []

  const energyPhrase = context.energy ? ENERGY_PHRASES[context.energy] : undefined
  if (energyPhrase) descriptors.push(energyPhrase)
  if (descriptors.length === 0 || Math.random() < 0.5)
    descriptors.push(pick(DESCRIPTORS).toLowerCase())

  const subjectParts: string[] = []
  if (context.genres && context.genres.length > 0) {
    subjectParts.push(context.genres.slice(0, 2).join(' and '))
  } else {
    subjectParts.push(pick(NOUNS).toLowerCase())
  }
  if (context.decades && context.decades.length > 0) {
    const decade = Math.min(...context.decades)
    subjectParts.push(`from the ${decade}s`)
  }

  const vibePhrase = context.vibe ? VIBE_PHRASES[context.vibe] : undefined

  const sentence = [
    pick(OPENERS),
    descriptors.join(', '),
    subjectParts.join(' '),
    vibePhrase ? `-- ${vibePhrase}.` : '.',
  ]
    .join(' ')
    .replace(/\s+\./g, '.')
    .replace(/\s+--/g, ' --')

  return sentence
}
