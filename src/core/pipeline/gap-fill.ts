import PQueue from 'p-queue'
import type { AlbumCoverage } from '@/core/library/album-coverage'
import type { DiscoveredArtist } from '@/core/types'
import type { GapFillArtist } from '@/db/queries/gap-fill'

type RawGapFillCandidateBase = {
  name: string
  mbid?: string
  sourceUrl?: string
  provenanceMode?: string
  provenanceProvider: string
  confidenceHint?: number
  explanationHint?: string
  fallbackUsed: boolean
  freshnessDate?: string
}

export type RawGapFillCandidate = RawGapFillCandidateBase & {
  candidateType: 'release'
  artistName: string
  artistMbid: string
  releaseMbid?: string
  releaseGroupMbid?: string
}

type GapFillCandidate = RawGapFillCandidate & { provenanceMode: string }

function normalizeGapFillCandidates(candidates: RawGapFillCandidate[]): GapFillCandidate[] {
  return candidates.map((candidate) => ({
    ...candidate,
    provenanceMode: candidate.provenanceMode || 'gap-fill',
  }))
}

function gapFillCandidatesToDiscoveredArtists(candidates: GapFillCandidate[]): DiscoveredArtist[] {
  return candidates.reduce<DiscoveredArtist[]>((results, candidate) => {
    if (!candidate.artistName?.trim()) {
      return results
    }

    results.push({
      name: candidate.artistName,
      mbid: candidate.artistMbid,
      similarityScore: candidate.confidenceHint ?? 0.7,
      aiReasoning: candidate.explanationHint,
      suggestedAlbum: candidate.name,
      source: candidate.provenanceMode,
      sourceUrl: candidate.sourceUrl,
      releaseGroupMbid: candidate.releaseGroupMbid,
      releaseDate: candidate.freshnessDate,
    })
    return results
  }, [])
}

/**
 * Turn an artist's missing studio albums into gap-fill candidates.
 * `freshnessDate` is the release year (string) so the album scorer's recency
 * signal applies; omitted when the year is unknown.
 */
export function coverageToReleaseCandidates(
  coverage: AlbumCoverage,
  artistName: string,
): RawGapFillCandidate[] {
  return coverage.missing.map((album) => ({
    candidateType: 'release' as const,
    name: album.title,
    artistName,
    artistMbid: coverage.artistMbid,
    releaseGroupMbid: album.albumMbid,
    provenanceProvider: 'gap-fill',
    fallbackUsed: false,
    ...(album.releaseYear != null ? { freshnessDate: String(album.releaseYear) } : {}),
  }))
}

type GapFillDeps = {
  getArtistsForGapFill: (db: unknown, userId: number, limit: number) => Promise<GapFillArtist[]>
  markArtistsGapChecked: (db: unknown, ids: number[]) => Promise<void>
  getCoverageForArtist: (userId: number, artistMbid: string) => Promise<AlbumCoverage>
}

/**
 * Rotates through a bounded batch of the user's owned artists, finds each
 * one's missing studio albums via MusicBrainz, and returns them as
 * DiscoveredArtist candidates for the pipeline's always-on gap-fill branch
 * (orchestrator.ts). Rate-limited via a small queue so repeated calls stay
 * cheap and never hammer MusicBrainz.
 */
export async function findGapFillCandidates(
  deps: GapFillDeps,
  userId: number,
  maxArtists: number,
): Promise<DiscoveredArtist[]> {
  const artists = await deps.getArtistsForGapFill({}, userId, maxArtists)
  if (artists.length === 0) return []

  // Concurrency 2 + small spacing: one live MB getReleaseGroups call per artist
  // would otherwise starve the event loop (k8s liveness probe gotcha).
  const queue = new PQueue({ concurrency: 2, interval: 200, intervalCap: 2 })
  const perArtist = await Promise.all(
    artists.map((artist) =>
      queue.add(async (): Promise<RawGapFillCandidate[]> => {
        try {
          const coverage = await deps.getCoverageForArtist(userId, artist.mbid)
          return coverageToReleaseCandidates(coverage, artist.name)
        } catch {
          return []
        }
      }),
    ),
  )

  await deps.markArtistsGapChecked(
    {},
    artists.map((artist) => artist.id),
  )

  const rawCandidates = perArtist
    .filter((entry): entry is RawGapFillCandidate[] => Array.isArray(entry))
    .flat()
  return gapFillCandidatesToDiscoveredArtists(normalizeGapFillCandidates(rawCandidates))
}
