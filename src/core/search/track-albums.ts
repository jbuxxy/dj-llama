import type { MBReleaseGroup } from '@/core/clients/musicbrainz'
import { originalReleaseTier } from '@/core/pipeline/resolve'

// The slice of the MusicBrainz client this search needs (injectable for tests).
export type TrackAlbumSearchClient = {
  searchRecordingsFreeText(
    text: string,
    limit?: number,
  ): Promise<
    Array<{ id: string; title: string; score: number; artistMbid: string; artistName: string }>
  >
  getReleaseGroups(artistMbid: string, types?: readonly string[]): Promise<MBReleaseGroup[]>
  searchArtistRecordingReleaseGroups(
    trackName: string,
    artistMbid: string,
    options?: { limit?: number; offset?: number; releaseGroupIds?: string[] },
  ): Promise<{
    total: number
    recordings: Array<{
      recordingMbid: string
      recordingTitle: string
      recordingDisambiguation?: string
      releaseGroups: MBReleaseGroup[]
    }>
  }>
}

export type TrackAlbumResult = {
  recordingMbid: string
  trackName: string
  artistMbid: string
  artistName: string
  releaseGroupMbid: string
  albumTitle: string
  releaseDate?: string
  primaryType: string
  secondaryTypes?: string[]
}

// Distinct songs (title + artist) considered from the free-text hits. More
// than one so a bare title ("Wonderwall") can surface several artists'
// versions; each costs 2-3 MusicBrainz requests under the shared 1 req/s limit.
const MAX_SONGS = 3
const MAX_ALBUMS_PER_SONG = 5
// Lucene clause budget for the studio-album filter; covers any real
// discography (Oasis: 20 studio albums/EPs).
const MAX_STUDIO_RELEASE_GROUPS = 80

const normalizeTitle = (title: string) =>
  title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[‘’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

// A trailing "(...)" / "[...]" naming a different version of the song.
const OTHER_VERSION_RE =
  /\b(remix|mix|live|acoustic|instrumental|demo|karaoke|edit|version|reprise|cover|session|unplugged)\b/i
const TRAILING_QUALIFIER_RE = /\s*[([][^()[\]]*[)\]]\s*$/

// Whether a recording titled `candidate` is the same song as `wanted`. Album
// track titles often carry a subtitle the single doesn't (Lou Bega's album
// has "Mambo No. 5 (A Little Bit Of…)"), so a trailing bracketed part is
// ignored -- unless it names a different version (remix, live, acoustic...),
// which is a different recording, not the one the user asked for.
export function isSameSong(candidate: string, wanted: string): boolean {
  if (normalizeTitle(candidate) === normalizeTitle(wanted)) return true
  // A version marker the requested title doesn't share means another recording.
  if (OTHER_VERSION_RE.test(candidate) && !OTHER_VERSION_RE.test(wanted)) return false
  const base = (t: string) => normalizeTitle(t.replace(TRAILING_QUALIFIER_RE, ''))
  if (TRAILING_QUALIFIER_RE.test(candidate) && base(candidate) === base(wanted)) return true
  // Same words, give or take a couple: "Banana Boat (Day-O)" on Spotify is
  // "Day-O (The Banana Boat Song)" on Harry Belafonte's Calypso.
  return containsWords(candidate, wanted) || containsWords(wanted, candidate)
}

const MAX_EXTRA_WORDS = 2

function containsWords(longer: string, shorter: string): boolean {
  const have = new Set(words(longer))
  const need = new Set(words(shorter))
  const extra = have.size - need.size
  // At least three distinct shared words, and fewer extras than shared ones
  // -- otherwise "Mambo Mambo" would match "Mambo No. 5", and Danny Elfman's
  // "Main Titles" would stand in for his "Wednesday Main Titles".
  return (
    need.size >= 3 &&
    [...need].every((w) => have.has(w)) &&
    extra <= MAX_EXTRA_WORDS &&
    extra < need.size
  )
}

// Artist names differ in punctuation and billing between sources and
// MusicBrainz: Spotify's `Bobby "Boris" Pickett` is MusicBrainz's
// `Bobby “Boris” Pickett` (and `... and the Crypt-Kickers` on some credits),
// `allSTARS` is `allSTARS*`. Same words, or one name's words all within the other's.
export function isSameArtist(a: string, b: string): boolean {
  const wa = words(a)
  const wb = words(b)
  if (wa.length === 0 || wb.length === 0) return false
  const [shorter, longer] = wa.length <= wb.length ? [wa, new Set(wb)] : [wb, new Set(wa)]
  return shorter.every((w) => longer.has(w))
}

// Whether an identified song is the one the playlist track names. The
// track name may carry a Spotify-style suffix ("Forgot About Dre - Album
// Version (Edited)", "Sucker for Pain (with Wiz Khalifa, ...)") that the
// MusicBrainz title doesn't, so the bare form is tried too.
function matchesRequestedTitle(songTitle: string, requested: string): boolean {
  const bare = requested.split(' - ')[0]?.replace(TRAILING_QUALIFIER_RE, '').trim() || requested
  return isSameSong(songTitle, requested) || isSameSong(songTitle, bare)
}

const FREE_TEXT_HITS = 50

function words(text: string): string[] {
  return normalizeTitle(text).split(' ').filter(Boolean)
}

/**
 * Groups free-text hits into distinct songs (artist + title, ignoring a
 * trailing subtitle) and ranks them: first by how much of the query the
 * song's title + artist account for, so "mambo no 5 lou bega" prefers "Mambo
 * No. 5" over Lou Bega's "Mambo Mambo"; then by how many hits the song got.
 * MusicBrainz has no popularity signal and orders equally-scored hits
 * arbitrarily -- for a bare "smells like teen spirit" its first hits were
 * covers -- but a famous original appears on far more releases, so it
 * dominates the hit list (Nirvana 29 of 50, the next artist 7).
 */
export function rankSongs(
  query: string,
  hits: Array<{ title: string; artistMbid: string; artistName: string }>,
): Array<{ title: string; artistMbid: string; artistName: string }> {
  const queryWords = words(query)
  const groups = new Map<
    string,
    { title: string; artistMbid: string; artistName: string; count: number; first: number }
  >()
  hits.forEach((hit, index) => {
    // The song is searched by its bare title: the first hit's title might be
    // "Kiss Me (Japanese version)", which isn't the song the user means.
    const title = hit.title.replace(TRAILING_QUALIFIER_RE, '').trim() || hit.title
    const key = `${hit.artistMbid}::${normalizeTitle(title)}`
    const group = groups.get(key)
    if (group) group.count++
    else groups.set(key, { ...hit, title, count: 1, first: index })
  })
  const coverage = (g: { title: string; artistName: string }) => {
    if (queryWords.length === 0) return 0
    const own = new Set([...words(g.title), ...words(g.artistName)])
    return queryWords.filter((w) => own.has(w)).length / queryWords.length
  }
  return [...groups.values()]
    .map((g) => ({ ...g, coverage: coverage(g) }))
    .sort((a, b) => b.coverage - a.coverage || b.count - a.count || a.first - b.first)
    .map(({ title, artistMbid, artistName }) => ({ title, artistMbid, artistName }))
}

/**
 * "Which album is this song from?" for the free-text Tracks search box. Two
 * steps, because one search can't do both jobs:
 *
 * 1. Identify the song: MusicBrainz's simple (dismax) search matches the
 *    words against title and artist together, so "missy elliott get ur freak
 *    on" finds "Get Ur Freak On" by Missy Elliott. Its top hits are usually
 *    copies on compilations, so they're only used to learn title + artist.
 * 2. Find the albums: every release-group that song appears on under that
 *    artist's own name, ranked by the same originality rules the playlist
 *    import uses (studio album, then compilation, EP, single, live; earliest
 *    first; remixes/soundtracks dropped). Copies named as another version
 *    ("... (Remix)", "... (Live)") are a different recording and are skipped.
 */
export async function searchTrackAlbums(
  client: TrackAlbumSearchClient,
  query: string,
  options: {
    // The playlist import already knows who and what the track is: only
    // songs by this artist with this title are considered. Without the title
    // check, a soundtrack-only song with no album ("Wednesday Main Titles")
    // fell through to a different song by the same artist ("Main Titles").
    artistName?: string
    trackName?: string
  } = {},
): Promise<TrackAlbumResult[]> {
  const hits = await client.searchRecordingsFreeText(query, FREE_TEXT_HITS)
  const { artistName, trackName } = options
  const songs = rankSongs(query, hits)
    .filter((s) => !artistName || isSameArtist(s.artistName, artistName))
    .filter((s) => !trackName || matchesRequestedTitle(s.title, trackName))
    .slice(0, MAX_SONGS)

  const results: TrackAlbumResult[] = []
  const seenReleaseGroups = new Set<string>()
  for (const song of songs) {
    // Titles are checked per recording *before* release-groups are merged:
    // a deluxe edition can carry both "Wonderwall" and "Wonderwall (Live)",
    // and only the matching recording may claim the album.
    const albums = new Map<string, { recordingMbid: string; releaseGroup: MBReleaseGroup }>()
    const collect = (
      recordings: Array<{
        recordingMbid: string
        recordingTitle: string
        recordingDisambiguation?: string
        releaseGroups: MBReleaseGroup[]
      }>,
    ) => {
      for (const recording of recordings) {
        if (!isSameSong(recording.recordingTitle, song.title)) continue
        // A live/demo copy keeps the plain title and says so only in its
        // disambiguation ("live, 1995-10-05: ..."), e.g. the live bonus
        // "Smells Like Teen Spirit" on In Utero's 2023 deluxe edition.
        if (
          recording.recordingDisambiguation &&
          OTHER_VERSION_RE.test(recording.recordingDisambiguation)
        ) {
          continue
        }
        for (const rg of recording.releaseGroups) {
          const existing = albums.get(rg.id)
          if (!existing) {
            albums.set(rg.id, { recordingMbid: recording.recordingMbid, releaseGroup: { ...rg } })
          } else if (
            rg.firstReleaseDate &&
            (!existing.releaseGroup.firstReleaseDate ||
              rg.firstReleaseDate < existing.releaseGroup.firstReleaseDate)
          ) {
            existing.releaseGroup.firstReleaseDate = rg.firstReleaseDate
          }
        }
      }
    }

    // First ask directly which of the artist's studio albums/EPs have the
    // song. A famous song has hundreds of equally-scored copies under its own
    // artist (Oasis "Wonderwall": 247, the album's copy ~196th), returned in
    // an order MusicBrainz doesn't keep stable between requests, so paging
    // through them can't reliably reach the album copy -- filtering to the
    // studio release-groups up front leaves only the handful that matter.
    const studio = (await client.getReleaseGroups(song.artistMbid, ['Album', 'EP'])).slice(
      0,
      MAX_STUDIO_RELEASE_GROUPS,
    )
    if (studio.length > 0) {
      const { recordings } = await client.searchArtistRecordingReleaseGroups(
        song.title,
        song.artistMbid,
        { releaseGroupIds: studio.map((rg) => rg.id) },
      )
      collect(recordings)
    }
    // Not on any studio album (a single-only song, a soundtrack cut): fall
    // back to everywhere it appears under the artist's name.
    const onStudioRelease = [...albums.values()].some((a) => {
      const tier = originalReleaseTier(a.releaseGroup)
      return tier === 0 || tier === 2
    })
    if (!onStudioRelease) {
      const { recordings } = await client.searchArtistRecordingReleaseGroups(
        song.title,
        song.artistMbid,
      )
      collect(recordings)
    }

    const ranked = [...albums.values()]
      .map((f) => ({ ...f, tier: originalReleaseTier(f.releaseGroup) }))
      .filter((f): f is typeof f & { tier: number } => f.tier !== undefined)
      .sort((a, b) => {
        if (a.tier !== b.tier) return a.tier - b.tier
        const dateA = a.releaseGroup.firstReleaseDate ?? '9999'
        const dateB = b.releaseGroup.firstReleaseDate ?? '9999'
        return dateA.localeCompare(dateB)
      })

    let added = 0
    for (const f of ranked) {
      if (added >= MAX_ALBUMS_PER_SONG) break
      if (seenReleaseGroups.has(f.releaseGroup.id)) continue
      seenReleaseGroups.add(f.releaseGroup.id)
      added++
      results.push({
        recordingMbid: f.recordingMbid,
        trackName: song.title,
        artistMbid: song.artistMbid,
        artistName: song.artistName,
        releaseGroupMbid: f.releaseGroup.id,
        albumTitle: f.releaseGroup.title,
        releaseDate: f.releaseGroup.firstReleaseDate,
        primaryType: f.releaseGroup.type,
        secondaryTypes: f.releaseGroup.secondaryTypes,
      })
    }
  }
  return results
}
