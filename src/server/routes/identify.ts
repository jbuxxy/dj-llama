import { Hono } from 'hono'
import type { MBReleaseGroup } from '@/core/clients/musicbrainz'
import { createMusicBrainzClient } from '@/core/clients/musicbrainz'
import { recognizeSong } from '@/core/clients/shazam'
import { normalizeArtistName } from '@/core/library/normalize'
import { pickBestReleaseGroup } from '@/core/pipeline/resolve'
import type { AppDependencies } from '@/server'
import { requireUser } from '@/server/helpers/require-user'
import { findAlreadyOwnedAlbums, getLidarrClient, resolveImageUrl } from '@/server/routes/requests'
import type { HonoEnv } from '@/server/types'

const MAX_AUDIO_BYTES = 15 * 1024 * 1024

type IdentifyResponse =
  | { matched: false }
  | { matched: true; resolved: false; artist: string; title: string }
  | {
      matched: true
      resolved: true
      artist: string
      title: string
      artistMbid: string
      artistName: string
      releaseGroupMbid: string
      albumTitle: string
      releaseDate?: string
      coverUrl?: string
      alreadyOwned: boolean
    }

export function identifyRoutes(deps: AppDependencies) {
  const router = new Hono<HonoEnv>()

  // Upload a short audio clip, identify the song via Shazam, then resolve it
  // to a MusicBrainz release group the same way /requests/search-tracks
  // does. Deliberately side-effect-free: creating the
  // actual request is a separate call into the existing POST /api/v1/requests
  // (see requests.ts), so all dispatch/auto-approve/already-owned logic stays
  // in exactly one place.
  router.post('/api/v1/identify', async (c) => {
    const auth = requireUser(c)
    if (!auth.ok) return auth.response

    const contentType = c.req.header('content-type') ?? ''
    if (!contentType.includes('multipart/form-data')) {
      return c.json({ error: 'Expected multipart/form-data upload' }, 400)
    }

    const form = await c.req.formData().catch(() => null)
    const file = form?.get('file')
    if (!file || !(file instanceof File)) {
      return c.json({ error: 'No audio file provided' }, 400)
    }
    if (file.size === 0 || file.size > MAX_AUDIO_BYTES) {
      return c.json({ error: 'Audio clip is empty or too large' }, 400)
    }

    const bytes = new Uint8Array(await file.arrayBuffer())
    const identified = await recognizeSong(bytes).catch((err: unknown) => {
      console.warn('[identify] Shazam lookup failed:', err instanceof Error ? err.message : err)
      return null
    })

    if (!identified) {
      return c.json({ matched: false } satisfies IdentifyResponse)
    }

    const candidate = await resolveReleaseGroup(
      deps,
      identified.artist,
      identified.title,
      identified.isrc,
    )
    if (!candidate) {
      return c.json({
        matched: true,
        resolved: false,
        artist: identified.artist,
        title: identified.title,
      } satisfies IdentifyResponse)
    }

    const alreadyOwned = await findAlreadyOwnedAlbums(deps.db, [
      {
        releaseGroupMbid: candidate.releaseGroupMbid,
        artistMbid: candidate.artistMbid,
        albumTitle: candidate.albumTitle,
      },
    ])

    return c.json({
      matched: true,
      resolved: true,
      artist: identified.artist,
      title: identified.title,
      artistMbid: candidate.artistMbid,
      artistName: candidate.artistName,
      releaseGroupMbid: candidate.releaseGroupMbid,
      albumTitle: candidate.albumTitle,
      releaseDate: candidate.releaseDate,
      coverUrl: candidate.coverUrl,
      alreadyOwned: alreadyOwned.has(candidate.releaseGroupMbid),
    } satisfies IdentifyResponse)
  })

  return router
}

type ResolvedCandidate = {
  artistMbid: string
  artistName: string
  releaseGroupMbid: string
  albumTitle: string
  releaseDate?: string
  coverUrl?: string
}

type ReleaseGroupEntry = {
  artistMbid: string
  artistName: string
  releaseGroupMbid: string
  albumTitle: string
  releaseDate?: string
}

// Shared by both resolution paths below: given a set of candidate recording
// MBIDs, pool every release-group they appear on and let pickBestReleaseGroup
// rank studio releases above live/compilation ones (see its doc comment).
async function poolReleaseGroups(
  mb: ReturnType<typeof createMusicBrainzClient>,
  recordingIds: string[],
  normalizedArtist?: string,
): Promise<ReleaseGroupEntry | null> {
  const resolvedHits = await Promise.all(
    recordingIds.map((id) =>
      mb.lookupRecordingWithReleaseGroups(id).catch((err: unknown) => {
        console.warn(
          '[identify] recording lookup failed:',
          err instanceof Error ? err.message : err,
        )
        return null
      }),
    ),
  )

  const pooled: Array<{ rg: MBReleaseGroup; artistMbid: string; artistName: string }> = []
  for (const hit of resolvedHits) {
    if (!hit) continue
    if (normalizedArtist && normalizeArtistName(hit.artistName) !== normalizedArtist) continue
    for (const rg of hit.releaseGroups) {
      pooled.push({ rg, artistMbid: hit.artistMbid, artistName: hit.artistName })
    }
  }

  const winner = pickBestReleaseGroup(pooled.map((p) => p.rg))
  if (!winner) return null
  const match = pooled.find((p) => p.rg.id === winner.id)
  if (!match) return null

  return {
    artistMbid: match.artistMbid,
    artistName: match.artistName,
    releaseGroupMbid: winner.id,
    albumTitle: winner.title,
    releaseDate: winner.firstReleaseDate,
  }
}

// Preferred resolution path: an ISRC identifies the exact official
// recording, assigned by the rights holder -- unlike a title search, it
// essentially never turns up unofficial/fan-bootleg recordings (confirmed
// against MusicBrainz directly: a heavily-bootlegged song's dozen+ live
// recordings had no ISRCs at all, only the one studio recording did). No
// artist re-check needed here; the ISRC match is already authoritative.
async function findReleaseGroupByIsrc(
  mb: ReturnType<typeof createMusicBrainzClient>,
  isrc: string,
): Promise<ReleaseGroupEntry | null> {
  const recordings = await mb.lookupRecordingsByIsrc(isrc).catch((err: unknown) => {
    console.warn('[identify] ISRC lookup failed:', err instanceof Error ? err.message : err)
    return []
  })
  if (recordings.length === 0) return null
  return poolReleaseGroups(
    mb,
    recordings.map((r) => r.id),
  )
}

// Fallback when Shazam has no ISRC on file: queries MusicBrainz for this
// specific artist+title (not a bare title search) -- a heavily-bootlegged
// live act can otherwise crowd the real studio album out of a handful of
// results, since a title-only search has no way to prefer "the song" over
// "this one gig's recording of the song". The artist match is still checked
// client-side as a safety net -- MusicBrainz's artist: field is
// relevance-ranked text, not an exact filter.
async function findBestReleaseGroup(
  mb: ReturnType<typeof createMusicBrainzClient>,
  artist: string,
  title: string,
): Promise<ReleaseGroupEntry | null> {
  const hits = await mb.searchRecordingCandidates(artist, title, 10).catch((err: unknown) => {
    console.warn('[identify] recording search failed:', err instanceof Error ? err.message : err)
    return []
  })
  if (hits.length === 0) return null
  return poolReleaseGroups(
    mb,
    hits.map((h) => h.id),
    normalizeArtistName(artist),
  )
}

// Shazam's title text doesn't always match MusicBrainz's canonical recording
// title exactly (e.g. Shazam returned "A Fallen Angel" for Poison's actual
// "Fallen Angel") -- our search is a quoted-phrase match, so a stray leading
// article is enough to return zero results for the right artist. Retry once
// with it stripped before giving up.
function stripLeadingArticle(title: string): string | null {
  const stripped = title.replace(/^(a|an|the)\s+/i, '')
  return stripped !== title ? stripped : null
}

async function resolveReleaseGroup(
  deps: AppDependencies,
  artist: string,
  title: string,
  isrc?: string,
): Promise<ResolvedCandidate | null> {
  const mb = createMusicBrainzClient()
  let best = isrc ? await findReleaseGroupByIsrc(mb, isrc) : null
  if (!best) best = await findBestReleaseGroup(mb, artist, title)
  if (!best) {
    const altTitle = stripLeadingArticle(title)
    if (altTitle) best = await findBestReleaseGroup(mb, artist, altTitle)
  }
  if (!best) return null

  const resolved = await getLidarrClient(deps)
  let coverUrl: string | undefined
  if (resolved) {
    const { client, imageBaseUrl } = resolved
    const matches = await client
      .lookupAlbum(`lidarr:${best.releaseGroupMbid}`)
      .catch(() => [] as Awaited<ReturnType<typeof client.lookupAlbum>>)
    const album = matches[0]
    coverUrl = resolveImageUrl(
      album?.images.find((img) => img.coverType === 'cover')?.url ?? album?.images[0]?.url,
      imageBaseUrl,
    )
  }

  return {
    artistMbid: best.artistMbid,
    artistName: best.artistName,
    releaseGroupMbid: best.releaseGroupMbid,
    albumTitle: best.albumTitle,
    releaseDate: best.releaseDate,
    coverUrl,
  }
}
