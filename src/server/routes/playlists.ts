import { type Context, Hono } from 'hono'
import {
  exportPlaylistToCsv,
  exportPlaylistToJson,
  exportPlaylistToM3u,
  exportPlaylistToXspf,
  type PlaylistExportFormat,
} from '@/core/playlists/export'
import type { GenerationResult } from '@/core/playlists/generator'
import type { PlaylistScheduler } from '@/core/playlists/scheduler'
import type { SweepLiveTracksResult } from '@/core/targets/plex-playlist'
import type { Database } from '@/db'
import { getPlaylistCollages } from '@/db/queries/playlist-collage'
import type { MissingTrackWithResolution } from '@/db/queries/playlist-missing-tracks'
import type {
  ImportedPlaylistWithOwner,
  PlaylistInsert,
  PlaylistRow,
  PlaylistTrackRow,
} from '@/db/queries/playlists'
import {
  createPlaylist,
  deletePlaylist,
  getImportedPlaylistsWithOwners,
  getPlaylistsByUser,
  getPlaylistWithTracks,
  updatePlaylist,
} from '@/db/queries/playlists'
import { getSettings } from '@/db/queries/settings'
import type { PlaylistConfig } from '@/db/schema'
import { notAuthenticated } from '@/server/helpers/auth-problems'
import { readPagination } from '@/server/helpers/pagination'
import { encodeCursor } from '@/server/helpers/pagination-cursor'
import { notFoundProblem, problem } from '@/server/helpers/problem'
import { requireAdmin } from '@/server/helpers/require-user'
import {
  adminSetPlaylistEnabledSchema,
  createPlaylistSchema,
  duplicatePlaylistSchema,
  missingTrackIdParamSchema,
  playlistExportFormatParamSchema,
  playlistIdParamSchema,
  playlistTrackAddSchema,
  previewAiPlaylistSchema,
  previewFilterCountQuerySchema,
  updatePlaylistSchema,
} from '@/server/schemas/playlists'
import { zJson, zParam, zQuery } from '@/server/schemas/validator'
import type { HonoEnv } from '@/server/types'

export type PlaylistDeps = {
  db: Database
  playlistScheduler: PlaylistScheduler
  runPlaylistGeneration: (playlistId: number) => Promise<void>
  // Activates a pending_review playlist by pushing its already-generated
  // tracks to Plex, without re-running the strategy. Returns false when the
  // owner has no usable Plex connection or the push itself failed.
  pushPendingReviewPlaylist: (playlistId: number) => Promise<boolean>
  restartPlaylistScheduler: () => Promise<void>
  generateAiPlaylistPreview: (
    userId: number,
    prompt: string,
    size: number,
    options?: {
      useListeningHistory?: boolean
      genreFilters?: string[]
      decadeFilters?: number[]
      excludeLiveVersions?: boolean
    },
  ) => Promise<GenerationResult>
  // Cheap "N albums match" live feedback as the user adjusts manual playlist
  // generation's filters -- no AI call, just the library-scoping stage.
  previewPlaylistFilterCount: (
    userId: number,
    filters: { genreFilters?: string[]; decadeFilters?: number[]; excludeLiveVersions?: boolean },
  ) => Promise<number>
  // "Duplicate to Plexamp": pushes a one-time snapshot of a playlist's
  // current tracks directly to Plex under a new name -- no DJ Llama row
  // created, so this is safe to call repeatedly.
  duplicatePlaylist: (
    playlistId: number,
    name?: string,
  ) => Promise<{ pushed: boolean; itemsAdded: number }>
  // On-demand cleanup: reads the playlist's actual current Plex items and
  // swaps only ones flagged as a live/acoustic/demo recording for a studio
  // version, without a full re-search of every track. No automatic schedule
  // -- see sweepLiveTracksInPlaylist in index.ts.
  sweepLiveTracks: (playlistId: number) => Promise<SweepLiveTracksResult>
  listMissingTracks: (playlistId: number) => Promise<MissingTrackWithResolution[]>
  deleteMissingTrack: (playlistId: number, id: number) => Promise<void>
  // Track-level editing (seasonal playlists): removals are remembered and
  // additions pinned across regenerations; a live Plex playlist is re-pushed.
  removePlaylistTrack: (playlistId: number, trackId: number) => Promise<boolean>
  addPlaylistTrack: (
    playlistId: number,
    track: { artistName: string; trackName: string; localPath?: string | null },
  ) => Promise<boolean>
  getPlaylistSuggestions: (
    playlistId: number,
  ) => Promise<Array<{ artistName: string; trackName: string; localPath: string; reason: string }>>
  getUserById: (id: number) => Promise<{ isAdmin: boolean } | null>
}

const PLAYLIST_EXPORT_CONTENT_TYPES: Record<PlaylistExportFormat, string> = {
  json: 'application/json',
  csv: 'text/csv',
  m3u: 'audio/x-mpegurl',
  xspf: 'application/xspf+xml',
}

const PLAYLIST_EXPORTERS: Record<
  PlaylistExportFormat,
  (args: { name: string; tracks: PlaylistTrackRow[] }) => string
> = {
  json: ({ tracks }) => exportPlaylistToJson(tracks),
  csv: ({ tracks }) => exportPlaylistToCsv(tracks),
  m3u: ({ tracks }) => exportPlaylistToM3u(tracks),
  xspf: ({ name, tracks }) => exportPlaylistToXspf(tracks, { title: name }),
}

function sanitizeFilename(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function playlistRoutes(deps: PlaylistDeps) {
  const router = new Hono<HonoEnv>()
  const { db } = deps

  const loadOwnedPlaylist = async (c: Context<HonoEnv>, id: number, userId: number) => {
    const result = await getPlaylistWithTracks(db, id)
    if (!result || result.playlist.userId !== userId) {
      return {
        ok: false as const,
        response: notFoundProblem(
          c,
          'playlist-not-found',
          'Playlist not found',
          'errors.playlist.notFound',
        ),
      }
    }
    return { ok: true as const, result }
  }

  // Must be registered before :id route.
  router.get('/api/v1/playlists/scheduler', async (c) => {
    const userId = c.get('userId')
    if (!userId) return notAuthenticated(c)

    const playlists = await getPlaylistsByUser(db, userId)
    const jobsByName = new Map(deps.playlistScheduler.listJobs().map((job) => [job.name, job]))
    const nextRuns = playlists
      .map((playlist) => jobsByName.get(`playlist-${playlist.id}`)?.nextRun ?? null)
      .filter((run): run is Date => run instanceof Date)
      .sort((a, b) => a.getTime() - b.getTime())
    const scheduledCrons = [
      ...new Set(
        playlists
          .map((playlist) => playlist.schedule)
          .filter((cron): cron is string => Boolean(cron)),
      ),
    ]

    // Per-user, not a global switch -- true if this user has at least one
    // enabled, scheduled playlist actually registered with the scheduler
    // (a row can be enabled+scheduled but still excluded, e.g. an ai_prompt
    // playlist while AI isn't configured -- see restartPlaylistScheduler).
    const enabled = playlists.some(
      (playlist) =>
        playlist.enabled && playlist.schedule && jobsByName.has(`playlist-${playlist.id}`),
    )

    return c.json({
      nextRun: nextRuns[0]?.toISOString() ?? null,
      cron: scheduledCrons.length === 1 ? scheduledCrons[0] : null,
      enabled,
    })
  })

  // Must be registered before :id route.
  // Runs the ai_prompt strategy without creating a playlist row or pushing
  // to Plex, so the user can see what an AI-generated playlist would
  // contain before committing to it.
  router.post('/api/v1/playlists/preview', zJson(previewAiPlaylistSchema), async (c) => {
    const userId = c.get('userId')
    if (!userId) return notAuthenticated(c)

    const settings = await getSettings(db)
    if (!settings?.aiProvider || !settings?.aiModel) {
      return problem(
        c,
        'ai-required',
        'AI provider required',
        400,
        'AI playlist generation needs an AI provider configured. Set one up in Settings.',
        undefined,
        'ai_required',
      )
    }

    const { prompt, size, useListeningHistory, genreFilters, decadeFilters, excludeLiveVersions } =
      c.req.valid('json')
    const generation = await deps.generateAiPlaylistPreview(userId, prompt, size ?? 25, {
      useListeningHistory,
      genreFilters,
      decadeFilters,
      excludeLiveVersions,
    })
    return c.json(generation)
  })

  // Must be registered before :id route. Cheap "N albums match" live
  // feedback for manual playlist generation's filters as the user adjusts
  // them -- no AI call.
  router.get(
    '/api/v1/playlists/preview-filter-count',
    zQuery(previewFilterCountQuerySchema),
    async (c) => {
      const userId = c.get('userId')
      if (!userId) return notAuthenticated(c)

      const { genres, decades, excludeLive } = c.req.valid('query')
      const count = await deps.previewPlaylistFilterCount(userId, {
        genreFilters: genres,
        decadeFilters: decades,
        excludeLiveVersions: excludeLive,
      })
      return c.json({ count })
    },
  )

  router.get('/api/v1/playlists', async (c) => {
    const userId = c.get('userId')
    if (!userId) return notAuthenticated(c)

    // Playlists without their own cover (everything but imports) get a 2x2
    // album collage built from their tracks instead.
    async function withCollages(rows: PlaylistRow[]) {
      const collages = await getPlaylistCollages(
        db,
        userId as number,
        rows.filter((r) => !r.coverUrl).map((r) => r.id),
      )
      return rows.map((r) => ({ ...r, collageUrls: collages.get(r.id) ?? [] }))
    }

    const page = readPagination(c)
    if (page === null) {
      const rows = await getPlaylistsByUser(db, userId)
      return c.json(await withCollages(rows))
    }
    const rows = await getPlaylistsByUser(db, userId, {
      limit: page.limit + 1,
      cursor: page.cursor,
    })
    const hasMore = rows.length > page.limit
    const data = hasMore ? rows.slice(0, page.limit) : rows
    const last = data[data.length - 1]
    const nextCursor =
      hasMore && last ? encodeCursor({ id: last.id, ts: last.createdAt.toISOString() }) : null
    return c.json({ data: await withCollages(data), meta: { limit: page.limit, nextCursor } })
  })

  router.post('/api/v1/playlists', zJson(createPlaylistSchema), async (c) => {
    const userId = c.get('userId')
    if (!userId) return notAuthenticated(c)

    const body = c.req.valid('json')
    const data: PlaylistInsert = {
      name: body.name,
      userId,
      strategy: body.strategy,
      targetIds: body.targetIds ?? [],
      schedule: body.schedule ?? null,
      config: (body.config ?? null) as PlaylistConfig | null,
      enabled: body.enabled ?? true,
      autoPushToPlex: body.autoPushToPlex,
      description: body.description,
      // The 'active' DB default means "generated and currently live," which
      // is wrong for a brand-new seasonal row -- tickSeasonalPlaylists reads
      // status === 'active' as "already generated this year" and would skip
      // it forever if a preset happens to be toggled on while already inside
      // its window. 'pending_review' is inert here (review-expiry only acts
      // on rows with a non-null reviewExpiresAt, which seasonal never sets).
      ...(body.strategy === 'seasonal' ? { status: 'pending_review' } : {}),
    }

    const row = await createPlaylist(db, data)
    await deps.restartPlaylistScheduler()
    return c.json(row, 201)
  })

  router.get('/api/v1/playlists/:id', zParam(playlistIdParamSchema), async (c) => {
    const userId = c.get('userId')
    if (!userId) return notAuthenticated(c)

    const { id } = c.req.valid('param')

    const loaded = await loadOwnedPlaylist(c, id, userId)
    if (!loaded.ok) return loaded.response

    return c.json(loaded.result)
  })

  router.get(
    '/api/v1/playlists/:id/export/:format',
    zParam(playlistExportFormatParamSchema),
    async (c) => {
      const userId = c.get('userId')
      if (!userId) return notAuthenticated(c)

      const { id, format } = c.req.valid('param')
      const exporter = PLAYLIST_EXPORTERS[format]
      const contentType = PLAYLIST_EXPORT_CONTENT_TYPES[format]

      const loaded = await loadOwnedPlaylist(c, id, userId)
      if (!loaded.ok) return loaded.response
      const result = loaded.result

      const tracks = result.tracks.slice().sort((a, b) => a.position - b.position)
      const filename = sanitizeFilename(result.playlist.name) || `playlist-${id}`
      const body = exporter({ name: result.playlist.name, tracks })

      return new Response(body, {
        headers: {
          'Content-Type': contentType,
          'Content-Disposition': `attachment; filename="${filename}.${format}"`,
        },
      })
    },
  )

  router.patch(
    '/api/v1/playlists/:id',
    zParam(playlistIdParamSchema),
    zJson(updatePlaylistSchema),
    async (c) => {
      const userId = c.get('userId')
      if (!userId) return notAuthenticated(c)

      const { id } = c.req.valid('param')
      const loaded = await loadOwnedPlaylist(c, id, userId)
      if (!loaded.ok) return loaded.response

      const body = c.req.valid('json')
      await updatePlaylist(db, id, body as Record<string, unknown>)
      await deps.restartPlaylistScheduler()
      return c.body(null, 204)
    },
  )

  router.delete('/api/v1/playlists/:id', zParam(playlistIdParamSchema), async (c) => {
    const userId = c.get('userId')
    if (!userId) return notAuthenticated(c)

    const { id } = c.req.valid('param')

    const loaded = await loadOwnedPlaylist(c, id, userId)
    if (!loaded.ok) return loaded.response

    await deletePlaylist(db, id)
    await deps.restartPlaylistScheduler()
    return c.body(null, 204)
  })

  router.post('/api/v1/playlists/:id/generate', zParam(playlistIdParamSchema), async (c) => {
    const userId = c.get('userId')
    if (!userId) return notAuthenticated(c)

    const { id } = c.req.valid('param')

    const loaded = await loadOwnedPlaylist(c, id, userId)
    if (!loaded.ok) return loaded.response

    // Fire-and-forget
    Promise.resolve()
      .then(() => deps.runPlaylistGeneration(id))
      .catch((err: unknown) => {
        console.error(`[playlists] Generation failed for playlist ${id}:`, err)
      })

    return c.json({ status: 'generating' }, 202)
  })

  // Activates a pending_review playlist
  // (manual auto-add-off review flow, or an ai_prompt draft) by pushing its
  // already-generated tracks to Plex. Rejecting is just DELETE /:id --
  // no separate reject route needed.
  router.post('/api/v1/playlists/:id/push', zParam(playlistIdParamSchema), async (c) => {
    const userId = c.get('userId')
    if (!userId) return notAuthenticated(c)

    const { id } = c.req.valid('param')

    const loaded = await loadOwnedPlaylist(c, id, userId)
    if (!loaded.ok) return loaded.response

    if (loaded.result.playlist.status !== 'pending_review') {
      return problem(
        c,
        'playlist-not-pending-review',
        'Playlist is not pending review',
        409,
        'This playlist has already been pushed or rejected.',
      )
    }

    const pushed = await deps.pushPendingReviewPlaylist(id)
    if (!pushed) {
      return problem(
        c,
        'playlist-push-failed',
        'Failed to push playlist',
        502,
        'Connect Plex in Settings first, or check server logs for details.',
      )
    }

    return c.body(null, 204)
  })

  // "Duplicate to Plexamp": pushes a
  // one-time snapshot of this playlist's current tracks directly to Plex
  // under a new name, so a rolling/auto-refreshed playlist can be kept around
  // even as the original keeps overwriting itself. No DJ Llama row is
  // created -- safe to call again, which just replaces the previous
  // same-named Plex snapshot rather than creating a duplicate of it.
  router.post(
    '/api/v1/playlists/:id/duplicate',
    zParam(playlistIdParamSchema),
    zJson(duplicatePlaylistSchema),
    async (c) => {
      const userId = c.get('userId')
      if (!userId) return notAuthenticated(c)

      const { id } = c.req.valid('param')
      const loaded = await loadOwnedPlaylist(c, id, userId)
      if (!loaded.ok) return loaded.response

      const { name } = c.req.valid('json')
      const result = await deps.duplicatePlaylist(id, name)
      return c.json(result, 200)
    },
  )

  // On-demand cleanup: reads
  // this playlist's actual current Plex items and swaps any flagged as a
  // live/acoustic/demo recording for a studio version, in place. Manual only
  // -- no automatic schedule (see PlaylistDeps.sweepLiveTracks).
  router.post(
    '/api/v1/playlists/:id/sweep-live-tracks',
    zParam(playlistIdParamSchema),
    async (c) => {
      const userId = c.get('userId')
      if (!userId) return notAuthenticated(c)

      const { id } = c.req.valid('param')
      const loaded = await loadOwnedPlaylist(c, id, userId)
      if (!loaded.ok) return loaded.response

      const result = await deps.sweepLiveTracks(id)
      if (!result.success) {
        return problem(
          c,
          'live-track-sweep-failed',
          'Failed to sweep live tracks',
          502,
          result.error,
        )
      }
      if (!result.playlistFound) {
        return problem(
          c,
          'live-track-sweep-no-plex-playlist',
          'Playlist not found on Plex',
          409,
          'This playlist has not been pushed to Plex yet.',
        )
      }
      return c.json(
        { checked: result.checked, replaced: result.replaced, stillLive: result.stillLive },
        200,
      )
    },
  )

  // Tracks from an imported
  // playlist that Plex couldn't match, kept live-reconciled on every re-sync
  // (see core/playlists/external-import.ts) instead of piling up as
  // duplicate recommendation rows.
  router.get('/api/v1/playlists/:id/missing-tracks', zParam(playlistIdParamSchema), async (c) => {
    const userId = c.get('userId')
    if (!userId) return notAuthenticated(c)

    const { id } = c.req.valid('param')
    const loaded = await loadOwnedPlaylist(c, id, userId)
    if (!loaded.ok) return loaded.response

    const tracks = await deps.listMissingTracks(id)
    return c.json(tracks)
  })

  // Manually clear one
  // entry (e.g. already handled outside the app). It reappears on the next
  // sync if the track is still actually unmatched -- this list always
  // reflects current state, not a to-do list.
  router.delete(
    '/api/v1/playlists/:id/missing-tracks/:trackId',
    zParam(missingTrackIdParamSchema),
    async (c) => {
      const userId = c.get('userId')
      if (!userId) return notAuthenticated(c)

      const { id, trackId } = c.req.valid('param')
      const loaded = await loadOwnedPlaylist(c, id, userId)
      if (!loaded.ok) return loaded.response

      await deps.deleteMissingTrack(id, trackId)
      return c.body(null, 204)
    },
  )

  router.delete(
    '/api/v1/playlists/:id/tracks/:trackId',
    zParam(missingTrackIdParamSchema),
    async (c) => {
      const userId = c.get('userId')
      if (!userId) return notAuthenticated(c)

      const { id, trackId } = c.req.valid('param')
      const loaded = await loadOwnedPlaylist(c, id, userId)
      if (!loaded.ok) return loaded.response

      const removed = await deps.removePlaylistTrack(id, trackId)
      if (!removed) {
        return notFoundProblem(c, 'track-not-found', 'Track not found', 'errors.playlist.notFound')
      }
      return c.body(null, 204)
    },
  )

  router.post(
    '/api/v1/playlists/:id/tracks',
    zParam(playlistIdParamSchema),
    zJson(playlistTrackAddSchema),
    async (c) => {
      const userId = c.get('userId')
      if (!userId) return notAuthenticated(c)

      const { id } = c.req.valid('param')
      const loaded = await loadOwnedPlaylist(c, id, userId)
      if (!loaded.ok) return loaded.response

      await deps.addPlaylistTrack(id, c.req.valid('json'))
      return c.body(null, 204)
    },
  )

  router.get('/api/v1/playlists/:id/suggestions', zParam(playlistIdParamSchema), async (c) => {
    const userId = c.get('userId')
    if (!userId) return notAuthenticated(c)

    const { id } = c.req.valid('param')
    const loaded = await loadOwnedPlaylist(c, id, userId)
    if (!loaded.ok) return loaded.response

    return c.json(await deps.getPlaylistSuggestions(id))
  })

  // Admin oversight: every OTHER
  // user's imported playlist, and who owns it (the admin's own imports are
  // excluded -- those already show in their personal Import a Playlist
  // section). Distinct path shape from /api/v1/playlists/:id (two segments
  // vs one) so there's no routing ambiguity with the param routes above.
  router.get('/api/v1/playlists/admin/imports', async (c) => {
    const auth = await requireAdmin(c, deps.getUserById)
    if (!auth.ok) return auth.response

    const rows: ImportedPlaylistWithOwner[] = await getImportedPlaylistsWithOwners(db, {
      excludeUserId: auth.userId,
    })
    return c.json(rows)
  })

  // Admin regenerate of any
  // user's imported playlist, bypassing the owner check /:id/generate enforces.
  router.post('/api/v1/playlists/admin/:id/generate', zParam(playlistIdParamSchema), async (c) => {
    const auth = await requireAdmin(c, deps.getUserById)
    if (!auth.ok) return auth.response

    const { id } = c.req.valid('param')
    const existing = await getPlaylistWithTracks(db, id)
    if (!existing) {
      return notFoundProblem(
        c,
        'playlist-not-found',
        'Playlist not found',
        'errors.playlist.notFound',
      )
    }

    Promise.resolve()
      .then(() => deps.runPlaylistGeneration(id))
      .catch((err: unknown) => {
        console.error(`[playlists] Admin-triggered generation failed for playlist ${id}:`, err)
      })

    return c.json({ status: 'generating' }, 202)
  })

  // Admin pause/resume of any user's imported playlist, so the owner can see
  // and fix a paused import from the All Users list. Imports only: other
  // strategies' schedules stay entirely the owning user's business.
  router.patch(
    '/api/v1/playlists/admin/:id',
    zParam(playlistIdParamSchema),
    zJson(adminSetPlaylistEnabledSchema),
    async (c) => {
      const auth = await requireAdmin(c, deps.getUserById)
      if (!auth.ok) return auth.response

      const { id } = c.req.valid('param')
      const existing = await getPlaylistWithTracks(db, id)
      if (existing?.playlist.strategy !== 'import') {
        return notFoundProblem(
          c,
          'playlist-not-found',
          'Playlist not found',
          'errors.playlist.notFound',
        )
      }

      const { enabled } = c.req.valid('json')
      await updatePlaylist(db, id, { enabled })
      await deps.restartPlaylistScheduler()
      return c.body(null, 204)
    },
  )

  router.delete('/api/v1/playlists/admin/:id', zParam(playlistIdParamSchema), async (c) => {
    const auth = await requireAdmin(c, deps.getUserById)
    if (!auth.ok) return auth.response

    const { id } = c.req.valid('param')
    const existing = await getPlaylistWithTracks(db, id)
    if (!existing) {
      return notFoundProblem(
        c,
        'playlist-not-found',
        'Playlist not found',
        'errors.playlist.notFound',
      )
    }

    await deletePlaylist(db, id)
    await deps.restartPlaylistScheduler()
    return c.body(null, 204)
  })

  return router
}

export type { PlaylistRow, PlaylistTrackRow }
