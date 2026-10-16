import { and, eq, gte, inArray, lte, or } from 'drizzle-orm'
import type { Database } from '@/db'
import { libraryAlbums, libraryArtists } from '@/db/schema'

export type LibraryAlbumCandidate = {
  artistName: string
  artistMbid?: string
  albumTitle: string
  albumMbid?: string
  releaseYear?: number
  genres?: string[]
}

export type LibraryFilterOptions = {
  userId: number | null
  genre?: string
  /** Multi-select genre filter (OR-matched) -- manual playlist generation's UI, distinct from the single auto-extracted `genre` above. */
  genres?: string[]
  /** A decade start year, e.g. 1990 matches 1990-1999 -- auto-extracted from
   *  free text when no explicit `decades` filter is set below. */
  decade?: number
  /** Multi-select decade filter (OR-matched) -- manual playlist generation's
   *  UI, distinct from the single auto-extracted `decade` above. Empty/unset
   *  means every decade is available. */
  decades?: number[]
  /** Excludes albums whose title looks like a live recording (see LIVE_TITLE_PATTERN). */
  excludeLive?: boolean
  albumTypes?: string[]
  limit?: number
}

const DEFAULT_ALBUM_TYPES = ['Album', 'EP']
const MAX_LIBRARY_CANDIDATE_POOL = 150

// No dedicated "is this a live release" column exists, so this is a
// title-text heuristic -- catches the overwhelming majority of live albums
// (parenthetical/bracketed "(Live)", "[Live at ...]", or a leading/trailing
// "Live" word) without needing a MusicBrainz round-trip per candidate.
const LIVE_TITLE_PATTERN = /[([]\s*live\b|\blive\s+(at|in|from)\b|\(live\)|-\s*live$/i

/**
 * Scopes the AI playlist-selection candidate pool to the listener's real
 * library *before* the model ever sees it (genre/decade/album-type), rather
 * than handing over the full unfiltered catalog -- mediasage's filter-first
 * design. Over-fetches then shuffles before capping: the DB always returns
 * rows in the same order, and a library can run into the thousands, so a
 * plain LIMIT would show the same few hundred albums on every generation.
 */
export async function filterLibraryAlbums(
  db: Database,
  opts: LibraryFilterOptions,
): Promise<LibraryAlbumCandidate[]> {
  const albumTypes = opts.albumTypes ?? DEFAULT_ALBUM_TYPES
  const limit = opts.limit ?? MAX_LIBRARY_CANDIDATE_POOL
  const decadeRanges =
    opts.decades && opts.decades.length > 0
      ? opts.decades
      : opts.decade != null
        ? [opts.decade]
        : []

  const rows = await db
    .select({
      artistName: libraryArtists.name,
      artistMbid: libraryArtists.mbid,
      albumTitle: libraryAlbums.title,
      albumMbid: libraryAlbums.albumMbid,
      releaseYear: libraryAlbums.releaseYear,
      genres: libraryArtists.genres,
    })
    .from(libraryAlbums)
    .innerJoin(
      libraryArtists,
      and(
        eq(libraryArtists.mbid, libraryAlbums.artistMbid),
        opts.userId != null ? eq(libraryArtists.userId, opts.userId) : undefined,
      ),
    )
    .where(
      and(
        opts.userId != null ? eq(libraryAlbums.userId, opts.userId) : undefined,
        inArray(libraryAlbums.primaryType, albumTypes),
        decadeRanges.length > 0
          ? or(
              ...decadeRanges.map((d) =>
                and(gte(libraryAlbums.releaseYear, d), lte(libraryAlbums.releaseYear, d + 9)),
              ),
            )
          : undefined,
      ),
    )
    .limit(limit * 4)

  let candidates: LibraryAlbumCandidate[] = rows
    .filter((r) => r.albumTitle && r.artistName)
    .map((r) => ({
      artistName: r.artistName,
      artistMbid: r.artistMbid ?? undefined,
      albumTitle: r.albumTitle,
      albumMbid: r.albumMbid ?? undefined,
      releaseYear: r.releaseYear ?? undefined,
      genres: r.genres ?? [],
    }))

  if (opts.genre) {
    const g = opts.genre.toLowerCase()
    candidates = candidates.filter((c) =>
      c.genres?.some((genre) => genre.toLowerCase().includes(g)),
    )
  }

  if (opts.genres && opts.genres.length > 0) {
    const wanted = opts.genres.map((g) => g.toLowerCase())
    candidates = candidates.filter((c) =>
      c.genres?.some((genre) => wanted.some((w) => genre.toLowerCase().includes(w))),
    )
  }

  if (opts.excludeLive) {
    candidates = candidates.filter((c) => !LIVE_TITLE_PATTERN.test(c.albumTitle))
  }

  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const tmp = candidates[i]
    const swap = candidates[j]
    if (tmp === undefined || swap === undefined) continue
    candidates[i] = swap
    candidates[j] = tmp
  }

  return candidates.slice(0, limit)
}

/** Matches "90s" or "1990s" (case-insensitive). Deterministic, no AI call needed. */
export function extractDecadeFromText(text: string): number | undefined {
  const fourDigit = text.match(/\b(19|20)\d0s\b/i)
  if (fourDigit) return Number.parseInt(fourDigit[0], 10)

  const twoDigit = text.match(/\b(\d0)s\b/i)
  const digits = twoDigit?.[1]
  if (digits) {
    const n = Number.parseInt(digits, 10)
    if (!Number.isNaN(n)) return n <= 29 ? 2000 + n : 1900 + n
  }
  return undefined
}

/**
 * Matches a genre already present in the listener's library against the
 * free-text request, so the filter can only ever narrow to a genre that
 * genuinely exists rather than one the model or user invents.
 */
export function extractGenreFromText(text: string, knownGenres: string[]): string | undefined {
  const lower = text.toLowerCase()
  const sorted = [...knownGenres].filter(Boolean).sort((a, b) => b.length - a.length)
  return sorted.find((genre) => lower.includes(genre.toLowerCase()))
}
