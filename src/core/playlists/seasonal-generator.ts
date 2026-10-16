import { normalizeArtistName, normalizeTrackTitle } from '@/core/library/normalize'
import { isAlternateVersionCandidate } from '@/core/targets/playlist-match'
import { albumTitleFromPath } from './local-path'
import type { OnlineSeasonalSong } from './seasonal-online'
import type { SeasonalPreset } from './seasonal-presets'
import type { StrategyArtist } from './strategies/types'
import type { LocalTrack, ResolvedTrack } from './types'

// Seasonal playlists are built song-first, not artist-first: the old
// approach picked the listener's favorite artists and hoped each had a
// Halloween song, which mostly produced their ordinary hits. Here every
// track has to earn its place by actually belonging to the season:
//
//   1. "classic"  -- a song from Deezer's seasonal editorial playlists or
//                    the preset's built-in list, found in the library
//   2. "title"    -- a library track whose title has a seasonal word in it
//                    (whole-word match, so "Hollywood" isn't Christmas)
//   3. "genre"    -- filler from artists tagged with a seasonal genre
//                    (horror punk, darkwave, christmas, surf...), capped and
//                    only used when 1+2 can't fill the playlist
//
// The listener's taste then weights which of those candidates get picked.

export type SeasonalReason = 'classic' | 'title' | 'genre' | 'pinned'

export type SeasonalCandidate = {
  artistName: string
  trackName: string
  localPath: string
  reason: SeasonalReason
  score: number
}

export type SeasonalTrackRef = { artistName: string; trackName: string; localPath?: string | null }

export type SeasonalGeneratorDeps = {
  /** All tracks by one artist in the library (Plex). */
  getArtistTracks: (artist: string) => Promise<LocalTrack[]>
  /** Library-wide substring title search (Plex). */
  searchByTitle?: (query: string) => Promise<LocalTrack[]>
  /** Normalized names (normalizeArtistName) of every artist in the library. */
  getLibraryArtistKeys?: () => Promise<Set<string>>
  /** Taste-weighted artists with genres, padded with library filler. */
  getTasteArtists?: () => Promise<StrategyArtist[]>
  fetchOnlineSongs?: (preset: SeasonalPreset) => Promise<OnlineSeasonalSong[]>
}

export type SeasonalGenerationInput = {
  preset: SeasonalPreset
  size: number
  excluded?: SeasonalTrackRef[]
  pinned?: SeasonalTrackRef[]
}

export type SeasonalGenerationResult = {
  tracks: ResolvedTrack[]
  // Every other eligible candidate, best first -- stored on the playlist so
  // "suggest a replacement" is instant instead of re-running every search.
  candidates: SeasonalCandidate[]
}

const MAX_PER_ARTIST = 2
const MAX_CANDIDATES_KEPT = 80
const GENRE_FILLER_ARTISTS = 8
const GENRE_FILLER_SHARE = 0.4

const BASE_SCORE: Record<SeasonalReason, number> = {
  pinned: 100,
  classic: 10,
  title: 6,
  genre: 2,
}

export function seasonalTrackKey(artistName: string, trackName: string): string {
  return `${normalizeArtistName(artistName)}|${normalizeSongTitle(trackName)}`
}

// normalizeTrackTitle already drops "(Remastered)"-style parentheticals and
// feat. credits; Deezer/Spotify also use " - 2011 Remaster" / " - Single
// Version" dash suffixes, which never appear the same way in a library.
function normalizeSongTitle(title: string): string {
  return normalizeTrackTitle(
    title.replace(/\s+-\s+.*\b(remaster(ed)?|version|edit|mix|mono|stereo|from)\b.*$/i, ''),
  )
}

// "Bob Marley & The Wailers" should still find a library filed under "Bob
// Marley"; "Bobby "Boris" Pickett & The Crypt-Kickers" under "Bobby Boris
// Pickett". Returns the full name first, then the lead artist.
function artistKeyVariants(artist: string): string[] {
  const full = normalizeArtistName(artist.replace(/["“”]/g, ''))
  const lead = normalizeArtistName(
    artist.replace(/["“”]/g, '').split(/\s+(?:&|and|feat\.?|ft\.?|with|x)\s+|,\s*/i)[0] ?? artist,
  )
  return full === lead ? [full] : [full, lead]
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function titleKeywordPattern(keywords: string[]): RegExp | null {
  if (keywords.length === 0) return null
  return new RegExp(`\\b(?:${keywords.map(escapeRegExp).join('|')})\\b`, 'i')
}

function isUsableTrack(track: LocalTrack): boolean {
  return (
    !!track.path &&
    !isAlternateVersionCandidate({
      title: track.name,
      album: albumTitleFromPath(track.path) ?? undefined,
    }) &&
    !/\b(karaoke|instrumental|commentary|interview|skit|demo|take \d+|rehearsal)\b/i.test(
      track.name,
    ) &&
    // Remixes/extended mixes of a seasonal song: the original is what people
    // expect ("Heads Will Roll", not the Passion Pit remix).
    !/[([][^)\]]*\b(remix|mix|extended|dub|rework|bootleg)\b[^)\]]*[)\]]/i.test(track.name) &&
    !/\s-\s.*\b(remix|mix|extended)\b/i.test(track.name)
  )
}

function personalBonus(track: LocalTrack): number {
  let bonus = 0
  if ((track.userRating ?? 0) >= 8) bonus += 3
  bonus += Math.min(track.viewCount ?? 0, 20) * 0.15
  return bonus
}

/** Weighted random order: higher scores tend to come first, but not always. */
function weightedOrder<T extends { score: number }>(items: T[]): T[] {
  return items
    .map((item) => ({ item, key: Math.random() ** (1 / Math.max(item.score, 0.01)) }))
    .sort((a, b) => b.key - a.key)
    .map((x) => x.item)
}

export async function generateSeasonalTracks(
  deps: SeasonalGeneratorDeps,
  input: SeasonalGenerationInput,
): Promise<SeasonalGenerationResult> {
  const { preset, size } = input
  const excludedKeys = new Set(
    (input.excluded ?? []).map((t) => seasonalTrackKey(t.artistName, t.trackName)),
  )

  const tasteArtists = (await deps.getTasteArtists?.().catch(() => [])) ?? []
  const maxTaste = Math.max(1, ...tasteArtists.map((a) => a.score))
  const tasteByArtist = new Map(
    tasteArtists.map((a) => [normalizeArtistName(a.name), a.score / maxTaste]),
  )
  const libraryArtistKeys =
    (await deps.getLibraryArtistKeys?.().catch(() => undefined)) ??
    new Set(tasteArtists.map((a) => normalizeArtistName(a.name)))

  const candidates = new Map<string, SeasonalCandidate>()
  function offer(track: LocalTrack, reason: SeasonalReason, extra = 0) {
    if (!isUsableTrack(track)) return
    const key = seasonalTrackKey(track.artist, track.name)
    if (excludedKeys.has(key)) return
    const taste = tasteByArtist.get(normalizeArtistName(track.artist)) ?? 0
    const score = (BASE_SCORE[reason] + extra) * (1 + taste) + personalBonus(track)
    const existing = candidates.get(key)
    if (existing && existing.score >= score) return
    candidates.set(key, {
      artistName: track.artist,
      trackName: track.name,
      localPath: track.path,
      reason,
      score,
    })
  }

  const artistTrackCache = new Map<string, Promise<LocalTrack[]>>()
  function artistTracks(artist: string): Promise<LocalTrack[]> {
    const cacheKey = normalizeArtistName(artist)
    let pending = artistTrackCache.get(cacheKey)
    if (!pending) {
      pending = deps.getArtistTracks(artist).catch(() => [])
      artistTrackCache.set(cacheKey, pending)
    }
    return pending
  }

  // 1. Classics: online editorial playlists + the built-in list. Only
  //    artists actually in the library are looked up, so a 300-song online
  //    list costs a few dozen Plex requests, not 300.
  const online = (await deps.fetchOnlineSongs?.(preset).catch(() => [])) ?? []
  const wanted = new Map<string, { titles: Map<string, number>; artist: string }>()
  const anyArtistTitles = new Map<string, string>()
  function want(artist: string, title: string, extra: number) {
    const libraryKey = artistKeyVariants(artist).find((k) => libraryArtistKeys.has(k))
    if (!libraryKey) return
    const entry = wanted.get(libraryKey) ?? { titles: new Map<string, number>(), artist }
    const titleKey = normalizeSongTitle(title)
    entry.titles.set(titleKey, Math.max(entry.titles.get(titleKey) ?? 0, extra))
    wanted.set(libraryKey, entry)
  }
  for (const song of online) {
    if (song.playlistCount < preset.onlineMinPlaylists) continue
    want(song.artist, song.title, Math.min(song.playlistCount, 5) * 2)
  }
  for (const song of preset.songs) {
    want(song.artist, song.title, 2)
    if (song.anyArtist) anyArtistTitles.set(normalizeSongTitle(song.title), song.title)
  }

  for (const [, entry] of wanted) {
    const tracks = await artistTracks(entry.artist)
    for (const track of tracks) {
      const extra = entry.titles.get(normalizeSongTitle(track.name))
      if (extra !== undefined) offer(track, 'classic', extra)
    }
  }

  if (deps.searchByTitle) {
    // Standards (carols, "White Christmas", "Monster Mash") count in any
    // artist's version.
    for (const [titleKey, title] of anyArtistTitles) {
      const results = await deps.searchByTitle(title).catch(() => [])
      for (const track of results) {
        if (normalizeSongTitle(track.name) === titleKey) offer(track, 'classic', 2)
      }
    }

    // 2. Seasonal words in the title, anywhere in the library.
    const pattern = titleKeywordPattern(preset.titleKeywords)
    if (pattern) {
      for (const keyword of preset.titleKeywords) {
        const results = await deps.searchByTitle(keyword).catch(() => [])
        for (const track of results) {
          if (pattern.test(track.name)) offer(track, 'title')
        }
      }
    }
  }

  // 3. Genre filler from seasonally-tagged artists.
  const genrePattern = titleKeywordPattern(preset.genreKeywords)
  const genreArtists = genrePattern
    ? tasteArtists
        .filter((a) => (a.genres ?? []).some((g) => genrePattern.test(g)))
        .slice(0, GENRE_FILLER_ARTISTS)
    : []
  for (const artist of genreArtists) {
    for (const track of await artistTracks(artist.name)) offer(track, 'genre')
  }

  // Selection: pinned tracks first, then themed (classic + title) in
  // weighted-random order, then capped genre filler. One version of each
  // song, at most MAX_PER_ARTIST songs per artist.
  const picked: SeasonalCandidate[] = []
  const pickedKeys = new Set<string>()
  const pickedTitles = new Set<string>()
  const perArtist = new Map<string, number>()
  function take(c: SeasonalCandidate, ignoreCaps = false): boolean {
    const key = seasonalTrackKey(c.artistName, c.trackName)
    const titleKey = normalizeSongTitle(c.trackName)
    const artistKey = normalizeArtistName(c.artistName)
    if (pickedKeys.has(key)) return false
    if (!ignoreCaps) {
      if (pickedTitles.has(titleKey)) return false
      if ((perArtist.get(artistKey) ?? 0) >= MAX_PER_ARTIST) return false
    }
    picked.push(c)
    pickedKeys.add(key)
    pickedTitles.add(titleKey)
    perArtist.set(artistKey, (perArtist.get(artistKey) ?? 0) + 1)
    return true
  }

  for (const pin of input.pinned ?? []) {
    if (picked.length >= size) break
    take(
      {
        artistName: pin.artistName,
        trackName: pin.trackName,
        localPath: pin.localPath ?? '',
        reason: 'pinned',
        score: BASE_SCORE.pinned,
      },
      true,
    )
  }

  const all = [...candidates.values()]
  const themed = weightedOrder(all.filter((c) => c.reason !== 'genre'))
  for (const c of themed) {
    if (picked.length >= size) break
    take(c)
  }

  const fillerRoom = Math.min(size - picked.length, Math.ceil(size * GENRE_FILLER_SHARE))
  let filled = 0
  for (const c of weightedOrder(all.filter((c) => c.reason === 'genre'))) {
    if (filled >= fillerRoom) break
    if (take(c)) filled++
  }

  const leftovers = all
    .filter((c) => !pickedKeys.has(seasonalTrackKey(c.artistName, c.trackName)))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CANDIDATES_KEPT)

  return {
    tracks: weightedOrder(picked.map((c) => ({ ...c, score: 1 }))).map((c) => ({
      artistName: c.artistName,
      trackName: c.trackName,
      localPath: c.localPath || undefined,
      source: 'local' as const,
    })),
    candidates: leftovers,
  }
}
