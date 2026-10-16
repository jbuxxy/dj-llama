import { and, eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import { createLidarrClient } from '@/core/clients/lidarr'
import { createMusicBrainzClient } from '@/core/clients/musicbrainz'
import { decryptChannelSecrets } from '@/core/crypto'
import { normalizeAlbumTitle } from '@/core/library/normalize'
import { dispatch, logDispatchFailures } from '@/core/notifications/registry'
import type { WebhookPayload } from '@/core/notifications/types'
import { realtimeBroker } from '@/core/realtime/broker'
import { searchTrackAlbums } from '@/core/search/track-albums'
import { errMsg } from '@/core/validation'
import type { Database } from '@/db'
import { getArtistImageCacheByMbids } from '@/db/queries/artists'
import {
  createRequest,
  dismissAllRequests,
  dismissRequest,
  getRequestById,
  listFailedOpenRequests,
  listPendingRequests,
  listRequestsForUser,
  type RequestStatus,
  resolvePendingRequest,
  resolveRequest,
} from '@/db/queries/requests'
import { libraryAlbums, mergePreferences } from '@/db/schema'
import type { AppDependencies } from '@/server'
import { notAuthenticated } from '@/server/helpers/auth-problems'
import { requireAdmin, requireUser } from '@/server/helpers/require-user'
import {
  approveAlbumToTargets,
  approveToTargets,
  buildAddOptions,
} from '@/server/routes/recommendations'
import {
  createRequestSchema,
  listRequestsQuerySchema,
  mbidParamSchema,
  rejectRequestSchema,
  requestIdParamSchema,
  searchRequestQuerySchema,
} from '@/server/schemas/requests'
import { zJson, zParam, zQuery } from '@/server/schemas/validator'
import type { HonoEnv } from '@/server/types'

type RequestRow = NonNullable<Awaited<ReturnType<typeof getRequestById>>>

const isTargetSuccess = (action: unknown): boolean => {
  const status = (action as { status?: string } | null)?.status
  return status === 'added' || status === 'queued'
}

export async function getLidarrClient(deps: AppDependencies) {
  const settings = await deps.getSettings()
  if (!settings?.lidarrUrl || !settings?.lidarrApiKey) return null
  const client = createLidarrClient(
    settings.lidarrUrl as string,
    settings.lidarrApiKey as string,
    (settings.skipTlsVerify as boolean) ?? false,
  )
  // Lidarr's lookup responses return cover art as paths relative to Lidarr's
  // own origin (e.g. "/MediaCover/104/poster.jpg"), which resolve against
  // the wrong origin (this app's) once rendered in an <img> here. Same
  // public/internal split library-health.tsx already uses for Lidarr links.
  const preferences = settings.preferences as { lidarrPublicUrl?: string } | null
  const imageBaseUrl = (preferences?.lidarrPublicUrl || (settings.lidarrUrl as string)).replace(
    /\/+$/,
    '',
  )
  return { client, imageBaseUrl }
}

export function resolveImageUrl(url: string | undefined, baseUrl: string): string | undefined {
  if (!url) return undefined
  if (/^https?:\/\//i.test(url)) return url
  return `${baseUrl}${url.startsWith('/') ? '' : '/'}${url}`
}

// Track search resolves a MusicBrainz recording to every album it appears
// on, then dedupes across all resolved recordings and sorts the same way
// pickBestReleaseGroup does for track-based recommendations (resolve.ts):
// real studio albums first, EPs next, singles/other after, anything with a
// secondary type (Compilation/Live/etc.) last.
export function releaseGroupTier(entry: {
  primaryType: string
  secondaryTypes?: string[]
}): number {
  if (entry.secondaryTypes?.length) return 3
  if (entry.primaryType === 'Album') return 0
  if (entry.primaryType === 'EP') return 1
  return 2
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
}

// How much of what the user typed this candidate actually accounts for.
// The search box has no separate artist/album fields, so a query like
// "michael jackson thriller" has to work against a single string -- scoring
// a candidate by how many of the query's words show up across *both* its
// artist name and its title (rather than requiring a hand-parsed split)
// means a result that matches artist+album together naturally outranks one
// that only matches the album title, with no guessing about where the
// artist name ends and the album title begins.
function tokenCoverage(queryTokens: string[], candidateTokens: Set<string>): number {
  if (queryTokens.length === 0) return 0
  const matched = queryTokens.filter((t) => candidateTokens.has(t)).length
  return matched / queryTokens.length
}

// MusicBrainz's community rating (vote count + average) is the only
// popularity signal Lidarr's lookup exposes. It's volunteer-sourced, not
// real sales/streaming data, but it's what reliably tells "Thriller by
// Michael Jackson" apart from the nine other same-titled albums by artists
// nobody's heard of when the query is too generic to otherwise rank them.
// log1p on votes so one wildly-voted classic doesn't totally swamp a
// legitimately well-regarded but less-voted result purely on vote count.
function popularityScore(ratings?: { votes: number; value: number }): number {
  if (!ratings) return 0
  return Math.log1p(ratings.votes) * 10 + ratings.value
}

// Shared ranking for both album and artist search results: query-word
// coverage first (actual relevance always wins), popularity as the
// tiebreaker among equally-relevant matches, original order as the final
// tiebreak so otherwise-identical results don't visibly shuffle.
export function rankSearchResults<T>(
  items: T[],
  queryTokens: string[],
  getFields: (item: T) => { tokens: string[]; ratings?: { votes: number; value: number } },
): T[] {
  return items
    .map((item, index) => {
      const { tokens, ratings } = getFields(item)
      return {
        item,
        index,
        coverage: tokenCoverage(queryTokens, new Set(tokens)),
        popularity: popularityScore(ratings),
      }
    })
    .sort((a, b) => b.coverage - a.coverage || b.popularity - a.popularity || a.index - b.index)
    .map((r) => r.item)
}

// "Already in Lidarr" means Lidarr has actually downloaded this album, not
// just that its metadata server can resolve the mbid (lookupAlbum works for
// any valid mbid whether or not it's been added) -- so this checks DJ
// Llama's own synced-from-Lidarr library cache instead of calling Lidarr live.
async function getLidarrDownloadedMbids(db: Database, mbids: string[]): Promise<Set<string>> {
  if (mbids.length === 0) return new Set()
  const rows = await db
    .select({ albumMbid: libraryAlbums.albumMbid })
    .from(libraryAlbums)
    .where(and(eq(libraryAlbums.source, 'lidarr'), inArray(libraryAlbums.albumMbid, mbids)))
  return new Set(rows.map((r) => r.albumMbid).filter((m): m is string => !!m))
}

// Broader "you already have this" check for the request-dedup paths (album
// search, album detail, request creation, pending-queue sweep) -- unlike
// getLidarrDownloadedMbids above, this isn't limited to an exact
// release-group mbid match against Lidarr's own sync. Two real gaps showed
// up in practice: (1) MusicBrainz frequently splits one real studio album
// into multiple release-groups (e.g. the title track's own "single" release
// group vs the actual album, both titled identically) -- Lidarr's search can
// resolve a request to a different release-group id than the one already on
// file for the same artist+title, so an exact-mbid check alone misses a
// genuine duplicate (confirmed live: Bruno Mars' "24K Magic" was already
// synced from both Plex and Lidarr, but under a different release-group id
// than the one this endpoint's caller had resolved). (2) Plex-synced albums
// often have no mbid at all (Plex doesn't tag one), so they're invisible to
// any mbid-only check regardless of source. This adds a same-artist +
// normalized-title fallback across both synced sources.
export async function findAlreadyOwnedAlbums(
  db: Database,
  candidates: Array<{ releaseGroupMbid: string; artistMbid?: string; albumTitle: string }>,
): Promise<Set<string>> {
  if (candidates.length === 0) return new Set()

  const mbidRows = await db
    .select({ albumMbid: libraryAlbums.albumMbid })
    .from(libraryAlbums)
    .where(
      inArray(
        libraryAlbums.albumMbid,
        candidates.map((c) => c.releaseGroupMbid),
      ),
    )
  const owned = new Set(mbidRows.map((r) => r.albumMbid).filter((m): m is string => !!m))

  const artistMbids = [
    ...new Set(candidates.map((c) => c.artistMbid).filter((m): m is string => !!m)),
  ]
  if (artistMbids.length > 0) {
    const artistRows = await db
      .select({
        artistMbid: libraryAlbums.artistMbid,
        titleNormalized: libraryAlbums.titleNormalized,
      })
      .from(libraryAlbums)
      .where(inArray(libraryAlbums.artistMbid, artistMbids))

    const titlesByArtist = new Map<string, Set<string>>()
    for (const row of artistRows) {
      if (!row.artistMbid) continue
      const set = titlesByArtist.get(row.artistMbid) ?? new Set<string>()
      set.add(row.titleNormalized)
      titlesByArtist.set(row.artistMbid, set)
    }

    for (const c of candidates) {
      if (owned.has(c.releaseGroupMbid) || !c.artistMbid) continue
      if (titlesByArtist.get(c.artistMbid)?.has(normalizeAlbumTitle(c.albumTitle))) {
        owned.add(c.releaseGroupMbid)
      }
    }
  }

  return owned
}

/** Dispatch a request to every enabled target that supports its kind, mirroring recommendation approval. */
async function dispatchRequest(
  deps: AppDependencies,
  request: RequestRow,
  requesterId: number,
): Promise<{ status: RequestStatus; targetActions: Record<string, unknown> }> {
  const targets = await deps.getEnabledTargetsForUser(requesterId)

  // Whole-discography requests monitor a specific set of release groups
  // rather than Lidarr's blunt "monitor all" -- getReleaseGroups only
  // returns Album/EP primary types, so singles, compilations, and live
  // releases never get pulled in by a discography request.
  const selectedAlbumIds =
    request.kind === 'artist'
      ? (
          await createMusicBrainzClient()
            .getReleaseGroups(request.artistMbid)
            .catch((err: unknown) => {
              console.warn(
                '[requests] release-group lookup failed:',
                err instanceof Error ? err.message : err,
              )
              return []
            })
        ).map((rg) => rg.id)
      : undefined

  const addOptions = await buildAddOptions(
    deps,
    requesterId,
    { mbid: request.artistMbid, name: request.artistName },
    {
      monitorOption: request.kind === 'artist' ? 'selected' : undefined,
      selectedAlbumIds,
    },
  )

  const result =
    request.kind === 'album' && request.releaseGroupMbid
      ? await approveAlbumToTargets(
          {
            artistMbid: request.artistMbid,
            artistName: request.artistName,
            releaseGroupMbid: request.releaseGroupMbid,
          },
          targets,
          addOptions,
          deps.jobRecorder,
          requesterId,
        )
      : await approveToTargets(
          { mbid: request.artistMbid, name: request.artistName },
          targets,
          addOptions,
          deps.jobRecorder,
          requesterId,
        )

  const anySuccess = Object.values(result.targetActions).some(isTargetSuccess)
  return { status: anySuccess ? 'dispatched' : 'failed', targetActions: result.targetActions }
}

/**
 * Cancel-in-Lidarr for an Open Requests dismiss. Only called for requests
 * that are NOT yet library-confirmed (see the dismiss route below) -- an
 * already-fulfilled request's dismiss never reaches here, so this never
 * touches something the user already has.
 *
 * kind='artist' removes the artist from Lidarr entirely (deleteFiles=false,
 * so anything already grabbed stays on disk) -- safe because dispatch always
 * creates a fresh Lidarr artist for an artist-kind request rather than
 * reusing an existing one (see addArtistToTarget), so this can't be deleting
 * an artist some unrelated content also depends on. kind='album' only
 * un-monitors that one album, leaving the artist (which addAlbum *does*
 * reuse when it already exists) untouched.
 */
async function cancelRequestInTargets(
  deps: AppDependencies,
  request: RequestRow,
  requesterId: number,
): Promise<{ success: boolean; error?: string }> {
  const entries = Object.entries(
    (request.targetActions ?? {}) as Record<
      string,
      { status?: string; externalId?: number | string }
    >,
  ).filter(([, action]) => isTargetSuccess(action))

  if (entries.length === 0) return { success: true }

  const targets = await deps.getEnabledTargetsForUser(requesterId)
  for (const [targetKey, action] of entries) {
    const target = targets.find((t) => t.id === targetKey)
    if (!target || action.externalId == null) {
      return { success: false, error: `Could not find target "${targetKey}" to cancel` }
    }
    const result =
      request.kind === 'artist'
        ? await target.removeArtist?.(action.externalId, { deleteFiles: false })
        : await target.unmonitorAlbum?.(action.externalId)
    if (!result) {
      return { success: false, error: `Target "${targetKey}" does not support cancellation` }
    }
    if (!result.success) {
      return { success: false, error: result.error ?? 'Cancel failed' }
    }
  }
  return { success: true }
}

function requestSubjectTitle(request: RequestRow): string {
  return request.kind === 'album' && request.albumTitle
    ? `${request.artistName} — ${request.albumTitle}`
    : request.artistName
}

// Fire-and-forget, admin-facing only (mirrors the pipeline's batch_complete
// dispatch in orchestrator.ts). Both events here are things an admin wants to
// know about, not the requester -- notifying the requester themselves is a
// separate, not-yet-built per-user notification feature.
async function notifyRequestEvent(
  deps: AppDependencies,
  event: 'request_pending_approval' | 'request_auto_approved',
  request: RequestRow,
  requesterName: string,
  dispatchStatus?: RequestStatus,
): Promise<void> {
  const settings = await deps.getSettings()
  const prefs = mergePreferences(settings?.preferences)
  const channels = decryptChannelSecrets(prefs.channels ?? [])
  if (channels.length === 0) return

  const subjectTitle = requestSubjectTitle(request)
  const imageUrl = request.coverUrl ?? undefined
  const timestamp = new Date().toISOString()
  const status: 'dispatched' | 'failed' = dispatchStatus === 'dispatched' ? 'dispatched' : 'failed'

  const payload: WebhookPayload =
    event === 'request_pending_approval'
      ? {
          event,
          requestId: request.id,
          requesterName,
          subjectTitle,
          imageUrl,
          message: `${requesterName} requested ${subjectTitle} — pending approval.`,
          timestamp,
        }
      : {
          event,
          requestId: request.id,
          requesterName,
          subjectTitle,
          imageUrl,
          status,
          message:
            status === 'failed'
              ? `${requesterName}’s request for ${subjectTitle} was auto-approved but dispatch failed.`
              : `${requesterName}’s request for ${subjectTitle} was auto-approved.`,
          timestamp,
        }

  dispatch(channels, event, payload)
    .then(logDispatchFailures)
    .catch((err) => console.error('Notification dispatch failed:', err))
}

export function requestRoutes(deps: AppDependencies) {
  const router = new Hono<HonoEnv>()

  // Fast album+artist search scoped to
  // exactly what Lidarr itself can resolve (its own metadata-server lookup),
  // so every result is guaranteed requestable.
  router.get('/api/v1/requests/search', zQuery(searchRequestQuerySchema), async (c) => {
    const auth = requireUser(c)
    if (!auth.ok) return auth.response

    const resolved = await getLidarrClient(deps)
    if (!resolved) return c.json({ error: 'Lidarr is not configured' }, 503)
    const { client, imageBaseUrl } = resolved

    const { q } = c.req.valid('query')
    const [albums, artists] = await Promise.all([
      client.lookupAlbum(q).catch((err: unknown) => {
        console.warn('[requests] album lookup failed:', err instanceof Error ? err.message : err)
        return []
      }),
      client.lookupArtist(q).catch((err: unknown) => {
        console.warn('[requests] artist lookup failed:', err instanceof Error ? err.message : err)
        return []
      }),
    ])

    // Lidarr/MusicBrainz's own lookup ordering doesn't account for which
    // same-titled result is actually the famous one, nor does it reward a
    // result that matches both an artist and album name the user typed
    // together (e.g. "michael jackson thriller" buries the real Thriller
    // behind seven unrelated same-titled albums) -- see rankSearchResults.
    const queryTokens = tokenize(q)
    const rankedAlbums = rankSearchResults(
      albums.filter((a) => a.artist?.foreignArtistId),
      queryTokens,
      (a) => ({
        tokens: [...tokenize(a.title), ...tokenize(a.artist?.artistName ?? '')],
        ratings: a.ratings,
      }),
    )
    const rankedArtists = rankSearchResults(artists, queryTokens, (a) => ({
      tokens: tokenize(a.artistName),
      ratings: a.ratings,
    }))

    // Lidarr's MusicBrainz-backed artist lookup never returns an artist
    // photo (only album/release covers have images) -- fall back to
    // whatever image DJ Llama's own pipeline has already cached for artists
    // it has previously resolved, rather than always showing the generic
    // placeholder icon.
    const artistSlice = rankedArtists.slice(0, 20)
    const albumsWithArtist = rankedAlbums
    const [imageCache, alreadyOwned] = await Promise.all([
      getArtistImageCacheByMbids(
        deps.db,
        artistSlice.map((a) => a.foreignArtistId),
      ),
      findAlreadyOwnedAlbums(
        deps.db,
        albumsWithArtist.map((a) => ({
          releaseGroupMbid: a.foreignAlbumId,
          artistMbid: a.artist?.foreignArtistId,
          albumTitle: a.title,
        })),
      ),
    ])
    const cachedImageByMbid = new Map(imageCache.map((row) => [row.mbid, row.imageUrl]))

    return c.json({
      albums: albumsWithArtist.map((a) => ({
        kind: 'album' as const,
        artistMbid: a.artist?.foreignArtistId,
        artistName: a.artist?.artistName,
        releaseGroupMbid: a.foreignAlbumId,
        albumTitle: a.title,
        releaseDate: a.releaseDate,
        coverUrl: resolveImageUrl(
          a.images.find((img) => img.coverType === 'cover')?.url ?? a.images[0]?.url,
          imageBaseUrl,
        ),
        alreadyOwned: alreadyOwned.has(a.foreignAlbumId),
      })),
      artists: artistSlice.map((a) => ({
        kind: 'artist' as const,
        artistMbid: a.foreignArtistId,
        artistName: a.artistName,
        genres: a.genres ?? [],
        coverUrl:
          resolveImageUrl(
            a.images?.find((img) => img.coverType === 'poster')?.url ?? a.images?.[0]?.url,
            imageBaseUrl,
          ) ??
          cachedImageByMbid.get(a.foreignArtistId) ??
          undefined,
      })),
    })
  })

  // Free-text track/song-name search.
  // Unlike the Lidarr-backed search above, this goes straight to MusicBrainz
  // (no Lidarr equivalent exists for recording search), so it's deliberately
  // not "as you type" -- a search costs several requests against
  // MusicBrainz's shared 1-req/sec rate limit, so this is meant to be
  // triggered by an explicit search action, not live keystrokes.
  router.get('/api/v1/requests/search-tracks', zQuery(searchRequestQuerySchema), async (c) => {
    const auth = requireUser(c)
    if (!auth.ok) return auth.response

    const resolved = await getLidarrClient(deps)
    if (!resolved) return c.json({ error: 'Lidarr is not configured' }, 503)
    const { client, imageBaseUrl } = resolved

    const { q } = c.req.valid('query')
    // Identify the song from free text, then rank every album it appears on
    // under that artist -- see searchTrackAlbums for why it takes two steps.
    // A MusicBrainz failure (it's often 503-busy) is reported as an error,
    // not an empty result -- "No matches found" for a search that never ran
    // reads as "this song doesn't exist".
    let entries: Awaited<ReturnType<typeof searchTrackAlbums>>
    try {
      entries = await searchTrackAlbums(createMusicBrainzClient(), q)
    } catch (err) {
      console.warn('[requests] track search failed:', errMsg(err))
      return c.json({ error: 'MusicBrainz is busy -- try the search again in a moment.' }, 502)
    }

    const [lidarrDownloaded, lidarrLookups] = await Promise.all([
      getLidarrDownloadedMbids(
        deps.db,
        entries.map((e) => e.releaseGroupMbid),
      ),
      Promise.all(
        entries.map((e) =>
          client.lookupAlbum(`lidarr:${e.releaseGroupMbid}`).catch((err: unknown) => {
            console.warn(
              '[requests] track-search album cover lookup failed:',
              err instanceof Error ? err.message : err,
            )
            return []
          }),
        ),
      ),
    ])

    return c.json({
      tracks: entries.map((entry, i) => {
        const album = lidarrLookups[i]?.[0]
        return {
          ...entry,
          coverUrl: album
            ? resolveImageUrl(
                album.images.find((img) => img.coverType === 'cover')?.url ?? album.images[0]?.url,
                imageBaseUrl,
              )
            : undefined,
          inLidarr: lidarrDownloaded.has(entry.releaseGroupMbid),
        }
      }),
    })
  })

  // Discography page header (name/genres/
  // cover). The album list itself reuses the existing GET /api/v1/albums/:mbid
  // (artists.ts, MusicBrainz release-groups) rather than duplicating it here.
  router.get('/api/v1/requests/artist/:mbid', zParam(mbidParamSchema), async (c) => {
    const auth = requireUser(c)
    if (!auth.ok) return auth.response

    const resolved = await getLidarrClient(deps)
    if (!resolved) return c.json({ error: 'Lidarr is not configured' }, 503)
    const { client, imageBaseUrl } = resolved

    const { mbid } = c.req.valid('param')
    const matches = await client.lookupArtist(`lidarr:${mbid}`).catch((err: unknown) => {
      console.warn(
        '[requests] artist detail lookup failed:',
        err instanceof Error ? err.message : err,
      )
      return []
    })
    const artist = matches[0]
    if (!artist) return c.json({ error: 'Artist not found' }, 404)

    const lidarrCoverUrl = resolveImageUrl(
      artist.images?.find((img) => img.coverType === 'poster')?.url ?? artist.images?.[0]?.url,
      imageBaseUrl,
    )
    const cachedImage = lidarrCoverUrl
      ? null
      : (await getArtistImageCacheByMbids(deps.db, [mbid]))[0]

    return c.json({
      artistMbid: mbid,
      artistName: artist.artistName,
      genres: artist.genres ?? [],
      coverUrl: lidarrCoverUrl ?? cachedImage?.imageUrl ?? undefined,
    })
  })

  // Album detail page (title/artist/cover
  // from Lidarr's own lookup, tracklist from MusicBrainz -- Lidarr has no
  // tracklist for an album that isn't added yet).
  router.get('/api/v1/requests/album/:mbid', zParam(mbidParamSchema), async (c) => {
    const auth = requireUser(c)
    if (!auth.ok) return auth.response

    const resolved = await getLidarrClient(deps)
    if (!resolved) return c.json({ error: 'Lidarr is not configured' }, 503)
    const { client, imageBaseUrl } = resolved

    const { mbid } = c.req.valid('param')
    const [matches, tracks] = await Promise.all([
      client.lookupAlbum(`lidarr:${mbid}`).catch((err: unknown) => {
        console.warn(
          '[requests] album detail lookup failed:',
          err instanceof Error ? err.message : err,
        )
        return []
      }),
      createMusicBrainzClient()
        .getReleaseTracks(mbid)
        .catch((err: unknown) => {
          console.warn(
            '[requests] tracklist lookup failed:',
            err instanceof Error ? err.message : err,
          )
          return []
        }),
    ])
    const album = matches[0]
    if (!album) return c.json({ error: 'Album not found' }, 404)

    const alreadyOwned = await findAlreadyOwnedAlbums(deps.db, [
      {
        releaseGroupMbid: mbid,
        artistMbid: album.artist?.foreignArtistId,
        albumTitle: album.title,
      },
    ])

    return c.json({
      releaseGroupMbid: mbid,
      albumTitle: album.title,
      artistMbid: album.artist?.foreignArtistId,
      artistName: album.artist?.artistName,
      releaseDate: album.releaseDate,
      coverUrl: resolveImageUrl(
        album.images.find((img) => img.coverType === 'cover')?.url ?? album.images[0]?.url,
        imageBaseUrl,
      ),
      alreadyOwned: alreadyOwned.has(mbid),
      tracks,
    })
  })

  // Admins, the server owner, and
  // any user an admin has flagged autoApproveRequests dispatch albums
  // immediately; everyone else lands in the pending admin queue. Artist-kind
  // requests (whole discography -- monitors and searches every album) always
  // land in the queue regardless of trust level: it's the one request type
  // with a blast radius big enough that a second, deliberate approval step
  // is worth requiring even from an otherwise-trusted requester.
  router.post('/api/v1/requests', zJson(createRequestSchema), async (c) => {
    const auth = requireUser(c)
    if (!auth.ok) return auth.response

    const requester = await deps.getUserById(auth.userId)
    if (!requester) return notAuthenticated(c)

    const body = c.req.valid('json')

    // The album-detail page's request button (album-details.tsx) has no
    // already-owned check at all -- unlike /requests/search's alreadyOwned
    // badge, which only warns, not blocks. Guard here too so a stale or
    // unchecked entry point can't create a request for something already
    // in the library.
    if (body.kind === 'album' && body.releaseGroupMbid && body.albumTitle) {
      const owned = await findAlreadyOwnedAlbums(deps.db, [
        {
          releaseGroupMbid: body.releaseGroupMbid,
          artistMbid: body.artistMbid,
          albumTitle: body.albumTitle,
        },
      ])
      if (owned.has(body.releaseGroupMbid)) {
        return c.json({ error: 'This album is already in your library' }, 409)
      }
    }

    const created = await createRequest(deps.db, {
      requestedByUserId: auth.userId,
      kind: body.kind,
      artistMbid: body.artistMbid,
      artistName: body.artistName,
      releaseGroupMbid: body.releaseGroupMbid,
      albumTitle: body.albumTitle,
      coverUrl: body.coverUrl,
    })

    const autoDispatches =
      body.kind === 'album' &&
      (requester.isAdmin || requester.isOwner || requester.autoApproveRequests === true)
    if (!autoDispatches) {
      void notifyRequestEvent(deps, 'request_pending_approval', created, requester.username)
      realtimeBroker.publish(auth.userId, { type: 'request-updated', requestId: created.id })
      return c.json(created, 201)
    }

    const { status, targetActions } = await dispatchRequest(deps, created, auth.userId)
    await resolveRequest(deps.db, created.id, {
      status,
      decidedByUserId: auth.userId,
      targetActions,
    })
    void notifyRequestEvent(deps, 'request_auto_approved', created, requester.username, status)
    realtimeBroker.publish(auth.userId, { type: 'request-updated', requestId: created.id })
    return c.json({ ...created, status, targetActions }, 201)
  })

  // Users with a "Retry failed" run in progress (see the retry-failed route
  // below) -- reported on the list response so the button can keep showing
  // progress for the minutes a throttled retry takes.
  const retryingUsers = new Set<number>()

  router.get('/api/v1/requests', zQuery(listRequestsQuerySchema), async (c) => {
    const auth = requireUser(c)
    if (!auth.ok) return auth.response
    const { limit, offset, libraryStatus } = c.req.valid('query')
    const result = await listRequestsForUser(deps.db, auth.userId, {
      limit,
      offset,
      excludeDismissed: true,
      libraryStatus,
    })
    return c.json({ ...result, retryingFailed: retryingUsers.has(auth.userId) })
  })

  // Pure personal-visibility action: hides the row from this user's My
  // Requests list without touching its status/history, and without a
  // separate "show dismissed" view to bring it back (see schema.ts's
  // dismissedAt comment). Owner-only, no admin override -- unlike
  // retry/approve/reject this isn't a workflow transition another party
  // needs to see, so no realtimeBroker publish either.
  router.post('/api/v1/requests/:id/dismiss', zParam(requestIdParamSchema), async (c) => {
    const auth = requireUser(c)
    if (!auth.ok) return auth.response
    const { id } = c.req.valid('param')

    const request = await getRequestById(deps.db, id)
    if (!request || request.requestedByUserId !== auth.userId) {
      return c.json({ error: 'Request not found' }, 404)
    }

    // Added to Library: pure notification-style hide, never touches Lidarr --
    // the content already arrived, there's nothing to cancel.
    if (!request.libraryConfirmedAt) {
      const cancel = await cancelRequestInTargets(deps, request, auth.userId)
      if (!cancel.success) {
        return c.json({ error: cancel.error ?? 'Failed to cancel in Lidarr' }, 502)
      }
    }

    const applied = await dismissRequest(deps.db, id, auth.userId)
    if (!applied) return c.json({ error: 'Request not found' }, 404)
    return c.body(null, 204)
  })

  // "Clear all" on the Added to Library tab only -- same personal-visibility
  // scope as single dismiss, just every already-fulfilled row at once.
  // Deliberately not exposed for Open Requests: those are still in-flight
  // (see dismissAllRequests's doc comment), so clearing them stays
  // individual-dismiss-only, each one gated by its own confirmation.
  router.post('/api/v1/requests/dismiss-all', async (c) => {
    const auth = requireUser(c)
    if (!auth.ok) return auth.response
    const count = await dismissAllRequests(deps.db, auth.userId, 'in_library')
    return c.json({ count })
  })

  // Admin approval queue.
  //
  // Album-kind requests can go stale before an admin ever reviews them: the
  // requester's search only warns about an already-owned album at the
  // moment they search (see /requests/search's alreadyOwned), the
  // album-detail page's request button has no such check at all, and the
  // library sync can independently pick up the album after the request was
  // already submitted. Unlike recommendations (reconcile-fulfillment.ts
  // auto-rejects a still-pending one that turns out to be owned), requests
  // had no equivalent -- a fulfilled-before-approval request just sat in
  // this queue forever, waiting to be approved into a redundant Lidarr add.
  // Sweep it here, on every load of this queue, using the same
  // already-owned check the search endpoint uses (exact mbid, or same
  // artist + normalized title -- see findAlreadyOwnedAlbums).
  router.get('/api/v1/requests/pending', zQuery(listRequestsQuerySchema), async (c) => {
    const auth = await requireAdmin(c, deps.getUserById)
    if (!auth.ok) return auth.response
    const { limit, offset } = c.req.valid('query')
    const items = await listPendingRequests(deps.db, { limit, offset })

    const albumItems = items.filter(
      (r): r is typeof r & { releaseGroupMbid: string; albumTitle: string } =>
        r.kind === 'album' && !!r.releaseGroupMbid && !!r.albumTitle,
    )
    const alreadyOwned = await findAlreadyOwnedAlbums(
      deps.db,
      albumItems.map((r) => ({
        releaseGroupMbid: r.releaseGroupMbid,
        artistMbid: r.artistMbid,
        albumTitle: r.albumTitle,
      })),
    )
    const staleIds = albumItems.filter((r) => alreadyOwned.has(r.releaseGroupMbid)).map((r) => r.id)

    if (staleIds.length === 0) return c.json(items)

    for (const id of staleIds) {
      const applied = await resolvePendingRequest(deps.db, id, {
        status: 'rejected',
        rejectionReason: 'Already in your library',
      })
      if (applied) {
        const item = items.find((r) => r.id === id)
        if (item) {
          realtimeBroker.publish(item.requestedByUserId, {
            type: 'request-updated',
            requestId: id,
          })
        }
      }
    }

    return c.json(items.filter((r) => !staleIds.includes(r.id)))
  })

  router.post('/api/v1/requests/:id/approve', zParam(requestIdParamSchema), async (c) => {
    const auth = await requireAdmin(c, deps.getUserById)
    if (!auth.ok) return auth.response

    const { id } = c.req.valid('param')
    const request = await getRequestById(deps.db, id)
    if (!request) return c.json({ error: 'Request not found' }, 404)
    if (request.status !== 'pending') {
      return c.json({ error: `Request is already ${request.status}` }, 409)
    }

    const { status, targetActions } = await dispatchRequest(
      deps,
      request,
      request.requestedByUserId,
    )
    const applied = await resolvePendingRequest(deps.db, id, {
      status,
      decidedByUserId: auth.userId,
      targetActions,
    })
    if (!applied) {
      return c.json({ error: 'Request was already decided' }, 409)
    }
    realtimeBroker.publish(request.requestedByUserId, { type: 'request-updated', requestId: id })
    return c.json({ ...request, status, targetActions, decidedByUserId: auth.userId })
  })

  router.post(
    '/api/v1/requests/:id/reject',
    zParam(requestIdParamSchema),
    zJson(rejectRequestSchema),
    async (c) => {
      const auth = await requireAdmin(c, deps.getUserById)
      if (!auth.ok) return auth.response

      const { id } = c.req.valid('param')
      const { rejectionReason } = c.req.valid('json')
      const request = await getRequestById(deps.db, id)
      if (!request) return c.json({ error: 'Request not found' }, 404)
      if (request.status !== 'pending') {
        return c.json({ error: `Request is already ${request.status}` }, 409)
      }

      const applied = await resolvePendingRequest(deps.db, id, {
        status: 'rejected',
        decidedByUserId: auth.userId,
        rejectionReason,
      })
      if (!applied) {
        return c.json({ error: 'Request was already decided' }, 409)
      }
      realtimeBroker.publish(request.requestedByUserId, { type: 'request-updated', requestId: id })
      return c.json({
        ...request,
        status: 'rejected',
        rejectionReason,
        decidedByUserId: auth.userId,
      })
    },
  )

  // "Retry failed" on the Open Requests tab -- the caller's own failed rows
  // only (same ownership scope as dismiss-all). Runs in the background: every
  // add goes through the Lidarr throttle (targets/lidarr-throttle.ts), so a
  // big backlog can take far longer than an HTTP request should stay open.
  // Rows update live via the realtime 'request-updated' events.
  router.post('/api/v1/requests/retry-failed', async (c) => {
    const auth = requireUser(c)
    if (!auth.ok) return auth.response
    const userId = auth.userId
    if (retryingUsers.has(userId)) {
      return c.json({ error: 'A retry of failed requests is already running' }, 409)
    }

    const failed = await listFailedOpenRequests(deps.db, userId)
    if (failed.length === 0) return c.json({ retrying: 0 })

    retryingUsers.add(userId)
    void (async () => {
      let dispatched = 0
      for (const request of failed) {
        try {
          const { status, targetActions } = await dispatchRequest(deps, request, userId)
          await resolveRequest(deps.db, request.id, {
            status,
            decidedByUserId: userId,
            targetActions,
          })
          if (status === 'dispatched') dispatched++
          realtimeBroker.publish(userId, { type: 'request-updated', requestId: request.id })
        } catch (err) {
          console.error(`[requests] retry-failed: request ${request.id} errored:`, errMsg(err))
        }
      }
      console.log(`[requests] retry-failed: ${dispatched}/${failed.length} sent to Lidarr`)
    })().finally(() => {
      retryingUsers.delete(userId)
      // One last refresh once the run is over, so the list sees
      // retryingFailed flip back to false.
      const last = failed[failed.length - 1]
      if (last) realtimeBroker.publish(userId, { type: 'request-updated', requestId: last.id })
    })

    return c.json({ retrying: failed.length }, 202)
  })

  // Re-attempt dispatch for a request that
  // failed, or one that got created but never actually reached dispatch
  // (see index.ts's autoRequestMissingPlaylistTracks -- an interrupted
  // playlist-import batch can leave a row 'pending' with no targetActions,
  // which otherwise sits stuck forever with nothing in the UI to act on it).
  // Usable by the request's own owner or an admin, not just an admin, since
  // a 'failed' request (Lidarr timeout, transient network error, etc.) is
  // routine and the owner shouldn't have to find an admin to unstick it.
  router.post('/api/v1/requests/:id/retry', zParam(requestIdParamSchema), async (c) => {
    const auth = requireUser(c)
    if (!auth.ok) return auth.response

    const { id } = c.req.valid('param')
    const request = await getRequestById(deps.db, id)
    if (!request) return c.json({ error: 'Request not found' }, 404)

    const actor = await deps.getUserById(auth.userId)
    if (!actor) return notAuthenticated(c)
    const isOwnRequest = request.requestedByUserId === auth.userId
    if (!isOwnRequest && !actor.isAdmin && !actor.isOwner) {
      return c.json({ error: 'Not authorized to retry this request' }, 403)
    }

    const owner = await deps.getUserById(request.requestedByUserId)
    const ownerAutoDispatches =
      !!owner && (owner.isAdmin || owner.isOwner || owner.autoApproveRequests === true)
    const retryable =
      request.status === 'failed' ||
      (request.status === 'pending' && request.targetActions == null && ownerAutoDispatches)
    if (!retryable) {
      return c.json({ error: `Request is ${request.status} and cannot be retried` }, 409)
    }

    const { status, targetActions } = await dispatchRequest(
      deps,
      request,
      request.requestedByUserId,
    )
    await resolveRequest(deps.db, id, {
      status,
      decidedByUserId: auth.userId,
      targetActions,
    })
    realtimeBroker.publish(request.requestedByUserId, { type: 'request-updated', requestId: id })
    return c.json({ ...request, status, targetActions, decidedByUserId: auth.userId })
  })

  return router
}
