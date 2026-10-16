import { normalizeArtistName } from '@/core/library/normalize'

type TrackSearchCandidate = {
  id: string
  title: string
  artists: string[]
  album?: string
}

// Live/acoustic/demo releases usually keep the plain song title on the
// track itself -- only the album name marks it as an alternate recording
// (e.g. track "Yesterday", album "Live at the Hollywood Bowl"). Deliberately
// not stripped in normalize() below: unlike a remaster or feat. credit, a
// live version is a genuinely different recording and titles matching
// despite it is exactly the signal pickBestTrackMatch uses to deprioritize it.
const ALTERNATE_VERSION_ALBUM_PATTERN =
  /\b(live|unplugged|acoustic|sessions?|rehearsal|in concert|bootleg|karaoke|demo)\b/i

function isAlternateVersionAlbum(album: string | undefined): boolean {
  return album ? ALTERNATE_VERSION_ALBUM_PATTERN.test(album) : false
}

// isAlternateVersionAlbum alone missed a real case (confirmed live, 2026-08):
// Heart "Alone (live)" sitting on Plex under album "Playlist: The Very Best
// of Heart" -- a generic compilation title with no "live" keyword at all, so
// the album check passed clean even though the track itself is a live
// recording. The fuzzy fallback below has no title-exactness requirement (that's
// what makes it "fuzzy"), so this slipped through as the only candidate Plex
// returned. Checking the candidate's own title for a live marker via the same
// suffix pattern search() strips from source titles catches this without
// touching the exact-match path, since an exact match already requires the
// candidate's title to equal the source's live-stripped title verbatim.
export function isAlternateVersionCandidate(item: { title: string; album?: string }): boolean {
  return isAlternateVersionAlbum(item.album) || LIVE_TRACK_SUFFIX_PATTERN.test(item.title)
}

// Unlike ALTERNATE_VERSION_ALBUM_PATTERN above (which reads a *Plex candidate's*
// album field), source playlists (Spotify/Apple Music/etc.) sometimes tag the
// live recording directly on the track title itself, e.g. "Kiss - Live" or
// "Kiss (Live at Paisley Park)". Left in place, that suffix would never
// title-match a Plex library's plainly-titled studio track ("Kiss"), so the
// only way the source track could match at all was against a Plex entry that
// happened to carry the same literal "- Live" suffix -- i.e. the live version
// specifically, defeating the studio-preference below entirely.
const LIVE_TRACK_SUFFIX_PATTERN =
  /\s*[-–—]\s*live(\s+(at|in|from|version))?.*$|\s*[([]\s*live(\s+(at|in|from))?[^)\]]*[)\]]\s*$/i

// Same problem as LIVE_TRACK_SUFFIX_PATTERN, different qualifier: source
// playlists often bake a "- 2009 Remaster", "- Single Version", or
// "(Radio Edit)" straight into the track title, while Plex's own tag for the
// very same song is almost always the plain title with no such suffix.
// Confirmed against a real import (2026-08): sent verbatim, Plex's free-text
// search returned literally zero candidates for queries like "Start Me Up -
// Remastered 2009" or "Sweet Dreams (Are Made of This) - 2005 Remaster" --
// not a bad match, no results at all -- while the plain title finds it fine.
// normalize() below strips a remaster suffix too, but only for comparing
// candidates *after* they're fetched, which is too late if the raw query
// already came back empty. Stripping here fixes the search itself.
const EDITION_SUFFIX_PATTERN =
  /\s*[-–—]\s*(\d{4}\s*)?remaster(ed)?(\s*\d{4})?\s*$|\s*\((\d{4}\s*)?remaster(ed)?(\s*\d{4})?\)\s*$|\s*[-–—]\s*(single|radio|album|mono|stereo)(\s+(version|edit|mix))?\s*$|\s*\((single|radio|album|mono|stereo)(\s+(version|edit|mix))?\)\s*$/i

// A bare trailing year with no accompanying keyword at all -- e.g. "- 2018"
// -- is the same re-release/reissue-year tagging convention as "- 2009
// Remaster" above, just without the word "remaster" ever appearing.
// Confirmed live (2026-08): "The Hold Steady - Constructive Summer - 2018"
// returned zero Plex results on both the combined and title-only queries,
// while the plain "Constructive Summer" (no year at all) sat right there
// under "Stay Positive". Deliberately requires a hyphen/paren separator
// before the year (never bare "1999" with no separator) so a song whose
// real title *is* a year, e.g. "1979", is never touched.
const BARE_YEAR_SUFFIX_PATTERN = /\s*[-–—]\s*(19|20)\d{2}\s*$|\s*\((19|20)\d{2}\)\s*$/

// Same problem again: soundtrack-tie-in annotations like 'Danger Zone -
// From "Top Gun" Original Soundtrack' or '(From "Twisters")'. Confirmed
// against a real import (2026-08): "Danger Zone - From \"Top Gun\" Original
// Soundtrack" returned zero Plex results, same as the remaster/live suffixes
// did before those were stripped -- Plex's own tag is just "Danger Zone".
// The optional "(Theme )" before "From" covers the equally common TV-theme
// variant -- confirmed live: 'The Rembrandts - I\'ll Be There for You -
// Theme From "Friends"' returned zero results while the plain title sat
// right there under "L.P.".
const SOUNDTRACK_SUFFIX_PATTERN =
  /\s*[-–—]\s*(theme\s+)?from\s+["“][^"”]*["”].*$|\s*[([]\s*(theme\s+)?from\s+["“][^"”]*["”][^)\]]*[)\]]\s*$|\s*[-–—]\s*(original\s+)?soundtrack(\s+version)?\s*$|\s*\((original\s+)?soundtrack(\s+version)?\)\s*$/i

/**
 * Strips a "- Live"/"(Live at ...)"-, "- Remastered"/"- Single Version"-, or
 * "- From "Movie" Soundtrack"-style suffix so search matches the underlying
 * song title instead of failing outright on text that isn't in Plex's own
 * tag. Applies all patterns (a title can carry any one, or none) and falls
 * back to the original string if stripping would leave nothing.
 */
export function stripSearchQualifier(trackName: string): string {
  const stripped = trackName
    .replace(LIVE_TRACK_SUFFIX_PATTERN, '')
    .replace(EDITION_SUFFIX_PATTERN, '')
    .replace(SOUNDTRACK_SUFFIX_PATTERN, '')
    .replace(BARE_YEAR_SUFFIX_PATTERN, '')
    .trim()
  return stripped || trackName
}

// Last-resort, keyword-agnostic version of the same problem: a source
// playlist's track title can carry a legitimate part of the song's own name
// in parens -- e.g. "You Make My Dreams (Come True)" -- that Plex's own tag
// simply doesn't include ("You Make My Dreams"). Confirmed live (2026-08):
// this returned zero Plex results even after stripSearchQualifier (none of
// its patterns match -- "(Come True)" isn't a live/remaster/edition/
// soundtrack qualifier, it's just a subtitle Plex dropped), while the
// already-owned track sat right there under "Voices" the whole time. Unlike
// stripSearchQualifier, this isn't keyed to known qualifier words, so it's
// only ever tried as a final fallback query -- never used to reject a
// candidate the way isAlternateVersionCandidate does -- to avoid false
// hits on titles where the parenthetical is load-bearing (e.g. distinguishing
// two different songs that only differ by a "(Part 2)" suffix).
export function stripTrailingParenthetical(trackName: string): string {
  const stripped = trackName.replace(/\s*[([][^)\]]*[)\]]\s*$/, '').trim()
  return stripped || trackName
}

// Exported (unlike the rest of this module's normalization helpers) so
// callers outside Plex matching -- e.g. checking whether Lidarr already has
// a *plain* studio file for a track, not just one whose parenthetical-
// stripped title happens to match (see index.ts's findExistingTrackFile) --
// can use the same "exact modulo diacritics/case/punctuation-style" strictness.
// Deliberately does NOT strip parentheticals the way normalizeTrackTitle
// (core/library/normalize.ts) does: a remix/instrumental/live qualifier
// living inside parens is exactly the signal that distinguishes a real
// plain-title file from one that only looks like a match once parens are
// discarded.
export function normalize(value: string): string {
  let s = value.normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip diacritics
  // Unify typographic hyphen/dash variants to plain ASCII "-" -- e.g. Plex/
  // MusicBrainz tag "Salt\u2010N\u2010Pepa" with U+2010 HYPHEN while a source playlist's
  // own metadata uses a plain "-" for the same artist. Left distinct, that
  // silently fails an otherwise-exact artist/title match.
  s = s.replace(/[\u2010-\u2015\u2212]/g, '-')
  // Drop apostrophes (straight or curly) entirely, same fix as
  // normalizeArtistName (core/library/normalize.ts) and for the same
  // confirmed-live reason: Plex tags "The B-52's" as "The B\u201052s" with no
  // apostrophe at all, so the source's own straight-apostrophe spelling
  // never title/artist-matched despite the exact right album sitting right
  // there in Plex's own search results.
  s = s.replace(/['\u2019\u2018`]/g, '')
  // Drop periods entirely -- e.g. a source playlist's "Mr. Brightside" vs
  // Plex's own "Mr Brightside" (confirmed live, 2026-08): the punctuation
  // mismatch alone kept the real studio candidate out of exactMatches
  // entirely, leaving only a same-punctuated live version ("Mr. Brightside"
  // on a live album) to satisfy the exact-title check -- which then
  // correctly got rejected as live, reporting the track missing even though
  // the studio version was sitting right there in the very same search
  // results. Same "punctuation-style, not a different recording" reasoning
  // as the apostrophe/hyphen unification above.
  s = s.replace(/\./g, '')
  s = s.toLowerCase()
  // Unify "&" and "and" -- e.g. a source playlist tagging "Huey Lewis & The
  // News" while Plex's own artist tag spells it out as "Huey Lewis and the
  // News" for the same real artist. Left distinct, that silently fails an
  // otherwise-exact artist match (confirmed live, 2026-08).
  s = s.replace(/\s*&\s*/g, ' and ')
  s = s.replace(/\s*\((feat\.?|featuring|ft\.?|with)\s+[^)]*\)\s*/gi, ' ') // "(feat. X)"
  s = s.replace(/\s+(feat\.?|featuring|ft\.?)\s+.*$/i, '') // trailing "feat. X" w/o parens
  s = s.replace(/\s*[-–—]\s*(\d{4}\s*)?remaster(ed)?(\s*\d{4})?\s*$/i, '') // "- 2011 Remaster"
  s = s.replace(/\s*\((\d{4}\s*)?remaster(ed)?(\s*\d{4})?\)\s*$/i, '') // "(2011 Remastered)"
  s = s.replace(/\s+/g, ' ').trim()
  return s
}

// Uses normalizeArtistName (core/library/normalize.ts) rather than this
// module's own normalize() -- confirmed live (2026-08): "The Goo Goo Dolls"
// (source tag) vs Plex's own "Goo Goo Dolls" (no leading article) failed to
// match and reported the track missing despite Plex's title-only search
// surfacing the exact right candidate, because this module's normalize()
// (built for *track title* comparison, where stripping a leading "The"
// could wrongly conflate two different songs) never strips a leading
// article the way artist-name comparison should. normalizeArtistName
// already handles this correctly elsewhere in the codebase (Lidarr artist
// lookups) -- reusing it here keeps the two artist-matching paths
// consistent instead of maintaining separate, drifting rules.
// Whitespace-insensitive on top of that, e.g. a source playlist's
// "Homegrown" vs. Plex's own "Home Grown" tag for the same real band --
// still requires every letter to match in order, so it doesn't loosen into
// genuinely-different-artist false positives the way word-level fuzzy
// matching could.
export function artistNamesMatch(a: string, b: string): boolean {
  const na = normalizeArtistName(a)
  const nb = normalizeArtistName(b)
  return na === nb || na.replace(/\s+/g, '') === nb.replace(/\s+/g, '')
}

export function pickBestTrackMatch(
  items: TrackSearchCandidate[],
  artistName: string,
  trackName: string,
): string | null {
  if (items.length === 0) return null

  const normalizedTrack = normalize(trackName)

  const exactMatches = items.filter((item) => {
    const titleMatch = normalize(item.title) === normalizedTrack
    const artistMatch = item.artists.some((artist) => artistNamesMatch(artist, artistName))
    return titleMatch && artistMatch
  })

  // Prefer a studio release over a live/acoustic/demo album of the same
  // song -- Plex's search-result order has no such preference on its own,
  // so a live re-recording can otherwise win purely by appearing first.
  const studioMatch = exactMatches.find((item) => !isAlternateVersionCandidate(item))
  if (studioMatch) return studioMatch.id

  // Every exact-title match is itself a live/acoustic/demo release -- reject
  // rather than silently importing one. Returning null reports the track as
  // missing so autoRequestMissingPlaylistTracks (src/index.ts) requests the
  // real studio album from Lidarr instead of settling for what's on hand.
  if (exactMatches.length > 0) return null

  const fuzzyStudioMatch = items.find((item) => !isAlternateVersionCandidate(item))
  return (fuzzyStudioMatch ?? items[0])?.id ?? null
}

// Fallback for source playlists that tag a track under a stock/production-
// library "cover" artist instead of the real credited performer -- confirmed
// live (2026-08): a "Greatest 90's Country" import tagged ten tracks to
// "Revline" and eight to "JD & The Straight Chasers", made-up names standing
// in for Brooks & Dunn, Randy Travis, Toby Keith, Rascal Flatts, and others
// -- likely a streaming-catalog backfill for artists who've pulled their
// masters from Spotify/YouTube. pickBestTrackMatch's artist check is exactly
// right to reject a genuine mismatch, but here the source's own artist tag
// was never the real artist to begin with, so requiring it to match can
// never succeed no matter how many times the sync retries.
//
// Only trusted when the *title* match is exact (via normalize(), so
// apostrophe/case/punctuation-style differences still count) and every
// exact-title candidate agrees on one real artist. Deliberately returns null
// the moment two different real artists both have a same-titled recording
// (e.g. "Life Is a Highway" by both Chris LeDoux and Rascal Flatts) -- there's
// no signal here to tell which one the source is standing in for, and
// guessing wrong is exactly the class of bug this whole module exists to
// avoid. Candidates with no artist credit at all are excluded rather than
// treated as their own "distinct artist" bucket, since an untagged Plex
// result can't confirm agreement with anything.
export function pickUnambiguousTitleOnlyMatch(
  items: TrackSearchCandidate[],
  trackName: string,
): string | null {
  const normalizedTrack = normalize(trackName)
  const exactMatches = items.filter(
    (item) => normalize(item.title) === normalizedTrack && item.artists.length > 0,
  )
  if (exactMatches.length === 0) return null

  const distinctArtists = new Set(
    exactMatches.flatMap((item) => item.artists.map(normalizeArtistName)),
  )
  if (distinctArtists.size !== 1) return null

  const studioMatch = exactMatches.find((item) => !isAlternateVersionCandidate(item))
  return (studioMatch ?? exactMatches[0])?.id ?? null
}
