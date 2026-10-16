import PQueue from 'p-queue'
import { weightedSample } from './random'
import type {
  LocalTrack,
  MBRecording,
  ResolvedTrack,
  TrackResolverConfig,
  TrackResolverDeps,
} from './types'

const DEFAULT_CONFIG: TrackResolverConfig = {
  tracksPerArtist: 3,
  sourcePriority: ['local', 'spotify'],
}

function titleMatchesKeywords(title: string, keywords: string[] | undefined): boolean {
  if (!keywords || keywords.length === 0) return false
  const lower = title.toLowerCase()
  return keywords.some((keyword) => lower.includes(keyword))
}

function titleExcluded(title: string, keywords: string[] | undefined): boolean {
  return titleMatchesKeywords(title, keywords)
}

// Splits candidates into keyword-matching and everything else, then fills
// `limit` slots matches-first via the source's normal picking logic (a
// weighted sample, a popularity sort, ...) -- so a title match is strongly
// preferred without being a hard requirement (an artist with no matching
// track in their catalog still gets their normal top picks).
function prioritizeByTitle<T>(
  items: T[],
  limit: number,
  titleOf: (item: T) => string,
  includeTitleKeywords: string[] | undefined,
  pick: (items: T[], limit: number) => T[],
): T[] {
  if (!includeTitleKeywords || includeTitleKeywords.length === 0) return pick(items, limit)
  const matched = items.filter((item) => titleMatchesKeywords(titleOf(item), includeTitleKeywords))
  if (matched.length === 0) return pick(items, limit)
  const unmatched = items.filter(
    (item) => !titleMatchesKeywords(titleOf(item), includeTitleKeywords),
  )
  const matchedPicks = pick(matched, limit)
  if (matchedPicks.length >= limit) return matchedPicks
  return [...matchedPicks, ...pick(unmatched, limit - matchedPicks.length)]
}

// Plex's 0-10 personal rating, 8+ = 4+ stars ("loved") -- same threshold
// used elsewhere for the favorites fallback (see clients/plex.ts).
const LIKED_RATING_THRESHOLD = 8

// Every track keeps a nonzero base weight so the pick still varies across
// regenerations, but liked and heavily-played tracks are meaningfully more
// likely to be chosen over an artist's deep cuts.
function localTrackWeight(track: LocalTrack): number {
  let weight = 1
  if ((track.userRating ?? 0) >= LIKED_RATING_THRESHOLD) weight += 4
  weight += Math.min(track.viewCount ?? 0, 20) * 0.2
  return weight
}

// Returns the local search dep, if configured.
function getLocalSearchFn(
  deps: TrackResolverDeps,
): ((artist: string) => Promise<LocalTrack[]>) | undefined {
  return deps.plexSearch
}

async function resolveFromLocal(
  artistName: string,
  deps: TrackResolverDeps,
  limit: number,
  excludeTitleKeywords?: string[],
  includeTitleKeywords?: string[],
): Promise<ResolvedTrack[]> {
  const search = getLocalSearchFn(deps)
  if (!search) return []

  try {
    const tracks = await search(artistName)
    const eligible = tracks.filter((t) => !titleExcluded(t.name, excludeTitleKeywords))
    const candidates = prioritizeByTitle(
      eligible,
      limit,
      (t) => t.name,
      includeTitleKeywords,
      (items, n) => weightedSample(items, n, localTrackWeight),
    )
    return candidates.map((t) => ({
      artistName,
      trackName: t.name,
      localPath: t.path,
      source: 'local' as const,
    }))
  } catch (error: unknown) {
    console.warn('[track-resolver]', error)
    return []
  }
}

async function resolveFromSpotify(
  artistName: string,
  deps: TrackResolverDeps,
  limit: number,
  excludeTitleKeywords?: string[],
  includeTitleKeywords?: string[],
): Promise<ResolvedTrack[]> {
  if (!deps.spotifySearch) return []

  try {
    const results = await deps.spotifySearch(`artist:${artistName}`, limit)
    const eligible = results.filter((t) => !titleExcluded(t.name, excludeTitleKeywords))
    const candidates = prioritizeByTitle(
      eligible,
      limit,
      (t) => t.name,
      includeTitleKeywords,
      (items, n) => [...items].sort((a, b) => b.popularity - a.popularity).slice(0, n),
    )
    return candidates.map((t) => ({
      artistName,
      trackName: t.name,
      spotifyUri: t.uri,
      source: 'spotify' as const,
    }))
  } catch (error: unknown) {
    console.warn('[track-resolver]', error)
    return []
  }
}

async function resolveFromDeezer(
  artistName: string,
  deps: TrackResolverDeps,
  limit: number,
  excludeTitleKeywords?: string[],
  includeTitleKeywords?: string[],
): Promise<ResolvedTrack[]> {
  if (!deps.deezerSearch) return []

  try {
    const results = await deps.deezerSearch(`artist:"${artistName}"`, limit)
    const eligible = results.filter((t) => !titleExcluded(t.name, excludeTitleKeywords))
    const candidates = prioritizeByTitle(
      eligible,
      limit,
      (t) => t.name,
      includeTitleKeywords,
      (items, n) => [...items].sort((a, b) => b.rank - a.rank).slice(0, n),
    )
    return candidates.map((t) => ({
      artistName,
      trackName: t.name,
      deezerId: t.id,
      source: 'deezer' as const,
    }))
  } catch (error: unknown) {
    console.warn('[track-resolver]', error)
    return []
  }
}

async function resolveFromMusicBrainz(
  artistName: string,
  artistMbid: string,
  deps: TrackResolverDeps,
  limit: number,
  excludeTitleKeywords?: string[],
  includeTitleKeywords?: string[],
): Promise<ResolvedTrack[]> {
  if (!deps.musicbrainzRecordings) return []

  try {
    const recordings = await deps.musicbrainzRecordings(artistMbid)
    const eligible = recordings.filter((r) => !titleExcluded(r.title, excludeTitleKeywords))
    const candidates = prioritizeByTitle(
      eligible,
      limit,
      (r) => r.title,
      includeTitleKeywords,
      (items, n) => items.slice(0, n),
    )
    return candidates.map((r: MBRecording) => ({
      artistName,
      trackName: r.title,
      mbid: r.id,
      source: 'musicbrainz' as const,
    }))
  } catch (error: unknown) {
    console.warn('[track-resolver]', error)
    return []
  }
}

export async function resolveTracksForArtist(
  artistName: string,
  artistMbid: string | undefined,
  deps: TrackResolverDeps,
  config: TrackResolverConfig,
): Promise<ResolvedTrack[]> {
  const cfg = { ...DEFAULT_CONFIG, ...config }
  const limit = cfg.tracksPerArtist
  const excludeTitleKeywords = cfg.excludeTitleKeywords
  const includeTitleKeywords = cfg.includeTitleKeywords

  for (const source of cfg.sourcePriority) {
    let tracks: ResolvedTrack[] = []

    if (source === 'local') {
      tracks = await resolveFromLocal(
        artistName,
        deps,
        limit,
        excludeTitleKeywords,
        includeTitleKeywords,
      )
    } else if (source === 'spotify') {
      tracks = await resolveFromSpotify(
        artistName,
        deps,
        limit,
        excludeTitleKeywords,
        includeTitleKeywords,
      )
    } else if (source === 'deezer') {
      tracks = await resolveFromDeezer(
        artistName,
        deps,
        limit,
        excludeTitleKeywords,
        includeTitleKeywords,
      )
    }

    if (tracks.length > 0) return tracks
  }

  // MusicBrainz fallback - only if we have an MBID
  if (artistMbid) {
    const mbTracks = await resolveFromMusicBrainz(
      artistName,
      artistMbid,
      deps,
      limit,
      excludeTitleKeywords,
      includeTitleKeywords,
    )
    if (mbTracks.length > 0) return mbTracks
  }

  // Nothing resolved - let the caller handle the empty case
  return []
}

export async function resolvePlaylistTracks(
  artists: { name: string; mbid?: string }[],
  deps: TrackResolverDeps,
  config: TrackResolverConfig,
): Promise<ResolvedTrack[]> {
  const queue = new PQueue({ concurrency: 2, interval: 500, intervalCap: 1 })

  const results = await Promise.all(
    artists.map((artist) =>
      queue.add(() => resolveTracksForArtist(artist.name, artist.mbid, deps, config)),
    ),
  )

  return (results as ResolvedTrack[][]).flat()
}
