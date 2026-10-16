import type { LikedTrackEntry, RecentlyAddedEntry } from '@/core/plugins/types'
import type { TasteProfile, TrackTasteProfile, TrackTasteSignal } from '@/core/types'

export type RecentPlayEntry = {
  artistName: string
  trackName?: string
  playedAt: Date
}

// Deliberately decoupled from the `requests` DB row shape -- callers map
// their own query result into this. IMPORTANT: `requestHistory` must already
// be scoped to the single user this profile is being built for (e.g.
// `listRequestsForUser(db, userId, { limit: 50 })`); this module has no
// user-id concept of its own and will happily weight whatever it's handed.
export type RequestHistoryEntry = {
  artistName: string
  albumTitle?: string
  createdAt: Date
}

const LIKED_WEIGHT = 1.0
const RECENT_PLAY_WEIGHT = 0.6
const RECENT_PLAY_HALF_LIFE_DAYS = 30
const REQUEST_HISTORY_WEIGHT = 0.3
const REQUEST_HISTORY_LIMIT = 50
// Weaker than a real play (you haven't necessarily heard it yet) but a real,
// explicit signal worth including: what you've been adding to the library
// says something about current taste even before you've listened. Shorter
// half-life than recent plays -- a fresh add should show up in the taste
// picture right away, then fade back out over a few weeks rather than
// permanently skewing things toward whatever was imported last.
const RECENTLY_ADDED_WEIGHT = 0.5
const RECENTLY_ADDED_HALF_LIFE_DAYS = 21
// Reuses score.ts's existing artist popularity map (Spotify popularity,
// already normalized 0..1 by getPopularityMap()) as a third blended signal --
// "liked + recent + popular" combined into the one pool, per the explicit
// ask that these three not stay separate. Only boosts artists already
// present from liked/recent/request signals; never introduces a new artist
// on popularity alone.
const POPULAR_WEIGHT = 0.4

function normalize(value: string): string {
  return value.trim().toLowerCase()
}

function dedupeKey(
  signal: Pick<TrackTasteSignal, 'mbid' | 'artistName' | 'trackName' | 'albumTitle'>,
): string {
  if (signal.mbid) return `mbid:${signal.mbid}`
  if (signal.trackName)
    return `track:${normalize(signal.artistName)}::${normalize(signal.trackName)}`
  if (signal.albumTitle)
    return `album:${normalize(signal.artistName)}::${normalize(signal.albumTitle)}`
  return `artist:${normalize(signal.artistName)}`
}

function decayWeight(date: Date | undefined, halfLifeDays: number, now: Date): number {
  if (!date || Number.isNaN(date.getTime())) return 1
  const ageDays = Math.max(0, (now.getTime() - date.getTime()) / (24 * 60 * 60 * 1000))
  return 2 ** (-ageDays / halfLifeDays)
}

/**
 * Weighted, deduped view of a user's most-significant tracks: liked/
 * favorited tracks carry the most confidence, recent plays next (decayed by
 * recency -- a play from today counts more than one from a month ago), past
 * album requests last (flat weight, no specific track to anchor on). A
 * track/artist recurring across signal types has its weights summed, not
 * maxed, so e.g. a liked track the user also just played ranks above one
 * that's merely liked.
 */
export function buildTrackTasteProfile(
  liked: LikedTrackEntry[],
  recentPlays: RecentPlayEntry[],
  requestHistory: RequestHistoryEntry[],
  now: Date = new Date(),
  // The existing artist-level TasteProfile (from analyze()), when available,
  // so topArtists/topGenres/listeningPatterns are real rather than empty --
  // everything downstream that only wants artist-level data still works.
  baseProfile?: TasteProfile,
  // Normalized (0..1) artist name -> popularity, from getPopularityMap().
  popularityMap?: Map<string, number>,
  // Optional: defaults to [] so every existing caller (daily_mix, the main
  // recommendation pipeline) is unaffected -- only callers that explicitly
  // want "what's been added lately" as a signal (currently just the
  // dashboard taste profile) pass this.
  recentlyAdded: RecentlyAddedEntry[] = [],
): TrackTasteProfile {
  const byKey = new Map<string, TrackTasteSignal>()

  function add(signal: TrackTasteSignal) {
    const key = dedupeKey(signal)
    const existing = byKey.get(key)
    if (existing) {
      existing.weight += signal.weight
      if (!existing.mbid && signal.mbid) existing.mbid = signal.mbid
      if (!existing.albumTitle && signal.albumTitle) existing.albumTitle = signal.albumTitle
      if (!existing.trackName && signal.trackName) existing.trackName = signal.trackName
    } else {
      byKey.set(key, { ...signal })
    }
  }

  for (const t of liked) {
    if (!t.artistName?.trim() || !t.trackName?.trim()) continue
    add({
      trackName: t.trackName,
      artistName: t.artistName,
      albumTitle: t.albumTitle,
      mbid: t.mbid,
      weight: LIKED_WEIGHT,
      signalType: 'liked',
      source: t.source,
    })
  }

  for (const p of recentPlays) {
    if (!p.artistName?.trim() || !p.trackName?.trim()) continue
    add({
      trackName: p.trackName,
      artistName: p.artistName,
      weight: RECENT_PLAY_WEIGHT * decayWeight(p.playedAt, RECENT_PLAY_HALF_LIFE_DAYS, now),
      signalType: 'recent_play',
      source: 'plex',
    })
  }

  const cappedRequests = [...requestHistory]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, REQUEST_HISTORY_LIMIT)

  for (const r of cappedRequests) {
    if (!r.artistName?.trim()) continue
    add({
      artistName: r.artistName,
      albumTitle: r.albumTitle,
      weight: REQUEST_HISTORY_WEIGHT,
      signalType: 'request_history',
      source: 'request_history',
    })
  }

  for (const a of recentlyAdded) {
    if (!a.artistName?.trim()) continue
    add({
      artistName: a.artistName,
      albumTitle: a.albumTitle,
      weight: RECENTLY_ADDED_WEIGHT * decayWeight(a.addedAt, RECENTLY_ADDED_HALF_LIFE_DAYS, now),
      signalType: 'recently_added',
      source: 'recently_added',
    })
  }

  // Popularity boosts existing entries in place -- it has no specific track
  // of its own, so it reinforces whichever liked/recent/requested tracks
  // already belong to a popular artist rather than adding a bare synthetic
  // "artist, no track" entry alongside them.
  if (popularityMap) {
    for (const entry of byKey.values()) {
      const popularity = popularityMap.get(normalize(entry.artistName))
      if (popularity) entry.weight += POPULAR_WEIGHT * popularity
    }
  }

  const signals = [...byKey.values()].sort((a, b) => b.weight - a.weight)

  return {
    signals,
    topArtists: baseProfile?.topArtists ?? [],
    topGenres: baseProfile?.topGenres ?? [],
    listeningPatterns: baseProfile?.listeningPatterns ?? { totalListens: 0, recentTrend: 'stable' },
  }
}
