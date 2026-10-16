/**
 * Normalize an artist name for comparison.
 *
 * Rules (in order):
 * 1. Normalize NFD and strip diacritics (Unicode combining marks)
 * 2. Lowercase
 * 3. Strip parenthetical disambiguators: "Madness (UK)" -> "madness"
 * 4. Strip "feat./featuring/ft. ..." suffixes
 * 5. Replace " & " with " and "
 * 6. Strip leading "The "
 * 7. Strip interior ", The ": "Tyler, The Creator" -> "tyler, creator"
 * 8. Collapse whitespace and trim
 *
 * Used by the reconciler. Pure function - no I/O, no globals.
 */
export function normalizeArtistName(raw: string): string {
  if (!raw.trim()) return ''

  let s = raw.normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip diacritics
  // Unify typographic hyphen/dash variants to plain ASCII "-", and drop
  // apostrophes (straight or curly) entirely rather than unifying them --
  // confirmed live against a real Lidarr instance: "Guns N' Roses" (source,
  // straight apostrophe) vs Lidarr's own "Guns N\u2019 Roses" (curly) failed to
  // match on apostrophe style alone, and "The B-52's" (source) vs Lidarr's
  // "The B\u201052s" (typographic hyphen, no apostrophe at all) failed on both
  // -- an artist whose real name is stylized with an apostrophe won't
  // collide with one that isn't once both are stripped to the same string.
  s = s.replace(/[\u2010-\u2015\u2212]/g, '-')
  s = s.replace(/['\u2019\u2018`]/g, '')
  s = s.toLowerCase()
  s = s.replace(/\s*\([^)]*\)\s*/g, ' ') // strip parentheticals
  s = s.replace(/\s+(feat\.?|featuring|ft\.?)\s+.*$/i, '') // strip feat suffix
  s = s.replace(/\s+&\s+/g, ' and ') // & -> and
  s = s.replace(/^the\s+/i, '') // leading "the "
  s = s.replace(/,\s+the\s+/gi, ', ') // interior ", The " (e.g. "Tyler, The Creator")
  s = s.replace(/\s+/g, ' ').trim() // collapse whitespace

  return s
}

export function normalizeAlbumTitle(raw: string): string {
  if (!raw.trim()) return ''

  let s = raw.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  s = s.toLowerCase()
  s = s.replace(/\s*\([^)]*\b(?:deluxe|expanded|remaster(?:ed)?|edition)\b[^)]*\)\s*/gi, ' ')
  s = s.replace(/\s*\[[^\]]*\b(?:deluxe|expanded|remaster(?:ed)?|edition)\b[^\]]*\]\s*/gi, ' ')
  s = s.replace(/\s+/g, ' ').trim()

  return s
}

// Verifies a resolved album target actually contains the song being
// searched for, not just that an album by that name exists for the artist --
// confirmed live (2026-08): Rufus "Ain't Nobody" resolved to the real Lidarr
// album "Numbers", which exists for that artist but only has the
// similarly-titled "Ain't Nobody Like You", a different song; the real hit
// is on "Masterjam". Strips all parentheticals (unlike normalizeAlbumTitle,
// which only strips edition markers) since a source playlist's qualifier
// ("You Make My Dreams (Come True)") is often absent from Lidarr/MusicBrainz's
// own plain title for the same song.
export function normalizeTrackTitle(raw: string): string {
  if (!raw.trim()) return ''

  let s = raw.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  s = s.replace(/[\u2010-\u2015\u2212]/g, '-')
  s = s.replace(/['\u2019\u2018`]/g, '')
  s = s.toLowerCase()
  s = s.replace(/\s*\([^)]*\)\s*/g, ' ')
  s = s.replace(/\s+(feat\.?|featuring|ft\.?)\s+.*$/i, '')
  s = s.replace(/\s+/g, ' ').trim()

  return s
}
