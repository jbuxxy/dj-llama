import { serve } from '@hono/node-server'
import { Cron } from 'croner'
import { and, eq, isNotNull, isNull, or } from 'drizzle-orm'
import { canAutoSetup, envConfig } from './config/env'
import { syncPlexServerUsers } from './core/auth/plex-user-sync'
import { getPlaylistTracks as getAppleMusicPlaylistTracks } from './core/clients/apple-music'
import { createDeezerClient } from './core/clients/deezer'
import { fetchDeezerPlaylistTracks } from './core/clients/deezer-playlist'
import {
  createLidarrClient,
  type LidarrAlbum,
  type LidarrAlbumLookupResult,
} from './core/clients/lidarr'
import { createMusicBrainzClient } from './core/clients/musicbrainz'
import { createPlexClient } from './core/clients/plex'
import { tryConsume } from './core/clients/rate-limiter'
import {
  getPlaylistTracks as getSpotifyPlaylistTracks,
  searchTracks as searchSpotifyTracks,
} from './core/clients/spotify'
import { getPlaylistTracks as getYoutubeMusicPlaylistTracks } from './core/clients/youtube-music'
import { decryptChannelSecrets, initEncryption, isEncryptionEnabled } from './core/crypto'
import { GenreService } from './core/genre/service'
import { startDigestNotifier } from './core/jobs/digest-notifier'
import { recordFailureSafely } from './core/jobs/record-failure-safely'
import { createJobRecorder } from './core/jobs/recorder'
import { startStuckDetector } from './core/jobs/stuck-detector'
import { createAlbumCoverageService } from './core/library/album-coverage'
import { LibraryHealthService } from './core/library/health'
import { startLibraryHealthScheduler } from './core/library/health-scheduler'
import {
  normalizeAlbumTitle,
  normalizeArtistName,
  normalizeTrackTitle,
} from './core/library/normalize'
import { reconcileFulfillment } from './core/library/reconcile-fulfillment'
import { startLibrarySyncScheduler } from './core/library/scheduler'
import { SkyHookWarmer } from './core/library/skyhook-warmer'
import { createLidarrLibrarySource } from './core/library/sources/lidarr'
import { createPlexLibrarySource } from './core/library/sources/plex'
import { createLibrarySyncStore } from './core/library/store'
import { createSyncOrchestrator, type SyncOrchestrator } from './core/library/sync'
import { markShuttingDown } from './core/lifecycle'
import { dispatch } from './core/notifications'
import { CronScheduler } from './core/ops/cron-scheduler'
import { isMaintenance, setMaintenance } from './core/ops/maintenance'
import { runPreFlightCheck } from './core/ops/upgrade'
import { runArtistImageBackfill, waitForImageBackfill } from './core/pipeline/artist-image-backfill'
import {
  collectLikedTracks,
  collectRecentlyAdded,
  collectRecentPlays,
} from './core/pipeline/collect-tracks'
import { findGapFillCandidates } from './core/pipeline/gap-fill'
import { waitForGenreWarmers } from './core/pipeline/genre-backfill'
import { PipelineOrchestrator } from './core/pipeline/orchestrator'
import { originalReleaseTier, pickBestReleaseGroup } from './core/pipeline/resolve'
import type { StoreDb } from './core/pipeline/store'
import { buildTrackTasteProfile } from './core/pipeline/track-taste'
import { type ExternalTrack, importExternalPlaylistToPlex } from './core/playlists/external-import'
import { generatePlaylist } from './core/playlists/generator'
import { filterLibraryAlbums } from './core/playlists/library-filter'
import { tickReviewExpiry as runReviewExpiryTick } from './core/playlists/review-expiry-tick'
import { PlaylistScheduler } from './core/playlists/scheduler'
import { seasonalTrackKey } from './core/playlists/seasonal-generator'
import { getSeasonalPreset, isWithinSeasonalWindow } from './core/playlists/seasonal-presets'
import { tickSeasonalPlaylists as runSeasonalTick } from './core/playlists/seasonal-tick'
import { buildStrategyDeps } from './core/playlists/strategy-deps'
import type { ResolvedTrack } from './core/playlists/types'
import { createPlexSource } from './core/plugins/plex'
import { SourceRegistry } from './core/plugins/registry'
import { buildAlbumResolutionPrompt, buildTasteProfilePrompt } from './core/providers/prompt'
import { createDefaultRegistry } from './core/providers/registry'
import { realtimeBroker } from './core/realtime/broker'
import { searchTrackAlbums } from './core/search/track-albums'
import { setSessionStore } from './core/sessions'
import { createLidarrTarget } from './core/targets/lidarr'
import {
  normalize as normalizeForMatch,
  stripSearchQualifier,
  stripTrailingParenthetical,
} from './core/targets/playlist-match'
import {
  createPlexPlaylistTarget,
  type SweepLiveTracksResult,
  sweepPlaylistLiveTracks,
} from './core/targets/plex-playlist'
import { errMsg } from './core/validation'
import { closeDb, db, pool } from './db'
import { runMigrations } from './db/migrate'
import {
  getBlockedAlbumKeys,
  listAlbumBlocks as listAlbumBlocksQuery,
  removeAlbumBlock as removeAlbumBlockQuery,
} from './db/queries/album-blocks'
import {
  addBlock as addArtistBlockQuery,
  getBlockedMbids as getBlockedArtistMbids,
  listBlocks as listArtistBlocksQuery,
  removeBlock as removeArtistBlockQuery,
} from './db/queries/artist-blocks'
import { getPopularityMap, lookupByName } from './db/queries/artist-metadata'
import {
  getArtistById,
  getArtistGenreCacheByAliases,
  getArtistGenreCacheByMbids,
  upsertArtist,
  upsertArtistGenreAlias,
  upsertArtistGenres,
} from './db/queries/artists'
import { completeBatch, failBatch, getBatch, listBatches } from './db/queries/batches'
import {
  getArtistGenresByNames,
  getLatestGenreCoverage,
  getRecentActivity,
} from './db/queries/dashboard'
import { getArtistsForGapFill, markArtistsGapChecked } from './db/queries/gap-fill'
import {
  getAllGenres,
  getChildGenres,
  getGenreBySlug,
  searchGenres,
  upsertGenre,
} from './db/queries/genres'
import * as jobQueries from './db/queries/jobs'
import {
  getLibraryHealthState,
  markLibraryHealthScanStarted,
  saveLibraryHealthState,
} from './db/queries/library-health'
import { getCachedLidarrIds } from './db/queries/lidarr-cache'
import {
  deletePlaylistMissingTrack,
  fillMissingTrackCovers,
  listPlaylistMissingTracks,
  type MissingTrackWithResolution,
  reconcilePlaylistMissingTracks,
} from './db/queries/playlist-missing-tracks'
import {
  deletePlaylist,
  getEnabledPlaylists,
  getExpiredReviewPlaylists,
  getImportedPlaylistsWithOwners,
  getPlaylistsByUser,
  getPlaylistWithTracks,
  type PlaylistRow,
  type PlaylistTrackRow,
  replacePlaylistTracks,
  updatePlaylist as updatePlaylistRow,
} from './db/queries/playlists'
import { getRecentPlexScrobbles } from './db/queries/plex-scrobbles'
import {
  bulkDelete,
  bulkUpdateStatus,
  filterOwnedIds,
  getExistingAlbumReleaseGroupMbids,
  getGenreFeedbackHistory,
  getRecommendation,
  getRejectedArtistMbids,
  insertRecommendation,
  listRecommendations,
  rejectRecommendation,
  updateRecommendationStatus,
} from './db/queries/recommendations'
import {
  createRequest,
  findRequestForAlbum,
  listRequestsForUser,
  resolveRequest,
  toRequestHistoryEntries,
} from './db/queries/requests'
import { getLastSignInByUser, sessionQueries } from './db/queries/sessions'
import type { SetupConfig } from './db/queries/settings'
import { completeSetup, getSettings, isSetupComplete, updateSettings } from './db/queries/settings'
import { getSystemTarget, upsertSystemTarget } from './db/queries/targets'
import {
  getCachedTrackAlbumResolutions,
  setCachedTrackAlbumResolution,
  trackAlbumCacheKey,
} from './db/queries/track-album-resolution-cache'
import {
  createUser,
  deleteUser,
  getUserById,
  getUserByUsername,
  getUserConnections,
  getUserCount,
  listUsers,
  updateTasteProfileCache,
  updateUser,
} from './db/queries/users'
import {
  artists,
  DEFAULT_PREFERENCES,
  libraryArtists,
  mergePreferences,
  type PlaylistConfig,
  recommendationBatches,
  recommendations,
  type TasteProfileCache,
} from './db/schema'
import { waitForDatabase } from './db/wait'
import { type AppDependencies, createApp } from './server'
import { buildPipelineRun } from './server/helpers/pipeline-run'
import { resolveUserPreferences } from './server/helpers/preferences'
import { approveAlbumToTargets } from './server/routes/recommendations'

// Job recording - initialized after DB setup, before createApp()
let jobRecorder: import('./core/jobs/types').JobRecorder

// Initialize encryption before any DB operations.
initEncryption(envConfig.encryptionKey, envConfig.encryptionKeyNext)
if (isEncryptionEnabled()) {
  if (envConfig.encryptionKeyNext) {
    console.log('Field-level encryption enabled (dual-key rotation mode)')
  } else {
    console.log('Field-level encryption enabled')
  }
} else if (process.env.NODE_ENV === 'production') {
  console.warn(
    'WARNING: DJLLAMA_ENCRYPTION_KEY is not set - API keys and tokens are stored as plaintext in the database. Set this variable for production security.',
  )
} else {
  console.log('Field-level encryption disabled (set DJLLAMA_ENCRYPTION_KEY to enable)')
}

// Wait for Postgres to accept connections before any DB operation. A
// slow-starting Postgres (still in recovery) rejects with SQLSTATE 57P03;
// without this guard the first query rejects and kills the process,
// crash-looping the pod on kubelet until PG finishes recovery.
// PGlite is in-process (no pool); only Postgres needs to wait for a socket.
if (pool) await waitForDatabase(pool)

// Pre-flight check: detect pending migrations and auto-backup if needed.
await runPreFlightCheck(db)

// Run pending database migrations before anything else.
// Idempotent; selects the migrator matching the active backend.
await runMigrations()
console.log('Database migrations applied')

// Wire up DB-backed session store after migrations are applied.
setSessionStore(sessionQueries(db))

// Read library sync interval once; used by both the orchestrator's stale
// check and the background scheduler. Runtime changes require a restart.
const bootSettings = await getSettings(db)
const librarySyncIntervalHours = bootSettings?.librarySyncIntervalHours ?? 6

const librarySyncStore = createLibrarySyncStore(db)

const storeDb: StoreDb = {
  getExistingAlbumReleaseGroupMbids: (userId) => getExistingAlbumReleaseGroupMbids(db, userId),
  getBlockedAlbumKeys: (userId) => getBlockedAlbumKeys(db, userId),
  getArtistGenreCacheByMbids: (mbids) => getArtistGenreCacheByMbids(db, mbids),
  getArtistGenreCacheByAliases: (aliases) => getArtistGenreCacheByAliases(db, aliases),
  upsertArtistGenres: (data) => upsertArtistGenres(db, data),
  upsertArtistGenreAlias: (data) => upsertArtistGenreAlias(db, data),
  getExistingRecommendationMbids: async (userId) => {
    const base = db
      .select({ mbid: artists.mbid })
      .from(recommendations)
      .innerJoin(artists, eq(recommendations.artistId, artists.id))
    const rows =
      userId !== undefined
        ? await base.where(or(eq(recommendations.userId, userId), isNull(recommendations.userId)))
        : await base
    return new Set(rows.map((r) => r.mbid))
  },
  insertBatch: async (data) => {
    const rows = await db
      .insert(recommendationBatches)
      .values({
        status: data.status,
        stats: data.stats,
      })
      .returning({ id: recommendationBatches.id })
    const row = rows[0]
    if (!row) throw new Error('insertBatch: no row returned')
    return row
  },
  completeBatch: async (id, stats) => {
    await completeBatch(db, id, { ...stats, filtered: 0 })
  },
  failBatch: async (id) => {
    await failBatch(db, id)
  },
  upsertArtist: async (data) => {
    const row = await upsertArtist(db, data)
    return { id: row.id }
  },
  insertRecommendation: (data) => insertRecommendation(db, data),
  // Atomic pair: prevents orphaned artist rows when the followup insert fails
  upsertArtistAndRecommendation: async (artistData, recData) => {
    await db.transaction(async (tx) => {
      const row = await upsertArtist(tx, artistData)
      await insertRecommendation(tx, { ...recData, artistId: row.id })
    })
  },
  getRejectedMbids: (cooldownDays) => getRejectedArtistMbids(db, cooldownDays),
  getBlockedMbids: (userId) => getBlockedArtistMbids(db, userId),
  getFeedbackHistory: (userId) => getGenreFeedbackHistory(db, userId),
  lookupArtistMetadata: (name) => lookupByName(db, name),
  getPopularityMap: () => getPopularityMap(db),
  getLibraryArtistsForUser: async (userId, options) => {
    const conds = [or(eq(libraryArtists.userId, userId), isNull(libraryArtists.userId))]
    if (options?.onlyReconciled) conds.push(isNotNull(libraryArtists.mbid))
    if (options?.source) conds.push(eq(libraryArtists.source, options.source))
    return db
      .select({
        mbid: libraryArtists.mbid,
        name: libraryArtists.name,
        source: libraryArtists.source,
        sourceArtistId: libraryArtists.sourceArtistId,
        genres: libraryArtists.genres,
        matchMethod: libraryArtists.matchMethod,
        matchConfidence: libraryArtists.matchConfidence,
      })
      .from(libraryArtists)
      .where(and(...conds.filter((c): c is NonNullable<typeof c> => c !== undefined)))
  },
  userHasOwnSyncState: (userId) => librarySyncStore.userHasOwnSyncState(userId),
  tryConsumeRateLimit: (key, config) => tryConsume(db, key, config),
  getRequestHistoryForUser: async (userId, limit) => {
    const { items } = await listRequestsForUser(db, userId, { limit })
    return toRequestHistoryEntries(items)
  },
  getGapFillCandidates: (userId, maxArtists) =>
    findGapFillCandidates(
      {
        getArtistsForGapFill: (_db, uid, limit) => getArtistsForGapFill(db, uid, limit),
        markArtistsGapChecked: (_db, ids) => markArtistsGapChecked(db, ids),
        getCoverageForArtist: (uid, artistMbid) =>
          albumCoverage.getCoverageForArtist(uid, artistMbid),
      },
      userId,
      maxArtists,
    ),
  getRecentPlexScrobbles: (userId, limit) => getRecentPlexScrobbles(db, userId, limit),
}

jobRecorder = createJobRecorder(db)
jobRecorder
  .markInterrupted()
  .then((n) => n > 0 && console.log(`[startup] Marked ${n} job(s) interrupted by the restart`))
  .catch((err) => console.error('[startup] Marking interrupted jobs failed:', err))
// Reset any library_sync_state rows left in 'running' from a previous crash/restart.
// The orchestrator never finishes those, so the UI would show a permanent "running" badge.
librarySyncStore
  .clearRunningSyncStates()
  .then((n) => {
    if (n > 0) console.warn(`[startup] Cleared ${n} stale 'running' library sync state(s)`)
  })
  .catch((err) => console.error('[startup] Library sync state sweep failed:', err))

const orchestrator = new PipelineOrchestrator()
const scheduler = new CronScheduler('[scheduler]')
const playlistScheduler = new PlaylistScheduler()

const providerRegistry = createDefaultRegistry()

// Map DB genre rows (artistCount: number | null) to GenreInfo (artistCount: number)
function mapGenreRow(row: Awaited<ReturnType<typeof upsertGenre>>) {
  return { ...row, artistCount: row.artistCount ?? 0 }
}

const genreService = new GenreService({
  genreQueries: {
    upsertGenre: async (data) => mapGenreRow(await upsertGenre(db, data)),
    getGenreBySlug: async (slug) => {
      const row = await getGenreBySlug(db, slug)
      return row ? mapGenreRow(row) : null
    },
    getChildGenres: async (parentId) => {
      const rows = await getChildGenres(db, parentId)
      return rows.map(mapGenreRow)
    },
    searchGenres: async (query, limit) => {
      const rows = await searchGenres(db, query, limit)
      return rows.map(mapGenreRow)
    },
    getAllGenres: async () => {
      const rows = await getAllGenres(db)
      return rows.map(mapGenreRow)
    },
  },
})

// LibraryHealthService uses a lazy Lidarr client that reads current settings per call.
// This avoids the chicken-and-egg problem of needing settings at construction time.
function makeLazyLidarrClient() {
  async function getClient() {
    const s = await getSettings(db)
    if (s?.lidarrUrl && s?.lidarrApiKey) {
      return createLidarrClient(s.lidarrUrl, s.lidarrApiKey, s.skipTlsVerify ?? false)
    }
    return null
  }

  return {
    getArtists: async () => (await getClient())?.getArtists() ?? [],
    getAlbums: async (artistId: number) => (await getClient())?.getAlbums(artistId) ?? [],
    lookupArtist: async (term: string) => (await getClient())?.lookupArtist(term) ?? [],
    setArtistsMonitored: async (artistIds: number[], monitored: boolean) => {
      const client = await getClient()
      if (!client) throw new Error('Lidarr not configured')
      return client.setArtistsMonitored(artistIds, monitored)
    },
    triggerCommand: async (name: string, body?: Record<string, unknown>) => {
      const client = await getClient()
      if (!client) throw new Error('Lidarr not configured')
      return client.triggerCommand(name, body)
    },
    getRootFolders: async () => (await getClient())?.getRootFolders() ?? [],
  }
}

const lazyLidarrClient = makeLazyLidarrClient()

const libraryHealth = new LibraryHealthService({
  lidarrClient: lazyLidarrClient,
  artistCache: {
    getAll: async () => db.select({ mbid: artists.mbid, genres: artists.genres }).from(artists),
  },
  stateStore: {
    get: () => getLibraryHealthState(db),
    markScanStarted: () => markLibraryHealthScanStarted(db),
    save: ({ checks, lastCompletedAt, lastError }) =>
      saveLibraryHealthState(db, { checks, lastCompletedAt, lastError }),
  },
})

const skyhookWarmer = new SkyHookWarmer({ lookupArtist: lazyLidarrClient.lookupArtist })

// ---------------------------------------------------------------------------
// Library sync orchestrator + per-source factories
// ---------------------------------------------------------------------------

async function buildPerUserLibrarySources(userId: number) {
  const conns = await getUserConnections(db, userId)
  if (!conns) return []
  const sources = []
  if (conns.plexUrl && conns.plexToken) {
    sources.push(
      createPlexLibrarySource(
        createPlexClient(conns.plexUrl, conns.plexToken, { sectionId: conns.plexSectionId }),
        userId,
      ),
    )
  }
  return sources
}

async function buildGlobalLibrarySources() {
  const s = await getSettings(db)
  if (s?.lidarrUrl && s?.lidarrApiKey) {
    return [
      createLidarrLibrarySource(
        createLidarrClient(s.lidarrUrl, s.lidarrApiKey, s.skipTlsVerify ?? false),
      ),
    ]
  }
  return []
}

const librarySyncOrchestrator: SyncOrchestrator = createSyncOrchestrator({
  store: librarySyncStore,
  recorder: jobRecorder,
  mbClient: createMusicBrainzClient(),
  buildPerUserSources: buildPerUserLibrarySources,
  buildGlobalSources: buildGlobalLibrarySources,
  staleHours: librarySyncIntervalHours,
})

const albumCoverage = createAlbumCoverageService({
  store: librarySyncStore,
  mbClient: createMusicBrainzClient(),
})

// Coalesces Plex library.new events into as few forced resyncs as possible:
// one album import fires the webhook once per track, and Lidarr imports a
// batch of albums minutes apart. Events wait for a quiet minute, and any that
// arrive while a resync is already running fold into a single follow-up run
// instead of each starting another full round. The library is shared:
// every user sees the same Plex server, plus the Lidarr-global source, so a
// new album must flip to "In Library" for everyone, not just the account that
// owns the Plex server (which is the only one Plex sends library.new for).
// So: resync the global source and every user's sources, reconcile every
// user's requests/recommendations, and broadcast right away -- before the
// slower imported-playlist re-syncs, which can now queue behind Lidarr's
// add throttle for a long time.
const LIBRARY_WEBHOOK_DEBOUNCE_MS = 60_000
let libraryWebhookTimer: ReturnType<typeof setTimeout> | null = null
let libraryWebhookRunning = false
let libraryWebhookPending = false

function handleLibraryWebhookEvent(_userId: number): void {
  if (libraryWebhookTimer) clearTimeout(libraryWebhookTimer)
  libraryWebhookTimer = setTimeout(() => {
    libraryWebhookTimer = null
    void runLibraryWebhookRefresh()
  }, LIBRARY_WEBHOOK_DEBOUNCE_MS)
  libraryWebhookTimer.unref?.()
}

async function runLibraryWebhookRefresh(): Promise<void> {
  if (libraryWebhookRunning) {
    libraryWebhookPending = true
    return
  }
  libraryWebhookRunning = true
  try {
    await (async () => {
      const users = await listUsers(db)
      await librarySyncOrchestrator
        .syncGlobal({ force: true })
        .catch((err) => console.error('[library-webhook] Global library sync failed:', err))

      for (const user of users) {
        try {
          await librarySyncOrchestrator.syncForUser(user.id, { force: true })
          const { confirmedRequestIds, confirmedRecommendationIds, autoRejectedRecommendationIds } =
            await reconcileFulfillment(db, user.id)
          if (
            confirmedRequestIds.length > 0 ||
            confirmedRecommendationIds.length > 0 ||
            autoRejectedRecommendationIds.length > 0
          ) {
            console.log(
              `[library-webhook] user ${user.id}: confirmed ${confirmedRequestIds.length} request(s), ${confirmedRecommendationIds.length} recommendation(s), auto-rejected ${autoRejectedRecommendationIds.length} already-owned pending recommendation(s)`,
            )
          }
          realtimeBroker.publish(user.id, { type: 'library-updated' })
        } catch (err) {
          console.error(`[library-webhook] Reconciliation failed for user ${user.id}:`, err)
        }
      }

      // New library media can also resolve an imported playlist's own
      // missing-tracks list -- re-run every enabled imported playlist through
      // the same path the Generate button uses. Best-effort per playlist so
      // one bad import doesn't block the rest.
      for (const user of users) {
        const userPlaylists = await getPlaylistsByUser(db, user.id)
        const importedPlaylists = userPlaylists.filter((p) => p.strategy === 'import' && p.enabled)
        for (const p of importedPlaylists) {
          try {
            await executePlaylistGeneration(p.id)
          } catch (err) {
            console.error(`[library-webhook] Re-sync failed for playlist ${p.id}:`, err)
          }
        }
      }
    })()
  } catch (err) {
    console.error('[library-webhook] Library refresh failed:', err)
  } finally {
    libraryWebhookRunning = false
    if (libraryWebhookPending) {
      libraryWebhookPending = false
      void runLibraryWebhookRefresh()
    }
  }
}

// Cron-triggered discovery runs for the admin account, set up exactly like the
// "Run scan" button (see buildPipelineRun).
const runPipeline = async () => {
  const currentSettings = await getSettings(db)
  if (!currentSettings?.aiProvider || !currentSettings.aiModel) {
    console.log('[scheduler] Skipping scheduled discovery: no AI provider configured')
    return
  }
  const allUsers = await listUsers(db)
  const admin = allUsers.find((u) => u.isAdmin) ?? allUsers[0]
  if (!admin) return
  const run = await buildPipelineRun(appDeps, admin.id, 'scheduled')
  if (run) orchestrator.enqueue(run)
}

// createLidarrTarget()'s underlying client caches Lidarr's quality/metadata
// profiles and root folders in memory (see clients/lidarr.ts), but that
// cache only lives as long as the client instance -- and a fresh instance
// was being built on every single call to getEnabledTargetsForResolvedUser
// (i.e. every approve), throwing the cache away immediately after it was
// populated. A 50-item Approve All was refetching those 3 endpoints ~50
// times over instead of once. Memoize the target across calls, keyed by the
// exact config that went into building it -- any settings change (a new
// API key, a different default quality profile, etc.) produces a different
// key and transparently rebuilds a fresh target+client on next use.
//
// That key only covers changes made through DJ Llama's own settings, though
// -- renaming/deleting a quality profile or adding a root folder directly in
// Lidarr's UI doesn't touch this app's config at all, so it wouldn't be
// noticed. A generous TTL bounds how long the cached profile/folder list can
// stay stale from that kind of out-of-band change, without undoing the
// point of caching by refetching constantly.
const LIDARR_TARGET_CACHE_TTL_MS = 24 * 60 * 60 * 1000
let cachedLidarrTarget: {
  key: string
  builtAt: number
  target: import('./core/targets/types').DestinationTarget
} | null = null

function getCachedOrFreshLidarrTarget(
  lidarrRow: NonNullable<Awaited<ReturnType<typeof getSystemTarget>>>,
  prefs: Record<string, unknown>,
): import('./core/targets/types').DestinationTarget {
  const config = {
    id: lidarrRow.id,
    url: lidarrRow.config.url as string,
    apiKey: lidarrRow.config.apiKey as string,
    skipTlsVerify: (lidarrRow.config.skipTlsVerify as boolean) ?? false,
    qualityProfileId: Number(prefs.qualityProfileId ?? 1),
    metadataProfileId: Number(prefs.metadataProfileId ?? 1),
    rootFolderId: prefs.rootFolderId != null ? Number(prefs.rootFolderId) : undefined,
  }
  const key = JSON.stringify(config)
  const isFresh =
    cachedLidarrTarget?.key === key &&
    Date.now() - cachedLidarrTarget.builtAt < LIDARR_TARGET_CACHE_TTL_MS
  if (isFresh && cachedLidarrTarget) {
    return cachedLidarrTarget.target
  }

  const target = createLidarrTarget(config.id, {
    ...config,
    lookupCachedIds: (artistMbid, albumMbid) => getCachedLidarrIds(db, artistMbid, albumMbid),
  })
  cachedLidarrTarget = { key, builtAt: Date.now(), target }
  return target
}

// Lidarr is a global, admin-configured connection (settings), not a
// per-user manual target -- every user gets the SAME target here, via
// the system target row (see db/queries/targets.ts). The userId parameter
// is kept only so callers (recommendation-approve, auto-approve) don't need
// to change; nothing here is actually scoped by it anymore.
async function getEnabledTargetsForResolvedUser(
  _userId: number,
): Promise<import('./core/targets/types').DestinationTarget[]> {
  const settings = await getSettings(db)
  const prefs = (settings?.preferences ?? {}) as Record<string, unknown>

  const targets: import('./core/targets/types').DestinationTarget[] = []

  const lidarrRow = await getSystemTarget(db, 'lidarr')
  if (lidarrRow?.enabled) {
    targets.push(getCachedOrFreshLidarrTarget(lidarrRow, prefs))
  }

  return targets
}

async function buildPlaylistResolverDeps(userId: number | null) {
  const mbClient = createMusicBrainzClient()
  const deezerClient = createDeezerClient()
  const resolverDeps: import('./core/playlists/types').TrackResolverDeps = {
    musicbrainzRecordings: (artistMbid) => mbClient.getRecordings(artistMbid),
    deezerSearch: (query, limit = 10) => deezerClient.searchTracks(query, limit),
    // Catalog search needs no per-user connection at all (see
    // core/clients/spotify.ts) -- always available, unlike the old
    // OAuth-token-gated version.
    spotifySearch: (query, limit = 10) => searchSpotifyTracks(query, limit),
  }

  if (userId != null) {
    const conns = await getUserConnections(db, userId)
    if (conns?.plexUrl && conns.plexToken) {
      const plexClient = createPlexClient(conns.plexUrl, conns.plexToken, {
        sectionId: conns.plexSectionId,
      })
      // "local" here means the user's own Plex library, not a public catalog
      // -- this is what guarantees playlist tracks are actually owned.
      resolverDeps.plexSearch = (artistName) => plexClient.getTracksForArtist(artistName)
      resolverDeps.plexTitleSearch = (query) => plexClient.searchTracksByTitle(query)
    }
  }

  return resolverDeps
}

// Runs the same generation pipeline as a saved playlist but skips the DB
// write and Plex push -- lets the ai_prompt strategy be tried out before the
// user commits to creating (and, if scheduled, recurring) a real playlist.
async function generateAiPlaylistPreview(
  userId: number,
  prompt: string,
  size: number,
  options?: {
    useListeningHistory?: boolean
    genreFilters?: string[]
    decadeFilters?: number[]
    excludeLiveVersions?: boolean
  },
) {
  const strategyDeps = buildStrategyDeps(db, userId, providerRegistry)
  const resolverDeps = await buildPlaylistResolverDeps(userId)
  return generatePlaylist(
    'ai_prompt',
    {
      size,
      prompt,
      useListeningHistory: options?.useListeningHistory,
      genreFilters: options?.genreFilters,
      decadeFilters: options?.decadeFilters,
      excludeLiveVersions: options?.excludeLiveVersions,
      trackSourcePriority: ['local', 'spotify', 'deezer'],
    },
    strategyDeps,
    resolverDeps,
  )
}

// Cheap preview for mediasage-style live filter feedback ("N albums match")
// as the user adjusts genre/decade/live-exclusion filters -- no AI call, just
// the deterministic library-scoping stage of selectAlbumsWithAi.
async function previewPlaylistFilterCount(
  userId: number,
  filters: { genreFilters?: string[]; decadeFilters?: number[]; excludeLiveVersions?: boolean },
): Promise<number> {
  const candidates = await filterLibraryAlbums(db, {
    userId,
    genres: filters.genreFilters,
    decades: filters.decadeFilters,
    excludeLive: filters.excludeLiveVersions,
    limit: 1000,
  })
  return candidates.length
}

// Missing playlist tracks get auto-requested album-by-album (not per-track
// -- several missing songs off the same album collapse into one request)
// through the exact same trust rules as a manual request: admin/owner/
// auto-approve-trusted users dispatch immediately, everyone else lands in
// the admin approval queue. Skips anything without an album title (can't
// request a bare track) and anything already pending/dispatched for this
// user so re-syncing a still-missing album doesn't pile up duplicates.
// Batches every still-unresolved track from one sync into a single AI call
// (see buildAlbumResolutionPrompt) rather than one request per track --
// keeps the cost/latency bounded regardless of how many misses a playlist
// has. Returns a Map keyed by trackAlbumCacheKey so callers can look up an
// individual track's suggested album, or an empty Map if AI isn't
// configured or the call fails for any reason -- this is a best-effort
// enrichment, never something a sync should fail over.
async function resolveAlbumsWithAi(
  tracks: Array<{ artistName: string; trackName: string }>,
  settings: {
    aiProvider: string | null
    aiModel: string | null
    aiApiKey: string | null
    aiBaseUrl: string | null
  },
): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  if (!settings.aiProvider || !settings.aiModel || tracks.length === 0) return result
  try {
    const provider = await providerRegistry.create(settings.aiProvider, {
      apiKey: settings.aiApiKey ?? null,
      model: settings.aiModel,
      baseUrl: settings.aiBaseUrl ?? null,
      timeoutSeconds: envConfig.aiTimeoutSeconds ?? null,
    })
    const recs = await provider.getRecommendations({
      topArtists: [],
      topGenres: [],
      listeningPatterns: { totalListens: 0, recentTrend: 'stable' },
      _rawPrompt: buildAlbumResolutionPrompt(tracks),
    })
    for (const rec of recs) {
      if (!rec.trackName || !rec.suggestedAlbum) continue
      result.set(trackAlbumCacheKey(rec.artistName, rec.trackName), rec.suggestedAlbum)
    }
  } catch (err) {
    console.warn('[playlist-import] AI album resolution failed:', errMsg(err))
  }
  return result
}

// Verifies a resolved album target actually contains the song being
// searched for, not just that Lidarr has an album by that name for the
// artist. Confirmed live (2026-08): Rufus "Ain't Nobody" resolved to the
// real Lidarr album "Numbers" for that artist -- exists, verified,
// dispatched, downloaded -- but "Numbers" only has the similarly-titled
// "Ain't Nobody Like You", a different song; the real hit is on "Masterjam".
// Same for Tina Turner "What's Love Got to Do with It" resolving to "Break
// Every Rule" instead of "Private Dancer". Both slipped through the existing
// verification because it only checked the album existed in the artist's
// catalog, never that the track was actually on it.
async function albumHasTrack(
  lidarr: ReturnType<typeof createLidarrClient>,
  albumId: number,
  trackName: string,
): Promise<boolean> {
  const tracks = await lidarr.getTracks(albumId).catch(() => [])
  const normalizedTarget = normalizeTrackTitle(trackName)
  return tracks.some((t) => normalizeTrackTitle(t.title) === normalizedTarget)
}

// Before requesting a *different* album for a "missing" track, check whether
// the artist's existing Lidarr catalog already has a downloaded file for the
// plain song -- on any album, not just the one the source playlist tagged or
// the one resolution would pick. Confirmed live (2026-08): three separate
// "missing" tracks (Taylor Dayne "Tell It to My Heart", Huey Lewis "The
// Power of Love", Eurythmics "Sweet Dreams (Are Made of This)") were already
// fully downloaded in Lidarr -- the real gap was Plex's library scan being
// stale, not a missing acquisition. Requesting again in that situation would
// just pile a redundant/wrong-edition download on top of a file already on
// disk.
// Deliberately stricter than albumHasTrack: uses normalizeForMatch (keeps
// parenthetical content) rather than normalizeTrackTitle (strips it), and
// requires hasFile -- an album can list "Song (Remix)"/"Song (Instrumental)"
// as tracks in its metadata without ever having downloaded the plain
// version, and a normalizeTrackTitle-style paren-stripped compare would
// wrongly treat those as "already have it" (confirmed live: Miami Sound
// Machine's downloaded "Conga!" single is exactly this -- two remix-only
// files, no plain "Conga").
// Also checks a second, generic-parenthetical-stripped form of the *source*
// trackName only (never the Lidarr file's own title) -- confirmed live,
// 2026-08: Daryl Hall & John Oates "You Make My Dreams (Come True)" was
// already downloaded on "Voices" under Lidarr's plain "You Make My Dreams"
// tag, but the strict compare missed it since the source's "(Come True)"
// isn't a recognized stripSearchQualifier keyword. Only stripping the
// source side (never the file side) preserves the remix/instrumental
// rejection above: a file's own extra parenthetical still disqualifies it.
async function findExistingTrackFile(
  lidarr: ReturnType<typeof createLidarrClient>,
  lidarrArtistId: number,
  trackName: string,
): Promise<boolean> {
  const stripped = stripSearchQualifier(trackName)
  const target = normalizeForMatch(stripped)
  const genericStripped = stripTrailingParenthetical(stripped)
  const targetGeneric = genericStripped !== stripped ? normalizeForMatch(genericStripped) : null
  const albums = await lidarr.getAlbums(lidarrArtistId).catch(() => [])
  for (const album of albums) {
    if (!album.statistics?.trackFileCount) continue
    const tracks = await lidarr.getTracks(album.id).catch(() => [])
    if (
      tracks.some((t) => {
        if (!t.hasFile) return false
        const normalizedTitle = normalizeForMatch(t.title)
        return (
          normalizedTitle === target ||
          (targetGeneric !== null && normalizedTitle === targetGeneric)
        )
      })
    ) {
      return true
    }
  }
  return false
}

async function autoRequestMissingPlaylistTracks(
  ownerId: number,
  playlistId: number,
): Promise<void> {
  const settings = await getSettings(db)
  if (!settings?.lidarrUrl || !settings?.lidarrApiKey) return

  const missing = await listPlaylistMissingTracks(db, playlistId)
  if (missing.length === 0) return

  const owner = await getUserById(db, ownerId)
  if (!owner) return

  const lidarr = createLidarrClient(
    settings.lidarrUrl,
    settings.lidarrApiKey,
    settings.skipTlsVerify ?? false,
  )
  const mbClient = createMusicBrainzClient()
  const prefs = mergePreferences(settings.preferences)
  const addOptions = {
    qualityProfileId: prefs.qualityProfileId,
    metadataProfileId: prefs.metadataProfileId,
    rootFolderId: prefs.rootFolderId,
  }

  // Resolve each missing track to the real release-group it originally came
  // from via MusicBrainz (recording -> release-groups, same "earliest
  // original studio/EP/single, never a compilation/deluxe reissue/live
  // album" logic track-based discovery uses -- see pickBestReleaseGroup)
  // instead of trusting the source playlist's own albumTitle tag. That tag
  // is very often a "Greatest Hits"/deluxe/expanded/remaster edition rather
  // than the album the song actually first appeared on, which sent Lidarr
  // requests after the wrong release (confirmed against real playlist-import
  // data: e.g. a "Danger Zone" miss tagged with albumTitle "...The Greatest
  // Hits Of Kenny Loggins" instead of its real source).
  //
  // The lookup itself is searchTrackAlbums (core/search/track-albums.ts),
  // shared with the manual Tracks search -- see the comment at its call
  // below for why it replaced sampling the top few recording-search hits.
  //
  // Falls back to the source's reported albumTitle (fuzzy text search) only
  // when MusicBrainz can't resolve any candidate -- still better than
  // skipping the track entirely.
  //
  // A still-missing track stays missing across most resyncs, so without a
  // cache this whole resolution redoes the same rate-limited MusicBrainz
  // work every single sync -- measured live at ~6 minutes for one ~30-track
  // playlist. track_album_resolution_cache persists the outcome (including a
  // deliberate negative-cache entry when no candidate resolves, so a
  // permanently-unresolvable classic isn't retried from scratch either) so
  // only genuinely new misses ever hit the API.
  type AlbumTarget = {
    artistName: string
    albumTitle: string
    releaseGroupMbid?: string
    artistMbid?: string
    // The song that produced this target -- needed so the dispatch loop's
    // artist-wide "best tier" guess (used when there's no verified
    // releaseGroupMbid at all) can confirm the guessed album actually has
    // this track on it, instead of picking blind by type tier alone.
    // Confirmed live (2026-08): Katrina & The Waves "Walking On Sunshine"
    // guessed "Katrina and the Waves 2" -- a real album, correctly tiered,
    // just the wrong one; it doesn't have that song at all.
    trackName: string
  }
  const albumTargets = new Map<string, AlbumTarget>()
  const resolutionCache = await getCachedTrackAlbumResolutions(db, missing)

  // Fetched once up front -- a full-library fetch is slow enough on its own
  // (see getArtists' own comment) that repeating it per missing track would
  // multiply that cost across a whole playlist's worth of misses for no
  // benefit; the artist roster doesn't change mid-run.
  const knownLidarrArtists = await lidarr.getArtists().catch(() => [])
  const knownArtistsByMbid = new Map(knownLidarrArtists.map((a) => [a.foreignArtistId, a] as const))
  const knownArtistsByName = new Map(
    knownLidarrArtists.map((a) => [normalizeArtistName(a.artistName), a] as const),
  )

  // Tracks that need the AI resolution pass below instead of an MB-resolved
  // target: either MusicBrainz couldn't resolve anything usable at all
  // (this run or a prior negative-cached one), or it resolved to *something*
  // that isn't actually confirmable in Lidarr's own catalog for that artist
  // (see the verification step at the end of this loop) -- confirmed live
  // that trusting an MB resolution just because it exists, without checking
  // it against Lidarr, produced "Def Leppard -> Live Archive" and similar:
  // real MusicBrainz release-groups, just not ones Lidarr can actually add
  // for that artist.
  const unresolvedTracks: typeof missing = []
  let resolvedViaMusicBrainzCount = 0
  let resolvedFromCacheCount = 0
  let alreadyDownloadedCount = 0
  for (const track of missing) {
    // Skip resolution entirely when the artist's Lidarr catalog already has
    // a real downloaded file for this exact song -- see findExistingTrackFile's
    // doc comment. Only checked when the artist is already known to Lidarr;
    // nothing to check against otherwise.
    const knownArtist = knownArtistsByName.get(normalizeArtistName(track.artistName))
    if (knownArtist && (await findExistingTrackFile(lidarr, knownArtist.id, track.trackName))) {
      alreadyDownloadedCount++
      continue
    }

    let resolved: AlbumTarget | null = null
    const cacheKey = trackAlbumCacheKey(track.artistName, track.trackName)
    const cached = resolutionCache.get(cacheKey)
    if (cached) {
      resolvedFromCacheCount++
      if (cached.releaseGroupMbid && cached.albumTitle) {
        resolved = {
          artistName: track.artistName,
          albumTitle: cached.albumTitle,
          releaseGroupMbid: cached.releaseGroupMbid,
          artistMbid: cached.artistMbid ?? undefined,
          trackName: track.trackName,
        }
        resolvedViaMusicBrainzCount++
      }
      // A null cached releaseGroupMbid is the negative-cache case -- `resolved`
      // stays null and falls through to the albumTitle text-search fallback
      // below, same as an uncached resolution failure would.
    } else {
      let releaseGroupMbid: string | null = null
      let albumTitle: string | null = null
      let artistMbid: string | null = null
      try {
        // Same resolver as the manual Tracks search (core/search/
        // track-albums.ts), limited to this track's artist. It replaced
        // pooling the top few recording-search hits: a hit song has hundreds
        // of equally-scored copies, mostly on compilations, so those few
        // hits routinely missed the studio album and requested a
        // compilation instead ("The Essential Alabama", Doug Stone's "Super
        // Hits"). It asks which of the artist's studio albums/EPs carry the
        // song first, then falls back to everywhere it appears. Ranked
        // best-first; live albums are never an acceptable stand-in here.
        const albums = await searchTrackAlbums(mbClient, `${track.artistName} ${track.trackName}`, {
          artistName: track.artistName,
          trackName: track.trackName,
        })
        const best = albums.find(
          (a) =>
            originalReleaseTier(
              {
                id: a.releaseGroupMbid,
                title: a.albumTitle,
                type: a.primaryType,
                secondaryTypes: a.secondaryTypes,
              },
              { excludeLive: true },
            ) !== undefined,
        )
        if (best) {
          releaseGroupMbid = best.releaseGroupMbid
          albumTitle = best.albumTitle
          artistMbid = best.artistMbid
        }
        // Only cache a definite outcome (found or genuinely not found) --
        // an exception below (network/API failure) leaves this track
        // uncached so the next sync retries it instead of permanently
        // treating a transient MusicBrainz outage as "unresolvable."
        await setCachedTrackAlbumResolution(db, {
          artistName: track.artistName,
          trackName: track.trackName,
          releaseGroupMbid,
          artistMbid,
          albumTitle,
        })
        if (releaseGroupMbid && albumTitle) {
          resolved = {
            artistName: track.artistName,
            albumTitle,
            releaseGroupMbid,
            artistMbid: artistMbid ?? undefined,
            trackName: track.trackName,
          }
          resolvedViaMusicBrainzCount++
        }
      } catch (err) {
        console.warn(
          `[playlist-import] MusicBrainz lookup failed for '${track.artistName} - ${track.trackName}':`,
          errMsg(err),
        )
      }
    }
    // An MB resolution is only as good as whether Lidarr can actually act on
    // it -- if the artist is already known to Lidarr, confirm the resolved
    // release-group is really in their catalog before trusting it. Skipped
    // when the artist isn't known to Lidarr at all: nothing to check against,
    // and the existing new-artist-bootstrap path (in the dispatch loop below)
    // still gets a chance to add them fresh.
    if (resolved?.releaseGroupMbid && resolved.artistMbid) {
      const lidarrArtist = knownArtistsByMbid.get(resolved.artistMbid)
      if (lidarrArtist) {
        const albums = await lidarr.getAlbums(lidarrArtist.id).catch(() => [])
        const matchedAlbum = albums.find((a) => a.foreignAlbumId === resolved?.releaseGroupMbid)
        const hasTrack =
          matchedAlbum && (await albumHasTrack(lidarr, matchedAlbum.id, track.trackName))
        if (!hasTrack) resolved = null
      }
    }

    if (!resolved) {
      unresolvedTracks.push(track)
      continue
    }
    const key =
      resolved.releaseGroupMbid ??
      `${resolved.artistName.toLowerCase()}::${resolved.albumTitle.toLowerCase()}`
    if (!albumTargets.has(key)) {
      albumTargets.set(key, resolved)
    }
  }

  // MusicBrainz found nothing usable for these -- ask the AI for the real
  // original album instead of trusting the source playlist's own tag, which
  // is frequently a budget reissue/bundle/compilation rather than the actual
  // source album (confirmed live: Spotify tagging "Sweet Child O' Mine" with
  // a "2 for 1: Appetite for Destruction + G N'R Lies" bundle). The AI's
  // answer is only ever used as a *lookup key* into Lidarr's own already-
  // known catalog for that artist -- verified by exact title match, never
  // trusted blindly -- for the same reason established earlier in this
  // function: an unverified title fed straight into Lidarr's free-text
  // album search can find something that exists in MusicBrainz but isn't
  // actually part of that artist's synced Lidarr catalog, which then fails
  // at the add step no matter how good the title is. Falls back to the old
  // source-tag behavior when AI isn't configured, fails, or its answer
  // doesn't match anything in the artist's real catalog and the artist
  // isn't even known to Lidarr yet (nothing to verify against).
  const aiAlbums = await resolveAlbumsWithAi(unresolvedTracks, settings)
  for (const track of unresolvedTracks) {
    const aiAlbumTitle = aiAlbums.get(trackAlbumCacheKey(track.artistName, track.trackName))
    let resolved: AlbumTarget | null = null

    if (aiAlbumTitle) {
      const lidarrArtist = knownArtistsByName.get(normalizeArtistName(track.artistName))
      if (lidarrArtist) {
        const albums = await lidarr.getAlbums(lidarrArtist.id).catch(() => [])
        const normalizedAiTitle = normalizeAlbumTitle(aiAlbumTitle)
        const matchedAlbum = albums.find((a) => normalizeAlbumTitle(a.title) === normalizedAiTitle)
        if (matchedAlbum && (await albumHasTrack(lidarr, matchedAlbum.id, track.trackName))) {
          resolved = {
            artistName: track.artistName,
            albumTitle: matchedAlbum.title,
            releaseGroupMbid: matchedAlbum.foreignAlbumId,
            artistMbid: lidarrArtist.foreignArtistId,
            trackName: track.trackName,
          }
          // Persist into the same cache the MB pass uses (and checks first,
          // above) -- overwrites a stale MB negative-cache entry for this
          // track with the AI's verified answer, so a subsequent sync reuses
          // it directly instead of re-asking the AI for the same still-
          // missing track every single regen. Only the verified case is
          // cached: the unverified albumTitle-only fallback below hasn't
          // been checked against Lidarr's real catalog at all, so caching it
          // as if it were confirmed could propagate a bad guess indefinitely
          // instead of getting a fresh AI attempt next time.
          await setCachedTrackAlbumResolution(db, {
            artistName: track.artistName,
            trackName: track.trackName,
            releaseGroupMbid: matchedAlbum.foreignAlbumId,
            artistMbid: lidarrArtist.foreignArtistId,
            albumTitle: matchedAlbum.title,
          })
        }
      }
      // Artist unknown to Lidarr, none of their known albums match the AI's
      // title, or the matched album doesn't actually have the track on it --
      // still better than the source tag on its own merits (an AI-identified
      // real original vs. Spotify's often-wrong bundle), so use it unverified
      // rather than discarding it outright.
      if (!resolved) {
        resolved = {
          artistName: track.artistName,
          albumTitle: aiAlbumTitle,
          trackName: track.trackName,
        }
      }
    } else if (track.albumTitle) {
      resolved = {
        artistName: track.artistName,
        albumTitle: track.albumTitle,
        trackName: track.trackName,
      }
    }

    if (!resolved) continue
    const key =
      resolved.releaseGroupMbid ??
      `${resolved.artistName.toLowerCase()}::${resolved.albumTitle.toLowerCase()}`
    if (!albumTargets.has(key)) {
      albumTargets.set(key, resolved)
    }
  }

  if (albumTargets.size === 0) {
    if (alreadyDownloadedCount > 0) {
      console.log(
        `[playlist-import] Auto-request for playlist ${playlistId}: ${alreadyDownloadedCount} missing track(s) already have a downloaded Lidarr file (skipped -- likely just needs a Plex library rescan), 0 requested`,
      )
    }
    return
  }

  // Counts logged once at the end (see below) -- this function previously had
  // zero output on a normal run, so a whole batch silently doing nothing
  // (Lidarr lookup timing out, or every result failing the artist-name
  // match) was indistinguishable from "nothing was actually missing."
  let requestedCount = 0
  let unmatchedCount = 0
  let skippedExistingCount = 0

  let anyChanged = false
  for (const {
    artistName,
    albumTitle,
    releaseGroupMbid,
    artistMbid,
    trackName,
  } of albumTargets.values()) {
    let requestId: number | null = null
    try {
      let match: LidarrAlbumLookupResult | undefined

      // Prefer resolving straight against Lidarr's own knowledge of the
      // artist (MBID-keyed, reliable) over a free-text album search.
      // Confirmed live against a real import: an exact "lidarr:<mbid>"
      // release-group lookup came back empty even though the album already
      // existed -- unmonitored, 0 files -- in this same Lidarr's own library
      // for that artist (Salt-N-Pepa's "Hot, Cool & Vicious"); the text
      // fallback below then matched an unrelated single instead of ever
      // finding it. Once the artist is known to Lidarr, its own album list
      // is ground truth -- no text matching involved -- so search that
      // first: an exact release-group id if MusicBrainz resolved one, else
      // the best-tier real album from their discography (same
      // Album > Compilation > EP > Single > Live ordering as
      // pickBestReleaseGroup, applied to what Lidarr itself already has).
      const lidarrArtist = artistMbid ? knownArtistsByMbid.get(artistMbid) : undefined
      if (lidarrArtist) {
        const albums = await lidarr.getAlbums(lidarrArtist.id).catch((err) => {
          console.warn(
            `[playlist-import] Lidarr getAlbums failed for '${artistName}' (artist id ${lidarrArtist.id}):`,
            errMsg(err),
          )
          return []
        })
        // When MusicBrainz already resolved *this specific track* to a
        // release-group, only ever accept that exact one from the artist's
        // Lidarr discography -- never substitute a different "best tier"
        // album just because the exact id isn't there. Confirmed live this
        // silently requested unrelated albums by the right artist (e.g. The
        // Rolling Stones' "Bridges to Babylon" instead of "Start Me Up"'s
        // real "Tattoo You", Def Leppard's "Slang" instead of "Hysteria")
        // when the resolved id didn't happen to match one of Lidarr's own
        // entries. The artist-wide best-tier guess below is only safe when
        // there's no specific resolution to contradict -- i.e. no
        // releaseGroupMbid at all.
        let albumRow = releaseGroupMbid
          ? albums.find((a) => a.foreignAlbumId === releaseGroupMbid)
          : undefined
        if (!albumRow && !releaseGroupMbid) {
          // Tier alone isn't enough here -- confirmed live (2026-08):
          // Katrina & The Waves "Walking On Sunshine" picked "Katrina and
          // the Waves 2" as the best-tier Album-type candidate, a perfectly
          // real album that simply doesn't have that song on it. Narrow to
          // only candidates that actually have the track before tiering,
          // same verification the MB/AI resolution passes above already do.
          const candidatesWithTrack: LidarrAlbum[] = []
          for (const a of albums) {
            if (await albumHasTrack(lidarr, a.id, trackName)) candidatesWithTrack.push(a)
          }
          const bestReleaseGroup = pickBestReleaseGroup(
            candidatesWithTrack.map((a) => ({
              id: a.foreignAlbumId,
              title: a.title,
              type: a.albumType,
              secondaryTypes: a.secondaryTypes,
            })),
            { excludeLive: true },
          )
          albumRow = bestReleaseGroup
            ? candidatesWithTrack.find((a) => a.foreignAlbumId === bestReleaseGroup.id)
            : undefined
        }
        if (albumRow) {
          match = {
            title: albumRow.title,
            foreignAlbumId: albumRow.foreignAlbumId,
            artist: {
              artistName: lidarrArtist.artistName,
              foreignArtistId: lidarrArtist.foreignArtistId,
            },
            images: [],
          }
        } else if (releaseGroupMbid) {
          // getAlbums() is ground truth for an album Lidarr has already
          // synced (see the Salt-N-Pepa case above), but it isn't
          // exhaustive -- Lidarr only backfills an artist's full catalog
          // into that list on its own refresh schedule, so a real,
          // correctly-attributed release-group can be resolvable and
          // addable well before it shows up there. Confirmed live (2026-08):
          // Brooks & Dunn "Honky Tonk Truth" resolved via MusicBrainz to
          // "The Greatest Hits Collection" -- absent from getAlbums()'s
          // synced list for this same already-known artist, yet Lidarr's own
          // exact "lidarr:<mbid>" lookup (its metadata backend, not a text
          // search) returned that exact album under the same artist. Still
          // an exact-id lookup, not the fuzzy text search this whole branch
          // exists to avoid, so it carries none of that risk -- and the
          // artist-id check below guards against the specific failure mode
          // (id lookup returning something credited elsewhere) that a raw
          // id match alone wouldn't catch.
          const idMatches = await lidarr.lookupAlbum(`lidarr:${releaseGroupMbid}`).catch((err) => {
            console.warn(
              `[playlist-import] Lidarr MBID lookup failed for '${artistName} - ${albumTitle}' (${releaseGroupMbid}):`,
              errMsg(err),
            )
            return []
          })
          match = idMatches.find((m) => m.artist?.foreignArtistId === lidarrArtist.foreignArtistId)
        }
      }

      // Only fall back to Lidarr's separate metadata-lookup/text-search when
      // the artist is genuinely new to this Lidarr instance. Confirmed live
      // this was firing even for already-known artists (Guns N' Roses, The
      // Rolling Stones, Def Leppard, ...) whenever the resolved
      // releaseGroupMbid wasn't in their synced album list -- but that
      // lookup uses the exact same per-artist getAlbums() data addAlbum
      // itself later checks, so whatever it finds is, by construction, ALSO
      // not in that list and addAlbum's own findSelectedAlbums poll was
      // therefore guaranteed to fail every time ("album not found in
      // Lidarr"), producing a permanently-failing request instead of an
      // honest "unmatched." Skipping this fallback for a known artist trades
      // a few fewer auto-requests for zero guaranteed-broken ones.
      if (!match && !lidarrArtist) {
        let matches = releaseGroupMbid
          ? await lidarr.lookupAlbum(`lidarr:${releaseGroupMbid}`).catch((err) => {
              console.warn(
                `[playlist-import] Lidarr MBID lookup failed for '${artistName} - ${albumTitle}' (${releaseGroupMbid}):`,
                errMsg(err),
              )
              return []
            })
          : []
        if (matches.length === 0) {
          const strippedTitle = albumTitle.replace(/\s*\([^)]*\)\s*$/, '').trim() || albumTitle
          matches = await lidarr.lookupAlbum(`${artistName} ${strippedTitle}`).catch((err) => {
            console.warn(
              `[playlist-import] Lidarr lookup failed for '${artistName} - ${strippedTitle}':`,
              errMsg(err),
            )
            return []
          })
          if (matches.length === 0 && strippedTitle !== albumTitle) {
            matches = await lidarr.lookupAlbum(`${artistName} ${albumTitle}`).catch((err) => {
              console.warn(
                `[playlist-import] Lidarr lookup failed for '${artistName} - ${albumTitle}':`,
                errMsg(err),
              )
              return []
            })
          }
        }

        const normalizedArtist = normalizeArtistName(artistName)
        match = releaseGroupMbid
          ? (matches.find((m) => m.foreignAlbumId === releaseGroupMbid) ??
            matches.find(
              (m) =>
                m.artist?.artistName &&
                normalizeArtistName(m.artist.artistName) === normalizedArtist,
            ))
          : matches.find(
              (m) =>
                m.artist?.artistName &&
                normalizeArtistName(m.artist.artistName) === normalizedArtist,
            )
      }

      if (!match?.artist?.foreignArtistId || !match.foreignAlbumId) {
        unmatchedCount++
        console.warn(`[playlist-import] No Lidarr match for '${artistName} - ${albumTitle}'`)
        continue
      }

      const autoDispatches = owner.isAdmin || owner.isOwner || owner.autoApproveRequests === true
      const existing = await findRequestForAlbum(db, ownerId, match.foreignAlbumId)

      // A prior attempt for this exact album is still in flight (pending
      // review, or already dispatched) or was explicitly rejected by an
      // admin -- leave it alone instead of piling on a duplicate. Only a
      // failed attempt, or one that got created but never actually reached
      // dispatch (e.g. the app restarted mid-batch -- see the catch block
      // below), is worth retrying in place.
      const retryable =
        !!existing &&
        (existing.status === 'failed' ||
          (existing.status === 'pending' && autoDispatches && existing.targetActions == null))
      if (existing && !retryable) {
        skippedExistingCount++
        continue
      }

      const requestRow = existing
        ? existing
        : await createRequest(db, {
            requestedByUserId: ownerId,
            kind: 'album',
            artistMbid: match.artist.foreignArtistId,
            artistName: match.artist.artistName ?? artistName,
            releaseGroupMbid: match.foreignAlbumId,
            albumTitle: match.title ?? albumTitle,
            sourcePlaylistId: playlistId,
          })
      requestId = requestRow.id
      if (!existing) anyChanged = true

      if (!autoDispatches) {
        requestedCount++
        continue
      }

      const targets = await getEnabledTargetsForResolvedUser(ownerId)
      const result = await approveAlbumToTargets(
        {
          artistMbid: requestRow.artistMbid,
          artistName: requestRow.artistName,
          releaseGroupMbid: requestRow.releaseGroupMbid as string,
        },
        targets,
        addOptions,
        jobRecorder,
        ownerId,
      )
      const anySuccess = Object.values(result.targetActions).some((action) => {
        const status = (action as { status?: string } | null)?.status
        return status === 'added' || status === 'queued'
      })
      await resolveRequest(db, requestRow.id, {
        status: anySuccess ? 'dispatched' : 'failed',
        targetActions: result.targetActions,
      })
      requestedCount++
      anyChanged = true
      realtimeBroker.publish(ownerId, { type: 'request-updated', requestId: requestRow.id })
      if (anySuccess) realtimeBroker.publish(ownerId, { type: 'activity-updated' })
    } catch (err) {
      console.error(
        `[playlist-import] Auto-request failed for '${artistName} - ${albumTitle}':`,
        err,
      )
      // The request row was already created/found before this failure hit --
      // don't leave it silently stuck at 'pending' with no recorded reason.
      // This is exactly what produced permanently-stuck "pending approval"
      // entries for admins in practice: an exception (or the app restarting)
      // mid-dispatch used to leave the row exactly as createRequest left it,
      // forever.
      if (requestId != null) {
        await resolveRequest(db, requestId, {
          status: 'failed',
          targetActions: { error: errMsg(err) },
        }).catch(() => {})
      }
    }
  }

  console.log(
    `[playlist-import] Auto-request for playlist ${playlistId}: ${albumTargets.size} missing album(s) considered (${resolvedViaMusicBrainzCount} resolved via MusicBrainz, ${resolvedFromCacheCount} from cache), ${requestedCount} requested, ${skippedExistingCount} already in flight, ${unmatchedCount} not found in Lidarr, ${alreadyDownloadedCount} already downloaded (skipped)`,
  )
  if (anyChanged) realtimeBroker.publish(ownerId, { type: 'library-updated' })
}

// Every source returns the same entry shape (artist/track/album, plus the
// track's album art), alongside the playlist's own title and cover image.
function fetchImportSource(source: string, playlistId: string) {
  return source === 'spotify'
    ? getSpotifyPlaylistTracks(playlistId)
    : source === 'youtube_music'
      ? getYoutubeMusicPlaylistTracks(playlistId)
      : source === 'apple_music'
        ? getAppleMusicPlaylistTracks(playlistId)
        : fetchDeezerPlaylistTracks(playlistId)
}

// Fills in cover art for imported playlists (every user's) synced before
// covers were stored, without a full re-sync -- one source fetch per
// playlist, no Plex search or Lidarr requests. Only touches what's missing:
// a playlist with no cover, and missing-track rows with no album art. Runs
// once at boot, sequentially, best-effort per playlist.
async function backfillImportedPlaylistArt(): Promise<void> {
  const imported = await getImportedPlaylistsWithOwners(db)
  let filled = 0
  for (const playlist of imported) {
    const cfg = playlist.config
    if (!cfg?.importSource || !cfg.importPlaylistId) continue
    const missing = await listPlaylistMissingTracks(db, playlist.id)
    const needsTrackArt = missing.some((m) => m.coverUrl == null)
    if (playlist.coverUrl && !needsTrackArt) continue
    try {
      const fetched = await fetchImportSource(cfg.importSource, cfg.importPlaylistId)
      if (!playlist.coverUrl && fetched.imageUrl) {
        await updatePlaylistRow(db, playlist.id, { coverUrl: fetched.imageUrl })
      }
      if (needsTrackArt) {
        // Missing-track rows store the qualifier-stripped title (see
        // executePlaylistImport), so match on the same form.
        await fillMissingTrackCovers(
          db,
          playlist.id,
          fetched.tracks.map((t) => ({
            artistName: t.artistName,
            trackName: stripSearchQualifier(t.trackName),
            coverUrl: t.coverUrl,
          })),
        )
      }
      filled++
      if (playlist.userId != null) {
        realtimeBroker.publish(playlist.userId, { type: 'library-updated' })
      }
    } catch (err) {
      console.warn(
        `[playlist-art] Backfill failed for playlist ${playlist.id} ('${playlist.name}'): ${errMsg(err)}`,
      )
    }
  }
  if (filled > 0)
    console.log(`[playlist-art] Backfilled cover art for ${filled} imported playlist(s)`)
}

// Import mirrors an exact external playlist (Spotify/Deezer/YouTube Music/Apple Music) track-by-track
// into Plex -- it has no artist-selection step, so it bypasses
// generatePlaylist() entirely rather than shoehorning into the
// selectArtists -> resolveTracks shape every other strategy uses.
async function executePlaylistImport(playlist: PlaylistRow, jobId: number | null): Promise<void> {
  if (playlist.userId == null) {
    throw new Error('Playlist import requires a playlist owner')
  }
  const cfg = playlist.config
  if (!cfg?.importSource || !cfg.importPlaylistId) {
    throw new Error('Playlist import is missing its source/playlistId config')
  }

  const ownerConns = await getUserConnections(db, playlist.userId)
  if (!ownerConns?.plexUrl || !ownerConns?.plexToken) {
    throw new Error('Playlist owner has no connected Plex account')
  }

  const fetched = await fetchImportSource(cfg.importSource, cfg.importPlaylistId)
  const resolvedName = fetched.name
  let tracks: ExternalTrack[] = fetched.tracks

  // Source playlists sometimes tag a live recording or a specific edition
  // directly on the track title (e.g. "Kiss - Live", "Start Me Up -
  // Remastered 2009"). Searching Plex for that exact title either only
  // matches an entry carrying the same suffix (the live version
  // specifically) or, confirmed live, returns zero Plex results outright
  // when the suffix is text Plex's own tag doesn't have -- so it's stripped
  // here to the plain song title before matching. pickBestTrackMatch
  // (playlist-match.ts) then prefers a studio release among same-titled
  // Plex candidates, and rejects a match outright if only a live/acoustic/
  // demo release is on hand, reporting the track missing so
  // autoRequestMissingPlaylistTracks below requests the real studio album
  // from Lidarr.
  tracks = tracks.map((t) => ({ ...t, trackName: stripSearchQualifier(t.trackName) }))

  // The source's real title, once known, replaces the "<Source> Playlist"
  // placeholder the row was created with -- and stays in sync on every
  // re-sync in case the source playlist gets renamed upstream.
  const playlistName = resolvedName?.trim() || playlist.name

  const importResult = await importExternalPlaylistToPlex({
    name: playlistName,
    tracks,
    plex: { url: ownerConns.plexUrl, token: ownerConns.plexToken },
    targetId: playlist.userId,
    playlistId: playlist.id,
    pushToPlex: playlist.autoPushToPlex === true,
    missingTracksDb: {
      reconcileMissingTracks: (playlistId, missing) =>
        reconcilePlaylistMissingTracks(db, playlistId, missing),
    },
  })

  await updatePlaylistRow(db, playlist.id, {
    name: playlistName,
    // Keep the last known cover if this fetch didn't return one.
    coverUrl: fetched.imageUrl ?? playlist.coverUrl,
    lastGeneratedAt: new Date(),
    trackCount: importResult.tracksMatched,
    status: 'active',
    pushedToPlex: playlist.autoPushToPlex === true,
  })

  await autoRequestMissingPlaylistTracks(playlist.userId, playlist.id)

  console.log(
    `[playlist-import] '${playlistName}': ${importResult.tracksMatched}/${importResult.tracksTotal} tracks matched, ${importResult.missingCount} missing`,
  )

  if (jobId != null) {
    await jobRecorder.complete(jobId, {
      metadata: {
        playlistName,
        strategy: playlist.strategy,
        tracksTotal: importResult.tracksTotal,
        tracksMatched: importResult.tracksMatched,
        missingCount: importResult.missingCount,
      },
    })
  }
}

// Pushes a one-time snapshot of this playlist's current tracks directly to
// Plex under a new name -- no DJ Llama row involved at all, so repeat clicks
// are just "push again," not a growing pile of tracked duplicates that then
// need cleaning up. Plex itself has no unique-name constraint on playlists
// (it would happily leave two identically-titled playlists sitting side by
// side), but createPlaylist() below already dedupes by deleting any existing
// same-named playlist first -- so duplicating twice under the same name
// replaces the previous snapshot in place rather than stacking a second copy.
async function executePlaylistDuplicate(
  playlistId: number,
  name?: string,
): Promise<{ pushed: boolean; itemsAdded: number }> {
  const source = await getPlaylistWithTracks(db, playlistId)
  if (!source) throw new Error('Playlist not found')

  const resolvedTracks: ResolvedTrack[] = source.tracks.map((t) => ({
    artistName: t.artistName,
    trackName: t.trackName ?? '',
    mbid: t.mbid ?? undefined,
    spotifyUri: t.spotifyUri ?? undefined,
    deezerId: t.deezerId ?? undefined,
    localPath: t.localPath ?? undefined,
    source: 'local',
  }))

  const targetName = name?.trim() || `${source.playlist.name} (Copy)`

  return pushPlaylistTracksToPlex(
    { id: source.playlist.id, userId: source.playlist.userId, name: targetName },
    resolvedTracks,
  )
}

// Plex is the only playlist push destination -- construct the target on the
// fly from the playlist owner's own resolved Plex connection (already set at
// login) rather than a manually-configured target row. Shared by the
// automatic-lifecycle path in executePlaylistGeneration and the manual
// "Push to Plex" route for pending_review playlists.
//
// createPlaylist() never throws (it catches internally and returns
// {success: false, error} instead), so this must inspect the returned
// PlaylistResult rather than relying on try/catch to detect failure --
// otherwise a real Plex-side failure would still be reported as pushed=true.
// itemsAdded reflects tracks Plex actually matched/added, distinct from the
// candidate count passed in.
async function pushPlaylistTracksToPlex(
  playlist: Pick<PlaylistRow, 'id' | 'userId' | 'name'>,
  tracks: ResolvedTrack[],
  previousName?: string,
): Promise<{ pushed: boolean; itemsAdded: number }> {
  const notPushed = { pushed: false, itemsAdded: 0 }
  if (playlist.userId == null) return notPushed
  const ownerConns = await getUserConnections(db, playlist.userId)
  if (!ownerConns?.plexUrl || !ownerConns?.plexToken) return notPushed

  const playlistItems = tracks.map((track) => ({
    artistName: track.artistName,
    artistMbid: '',
    trackName: track.trackName ?? undefined,
    trackMbid: track.mbid ?? undefined,
  }))
  const target = createPlexPlaylistTarget(playlist.userId, {
    url: ownerConns.plexUrl,
    token: ownerConns.plexToken,
  })

  // createPlaylist()'s own same-name dedupe only catches an exact title
  // match -- if the title itself changed since the last run (e.g. Daily
  // Mix's genre label moved from "Indie Rock" to "Alt Rock"), the old title
  // needs its own explicit cleanup or it's left behind as an orphan.
  if (previousName && previousName !== playlist.name) {
    await target.deletePlaylist?.(previousName)
  }

  try {
    const result = await target.createPlaylist?.(playlist.name, playlistItems)
    if (!result?.success) {
      console.error(`[playlists] Failed to push playlist ${playlist.id} to Plex:`, result?.error)
      return notPushed
    }
    return { pushed: true, itemsAdded: result.itemsAdded ?? 0 }
  } catch (err: unknown) {
    console.error(`[playlists] Failed to push playlist ${playlist.id} to Plex:`, err)
    return notPushed
  }
}

// A seasonal playlist generated by hand outside its season (e.g. previewing
// Christmas in October) keeps its tracks but stays out of Plex until the
// window opens -- the seasonal tick pushes it then.
function isSeasonalPlaylistInWindow(playlist: Pick<PlaylistRow, 'config'>): boolean {
  const preset = getSeasonalPreset(playlist.config?.presetKey)
  if (!preset) return false
  const window = playlist.config?.windowOverride ?? preset.window
  return isWithinSeasonalWindow({ ...preset, window }, new Date())
}

type EditableTrack = { artistName: string; trackName: string; localPath?: string | null }

function trackRowsToResolved(tracks: PlaylistTrackRow[]): ResolvedTrack[] {
  return tracks.map((t) => ({
    artistName: t.artistName,
    trackName: t.trackName ?? '',
    mbid: t.mbid ?? undefined,
    spotifyUri: t.spotifyUri ?? undefined,
    deezerId: t.deezerId ?? undefined,
    localPath: t.localPath ?? undefined,
    source: 'local',
  }))
}

// Writes an edited track list back and, when the playlist is currently live
// in Plex, re-pushes it so the edit shows up in Plexamp right away.
async function saveEditedPlaylistTracks(
  playlist: PlaylistRow,
  tracks: ResolvedTrack[],
  config: PlaylistConfig,
): Promise<void> {
  await replacePlaylistTracks(
    db,
    playlist.id,
    tracks.map((t, index) => ({
      playlistId: playlist.id,
      artistName: t.artistName,
      trackName: t.trackName ?? null,
      mbid: t.mbid ?? null,
      spotifyUri: t.spotifyUri ?? null,
      deezerId: t.deezerId ?? null,
      localPath: t.localPath ?? null,
      position: index,
    })),
  )
  let trackCount = tracks.length
  if (playlist.pushedToPlex && playlist.status === 'active') {
    const { pushed, itemsAdded } = await pushPlaylistTracksToPlex(playlist, tracks)
    if (pushed) trackCount = itemsAdded
  }
  await updatePlaylistRow(db, playlist.id, { config, trackCount })
}

function withoutTrack<T extends { artistName: string; trackName: string }>(
  list: T[] | undefined,
  track: { artistName: string; trackName: string },
): T[] {
  const key = seasonalTrackKey(track.artistName, track.trackName)
  return (list ?? []).filter((t) => seasonalTrackKey(t.artistName, t.trackName) !== key)
}

// Removes one song and remembers the removal, so regenerating never brings
// it back.
async function removePlaylistTrack(playlistId: number, trackId: number): Promise<boolean> {
  const loaded = await getPlaylistWithTracks(db, playlistId)
  if (!loaded) return false
  const { playlist, tracks } = loaded
  const removed = tracks.find((t) => t.id === trackId)
  if (!removed) return false
  const ref = { artistName: removed.artistName, trackName: removed.trackName ?? '' }
  const cfg = (playlist.config ?? { size: 25, trackSourcePriority: ['local'] }) as PlaylistConfig
  const config: PlaylistConfig = {
    ...cfg,
    excludedTracks: [...withoutTrack(cfg.excludedTracks, ref), ref],
    pinnedTracks: withoutTrack(cfg.pinnedTracks, ref),
    seasonalCandidates: withoutTrack(cfg.seasonalCandidates, ref),
  }
  const remaining = tracks.filter((t) => t.id !== trackId).sort((a, b) => a.position - b.position)
  await saveEditedPlaylistTracks(playlist, trackRowsToResolved(remaining), config)
  return true
}

// Adds one song to the end and pins it, so regenerating always keeps it.
async function addPlaylistTrack(playlistId: number, track: EditableTrack): Promise<boolean> {
  const loaded = await getPlaylistWithTracks(db, playlistId)
  if (!loaded) return false
  const { playlist, tracks } = loaded
  const key = seasonalTrackKey(track.artistName, track.trackName)
  const current = trackRowsToResolved(tracks.slice().sort((a, b) => a.position - b.position))
  if (current.some((t) => seasonalTrackKey(t.artistName, t.trackName) === key)) return true
  const ref = { artistName: track.artistName, trackName: track.trackName }
  const cfg = (playlist.config ?? { size: 25, trackSourcePriority: ['local'] }) as PlaylistConfig
  const config: PlaylistConfig = {
    ...cfg,
    excludedTracks: withoutTrack(cfg.excludedTracks, ref),
    pinnedTracks: [
      ...withoutTrack(cfg.pinnedTracks, ref),
      { ...ref, localPath: track.localPath ?? null },
    ],
    seasonalCandidates: withoutTrack(cfg.seasonalCandidates, ref),
  }
  current.push({
    artistName: track.artistName,
    trackName: track.trackName,
    localPath: track.localPath ?? undefined,
    source: 'local',
  })
  await saveEditedPlaylistTracks(playlist, current, config)
  return true
}

// Replacement suggestions for a seasonal playlist: the next-best seasonal
// candidates saved by the last generation, minus anything already in it.
// Playlists generated before candidates were saved compute them once here
// (a size-0 run of the seasonal generator) and keep them.
async function getPlaylistSuggestions(
  playlistId: number,
  limit = 8,
): Promise<NonNullable<PlaylistConfig['seasonalCandidates']>> {
  const loaded = await getPlaylistWithTracks(db, playlistId)
  if (!loaded) return []
  if (loaded.playlist.strategy !== 'seasonal') return []
  const { playlist, tracks } = loaded
  const cfg = (playlist.config ?? { size: 25, trackSourcePriority: ['local'] }) as PlaylistConfig
  let candidates = cfg.seasonalCandidates
  if (!candidates) {
    const generation = await generatePlaylist(
      'seasonal',
      {
        size: 0,
        presetKey: cfg.presetKey,
        trackSourcePriority: ['local'],
        excludedTracks: cfg.excludedTracks,
      },
      buildStrategyDeps(db, playlist.userId ?? null, providerRegistry),
      await buildPlaylistResolverDeps(playlist.userId ?? null),
    )
    candidates = generation.seasonalCandidates ?? []
    await updatePlaylistRow(db, playlist.id, {
      config: { ...cfg, seasonalCandidates: candidates },
    })
  }
  const inPlaylist = new Set(tracks.map((t) => seasonalTrackKey(t.artistName, t.trackName ?? '')))
  return candidates
    .filter((c) => !inPlaylist.has(seasonalTrackKey(c.artistName, c.trackName)))
    .slice(0, limit)
}

// Pushes an already-generated pending_review playlist's existing tracks to
// Plex on explicit user action (the manual "Push to Plex" button) -- unlike
// executePlaylistGeneration, this never re-runs the strategy, it just
// activates what's already sitting in playlist_tracks.
async function pushPendingReviewPlaylist(playlistId: number): Promise<boolean> {
  const result = await getPlaylistWithTracks(db, playlistId)
  if (!result) return false
  const { playlist, tracks } = result

  const resolvedTracks: ResolvedTrack[] = tracks.map((t) => ({
    artistName: t.artistName,
    trackName: t.trackName ?? '',
    mbid: t.mbid ?? undefined,
    spotifyUri: t.spotifyUri ?? undefined,
    deezerId: t.deezerId ?? undefined,
    localPath: t.localPath ?? undefined,
    source: 'local',
  }))

  const { pushed, itemsAdded } = await pushPlaylistTracksToPlex(playlist, resolvedTracks)
  if (pushed) {
    await updatePlaylistRow(db, playlist.id, {
      trackCount: itemsAdded,
      status: 'active',
      pushedToPlex: true,
      reviewExpiresAt: null,
    })
  }
  return pushed
}

// Attaches each missing track's actual resolved target album (if any) from
// track_album_resolution_cache, for display alongside the source playlist's
// own (often misleading) album tag -- see MissingTrackWithResolution's doc
// comment (db/queries/playlist-missing-tracks.ts).
async function listMissingTracksWithResolution(
  playlistId: number,
): Promise<MissingTrackWithResolution[]> {
  const missing = await listPlaylistMissingTracks(db, playlistId)
  if (missing.length === 0) return []
  const resolutionCache = await getCachedTrackAlbumResolutions(db, missing)
  return missing.map((track) => ({
    ...track,
    resolvedAlbumTitle:
      resolutionCache.get(trackAlbumCacheKey(track.artistName, track.trackName))?.albumTitle ??
      null,
  }))
}

// Manually-triggered cleanup for a single playlist's live Plex playlist
// contents (see PlaylistDeps.sweepLiveTracks) -- reads the playlist's actual
// current Plex items and swaps only the ones flagged as a live/acoustic/demo
// recording, rather than re-searching every track like a regenerate does.
// No automatic schedule: import playlists already fully re-search on their
// own nightly cron, so this exists for on-demand cleanup (e.g. right after
// the matching logic improves) without adding that cost to every regen.
async function sweepLiveTracksInPlaylist(playlistId: number): Promise<SweepLiveTracksResult> {
  const loaded = await getPlaylistWithTracks(db, playlistId)
  const { playlist } = loaded ?? {}
  if (!playlist || playlist.userId == null) {
    return { success: false, error: 'Playlist not found' }
  }

  const ownerConns = await getUserConnections(db, playlist.userId)
  if (!ownerConns?.plexUrl || !ownerConns?.plexToken) {
    return { success: false, error: 'Playlist owner has no connected Plex account' }
  }

  const result = await sweepPlaylistLiveTracks(
    { url: ownerConns.plexUrl, token: ownerConns.plexToken },
    playlist.name,
  )

  if (result.success && result.playlistFound) {
    console.log(
      `[live-sweep] '${playlist.name}': checked ${result.checked} tracks, replaced ${result.replaced.length} live version(s), ${result.stillLive.length} still live (no studio version in library)`,
    )
  }

  return result
}

// Every playlist generation -- Generate button, cron schedule, seasonal tick,
// library-webhook re-sync -- goes through one server-wide queue, one at a
// time. Running them concurrently (e.g. tapping Generate on every imported
// playlist) overloaded Plex: its track search timed out en masse, so tracks
// that are actually in the library were recorded as missing with
// reason 'search_error'. A playlist already waiting in the queue isn't queued
// a second time; the caller just gets the pending run.
let playlistGenerationTail: Promise<unknown> = Promise.resolve()
const queuedPlaylistGenerations = new Map<number, Promise<void>>()

function executePlaylistGeneration(playlistId: number): Promise<void> {
  const pending = queuedPlaylistGenerations.get(playlistId)
  if (pending) return pending
  const run = playlistGenerationTail.then(() => {
    // Leaves the queue map when it starts, so a Generate tapped mid-run
    // queues a fresh run after this one instead of being swallowed by it.
    queuedPlaylistGenerations.delete(playlistId)
    return generatePlaylistNow(playlistId)
  })
  queuedPlaylistGenerations.set(playlistId, run)
  playlistGenerationTail = run.catch(() => undefined)
  return run
}

async function generatePlaylistNow(playlistId: number): Promise<void> {
  let jobId: number | null = null

  const result = await getPlaylistWithTracks(db, playlistId)
  if (!result) {
    console.warn(`[playlist-scheduler] Playlist ${playlistId} not found - skipping`)
    return
  }

  const playlist = result.playlist
  // Tracked across the whole try/catch (including the import/snapshot early
  // returns) so the single `finally` below can always tell the client which
  // way it went, regardless of which path finished the job.
  let outcome: 'success' | 'error' = 'success'

  try {
    jobId = await jobRecorder.start({
      type: 'playlist',
      userId: playlist.userId ?? undefined,
      metadata: { playlistName: playlist.name, strategy: playlist.strategy },
    })

    if (playlist.strategy === 'import') {
      await executePlaylistImport(playlist, jobId)
      return
    }

    const strategyDeps = buildStrategyDeps(db, playlist.userId ?? null, providerRegistry)
    const resolverDeps = await buildPlaylistResolverDeps(playlist.userId ?? null)
    const cfg = playlist.config ?? {
      size: 25,
      trackSourcePriority: ['local', 'spotify', 'deezer'] as const,
    }
    // Daily Mix must never contain a track the user doesn't own -- enforced
    // here regardless of what's stored on the row, not just by convention.
    const trackSourcePriority: ('local' | 'spotify' | 'deezer')[] =
      playlist.strategy === 'daily_mix' ? ['local'] : cfg.trackSourcePriority
    const generation = await generatePlaylist(
      playlist.strategy as import('./db/schema').PlaylistStrategy,
      {
        size: cfg.size,
        genre: cfg.genre,
        mood: cfg.mood,
        presetKey: cfg.presetKey,
        prompt: cfg.prompt,
        useListeningHistory: cfg.useListeningHistory,
        genreFilters: cfg.genreFilters,
        decadeFilters: cfg.decadeFilters,
        excludeLiveVersions: cfg.excludeLiveVersions,
        trackSourcePriority,
        mixIndex: cfg.mixIndex,
        excludedTracks: cfg.excludedTracks,
        pinnedTracks: cfg.pinnedTracks,
      },
      strategyDeps,
      resolverDeps,
    )

    // Only strategies the user never names get a generated title: Mediasage
    // (a fully random phrase, e.g. "Golden Hour Groove - Jul 2026") and Daily
    // Mix (fixed "Daily Mix N" prefix plus a genre-aware subtitle). Curated
    // playlists keep the name the user gave them. The previous title is
    // captured below for Plex cleanup. Only Mediasage gets a description.
    const preRenameName = playlist.name
    const usesEvocativeTitle =
      playlist.strategy === 'ai_prompt' || playlist.strategy === 'daily_mix'
    if (usesEvocativeTitle && generation.mixTitle) {
      playlist.name = generation.mixTitle
    }
    if (playlist.strategy === 'ai_prompt') {
      playlist.description = generation.mixDescription ?? null
    }

    const trackInserts = generation.tracks.map((track, index) => ({
      playlistId: playlist.id,
      artistName: track.artistName,
      trackName: track.trackName ?? null,
      mbid: track.mbid ?? null,
      spotifyUri: track.spotifyUri ?? null,
      deezerId: track.deezerId ?? null,
      localPath: track.localPath ?? null,
      position: index,
    }))

    await replacePlaylistTracks(db, playlist.id, trackInserts)
    if (generation.seasonalCandidates) {
      await updatePlaylistRow(db, playlist.id, {
        config: { ...cfg, seasonalCandidates: generation.seasonalCandidates },
      })
    }

    // Four distinct lifecycles (see plan Phase 4, plus daily_mix): ai_prompt
    // is fully exempt from auto-add and always waits for an explicit
    // Push/Reject decision with no expiry; seasonal follows the master
    // seasonal toggle (its own tick owns teardown, so it never uses the
    // review-expiry mechanism); every other strategy (daily_mix,
    // weekly_digest, genre_focus, mood_mix, rediscover) always auto-pushes
    // and replaces the previous Plex playlist in place the moment it
    // regenerates -- ai_prompt is the only one that stops for a manual
    // accept/reject decision, since it's the only strategy the user hasn't
    // already implicitly approved by creating/scheduling it.
    const settings = await getSettings(db)
    const prefs = mergePreferences(settings?.preferences)

    const autoPush =
      playlist.strategy === 'ai_prompt'
        ? false
        : playlist.strategy === 'seasonal'
          ? prefs.seasonalPlaylistsEnabled === true && isSeasonalPlaylistInWindow(playlist)
          : true

    const { pushed, itemsAdded } = autoPush
      ? await pushPlaylistTracksToPlex(playlist, generation.tracks, preRenameName)
      : { pushed: false, itemsAdded: 0 }

    const reviewWindowDays = prefs.reviewWindowDays ?? 14
    const usesReviewExpiry =
      !pushed &&
      playlist.strategy !== 'ai_prompt' &&
      playlist.strategy !== 'seasonal' &&
      playlist.strategy !== 'daily_mix'

    // Once pushed, trackCount reflects what Plex actually added, not the
    // pre-push candidate list -- otherwise a partial/failed match silently
    // overstates the playlist's real size (see plex-playlist.ts).
    const trackCount = pushed ? itemsAdded : generation.tracks.length

    await updatePlaylistRow(db, playlist.id, {
      name: playlist.name,
      description: playlist.description,
      lastGeneratedAt: new Date(),
      trackCount,
      status: pushed ? 'active' : 'pending_review',
      pushedToPlex: pushed,
      reviewExpiresAt: usesReviewExpiry
        ? new Date(Date.now() + reviewWindowDays * 24 * 60 * 60 * 1000)
        : null,
    })

    console.log(
      `[playlist-scheduler] Playlist '${playlist.name}' (id=${playlist.id}): ${trackCount} tracks${pushed ? ', pushed to Plex' : ', awaiting review'}`,
    )

    // Per-user, only when the playlist actually landed in 'pending_review' just
    // above (status: pushed ? 'active' : 'pending_review') -- i.e. actually
    // awaiting a decision, not the common auto-pushed case. `playlist.status`
    // itself is stale here (updatePlaylistRow doesn't mutate the local object),
    // so branch on `pushed` directly rather than re-reading it.
    if (!pushed && playlist.userId != null) {
      getUserById(db, playlist.userId)
        .then((user) => {
          const userChannels = decryptChannelSecrets(
            mergePreferences(user?.preferences).channels ?? [],
          )
          return dispatch(userChannels, 'playlist_generated', {
            event: 'playlist_generated',
            playlistId: playlist.id,
            playlistName: playlist.name,
            message: `Your playlist "${playlist.name}" is ready and awaiting review.`,
            timestamp: new Date().toISOString(),
          })
        })
        .catch((err) => console.error('Notification dispatch failed:', err))
    }

    if (jobId != null) {
      await jobRecorder.complete(jobId, {
        metadata: {
          playlistName: playlist.name,
          trackCount: generation.tracks.length,
          strategy: playlist.strategy,
        },
      })
    }
  } catch (err: unknown) {
    outcome = 'error'
    if (jobId != null) {
      await recordFailureSafely(jobRecorder, jobId, errMsg(err))
    }
    throw err
  } finally {
    // Fires on every exit path -- the import/snapshot early returns above,
    // the normal success path, and the catch/rethrow -- so a manual Generate
    // click always gets a live "it's done" signal instead of the button
    // spinning until the page is refreshed (see use-realtime-updates.ts).
    if (playlist.userId != null) {
      realtimeBroker.publish(playlist.userId, {
        type: 'playlist-generated',
        playlistId: playlist.id,
        status: outcome,
      })
    }
  }
}

// Seasonal playlists have no fixed recurrence -- they fire once when a
// preset's calendar window opens and tear down once it closes, so (unlike
// every other strategy) they carry no per-playlist cron. One shared daily
// tick checks every enabled seasonal playlist's window state instead. See
// core/playlists/seasonal-tick.ts for the (unit-tested) orchestration logic.
async function tickSeasonalPlaylists(): Promise<void> {
  await runSeasonalTick({
    getEnabledSeasonalPlaylists: async () => {
      const settings = await getSettings(db)
      const prefs = mergePreferences(settings?.preferences)
      // Master toggle gates the whole category regardless of which
      // individual preset rows exist -- row existence/enabled is each
      // preset's own on/off, this is the tristate's outer switch.
      if (!prefs.seasonalPlaylistsEnabled) return []
      return (await getEnabledPlaylists(db)).filter((p) => p.strategy === 'seasonal')
    },
    generatePlaylist: (id) => executePlaylistGeneration(id),
    tearDownPlaylist: async (playlist) => {
      if (playlist.userId != null) {
        const ownerConns = await getUserConnections(db, playlist.userId)
        if (ownerConns?.plexUrl && ownerConns?.plexToken) {
          const target = createPlexPlaylistTarget(playlist.userId, {
            url: ownerConns.plexUrl,
            token: ownerConns.plexToken,
          })
          try {
            await target.deletePlaylist?.(playlist.name)
          } catch (err: unknown) {
            console.error(
              `[seasonal-playlists] failed to delete Plex playlist '${playlist.name}':`,
              err,
            )
          }
        }
      }
      await replacePlaylistTracks(db, playlist.id, [])
      // 'pending_review' here just means "not currently active" -- seasonal
      // rows never surface Push/Reject UI regardless of status, since this
      // tick is the only thing that ever pushes or tears them down.
      await updatePlaylistRow(db, playlist.id, {
        lastGeneratedAt: null,
        trackCount: 0,
        status: 'pending_review',
        pushedToPlex: false,
        reviewExpiresAt: null,
      })
    },
    onGenerated: (playlist) => {
      console.log(`[seasonal-playlists] generated '${playlist.name}'`)
    },
    onGenerateFailed: (playlist, err) => {
      console.error(`[seasonal-playlists] failed to generate '${playlist.name}':`, err)
    },
    onTornDown: (playlist) => {
      console.log(`[seasonal-playlists] tore down '${playlist.name}' (window closed)`)
    },
  })
}

// Tears down auto-generated (non-ai_prompt, non-seasonal) playlists nobody
// reviewed within their window. See core/playlists/review-expiry-tick.ts.
async function tickReviewExpiryPlaylists(): Promise<void> {
  await runReviewExpiryTick({
    getExpiredReviewPlaylists: () => getExpiredReviewPlaylists(db, new Date()),
    removePlaylist: (playlist) => deletePlaylist(db, playlist.id),
    onRemoved: (playlist) => {
      console.log(`[playlists] removed expired pending-review playlist '${playlist.name}'`)
    },
    onRemoveFailed: (playlist, err) => {
      console.error(`[playlists] failed to remove expired playlist '${playlist.name}':`, err)
    },
  })
}

async function restartPlaylistScheduler(): Promise<void> {
  playlistScheduler.stopAll()

  const settings = await getSettings(db)
  // Playlist generation is per-user (each row has its own `enabled` + cron) --
  // the only thing gated globally is the ai_prompt strategy specifically,
  // since it's the one strategy that actually needs AI configured.
  const aiConfigured = Boolean(settings?.aiProvider && settings?.aiModel)

  const playlists = await getEnabledPlaylists(db)
  for (const playlist of playlists) {
    if (!playlist.schedule) continue
    if (playlist.strategy === 'ai_prompt' && !aiConfigured) continue

    playlistScheduler.schedule(`playlist-${playlist.id}`, playlist.schedule, async () => {
      await executePlaylistGeneration(playlist.id)
    })
  }

  playlistScheduler.schedule('seasonal-tick', '0 3 * * *', async () => {
    await tickSeasonalPlaylists()
  })

  playlistScheduler.schedule('review-expiry-tick', '0 4 * * *', async () => {
    await tickReviewExpiryPlaylists()
  })
}

let librarySyncCron: Cron | null = null
let libraryHealthCron: Cron | null = null
let stuckDetectorCron: Cron | null = null
let digestNotifierCron: Cron | null = null
let plexUserSyncCron: Cron | null = null

function restartLibraryMaintenanceScheduler(intervalHours: number): void {
  librarySyncCron?.stop()
  libraryHealthCron?.stop()

  librarySyncCron = startLibrarySyncScheduler({
    intervalHours,
    orchestrator: librarySyncOrchestrator,
    listUserIds: async () => (await listUsers(db)).map((u) => u.id),
    reconcileFulfillment: async (uid) => {
      const { confirmedRequestIds, confirmedRecommendationIds, autoRejectedRecommendationIds } =
        await reconcileFulfillment(db, uid)
      for (const requestId of confirmedRequestIds) {
        realtimeBroker.publish(uid, { type: 'request-confirmed', requestId })
      }
      for (const recommendationId of confirmedRecommendationIds) {
        realtimeBroker.publish(uid, { type: 'recommendation-confirmed', recommendationId })
      }
      // Reuses 'recommendation-confirmed' purely for its client-side effect
      // (invalidate the recommendations query) -- these weren't confirmed,
      // they were auto-rejected as already-owned, but the UI reaction is the
      // same either way: refetch so the stale pending card disappears.
      for (const recommendationId of autoRejectedRecommendationIds) {
        realtimeBroker.publish(uid, { type: 'recommendation-confirmed', recommendationId })
      }
    },
  })
  libraryHealthCron = startLibraryHealthScheduler({
    intervalHours,
    libraryHealth,
  })
}

function buildDigestDeps() {
  return {
    getDigestCron: async () => mergePreferences((await getSettings(db))?.preferences).digestCron,
    getChannels: async () =>
      decryptChannelSecrets(mergePreferences((await getSettings(db))?.preferences).channels ?? []),
    getStats: (since: Date) => jobQueries.getDigestStats(db, since),
    dispatch,
    getLastSentAt: async () => (await getSettings(db))?.digestLastSentAt ?? null,
    setLastSentAt: (at: Date) => updateSettings(db, { digestLastSentAt: at }),
  }
}

async function restartDigestNotifier(): Promise<void> {
  digestNotifierCron?.stop()
  digestNotifierCron = await startDigestNotifier(buildDigestDeps())
}

const TASTE_PROFILE_TTL_MS = 24 * 60 * 60 * 1000 // recomputed at most once/day
const TASTE_PROFILE_EMPTY: TasteProfileCache = { genres: [] }

// "Your Taste" on the dashboard used to tally genres from approved/added
// recommendations -- that's what you've said yes to, not what you actually
// listen to. This instead blends liked tracks + recent Plex plays + recently
// added library albums (buildTrackTasteProfile), deliberately omitting
// request history and popularity (unlike the main recommendation pipeline)
// since the ask was specifically "liked songs, recent history, and
// recently added" -- nothing else.
//
// Computing this fresh on every dashboard load would mean a Plex fetch plus
// an AI call (for the title/reasoning) on every page view, so the result is
// cached on the user row and only recomputed once TASTE_PROFILE_TTL_MS has
// elapsed -- the first-ever call for a user has no cache yet so it populates
// synchronously, then every call after that serves the cache until it's
// stale ("populate immediately, then update periodically").
async function getTasteProfile(userId: number | undefined): Promise<TasteProfileCache> {
  if (!userId) return TASTE_PROFILE_EMPTY

  const user = await getUserById(db, userId)
  const cached = user?.tasteProfileCache ?? null
  const cachedAt = user?.tasteProfileCachedAt?.getTime() ?? 0
  if (cached && Date.now() - cachedAt < TASTE_PROFILE_TTL_MS) {
    return cached
  }

  const settings = await getSettings(db)
  if (!settings) return cached ?? TASTE_PROFILE_EMPTY

  const [userConnections, userPreferences] = await Promise.all([
    getUserConnections(db, userId),
    resolveUserPreferences(db, settings.preferences, userId),
  ])
  const prefs = mergePreferences(userPreferences)

  const registry = new SourceRegistry()
  // Spotify has no listening-history signal for Your Taste anymore -- no
  // per-user connection exists at all (see core/clients/spotify.ts).
  if (
    userConnections?.plexUrl &&
    userConnections?.plexToken &&
    prefs.historySourcesEnabled?.plex !== false
  ) {
    registry.register(
      createPlexSource(
        userConnections.plexUrl,
        userConnections.plexToken,
        userConnections.plexSectionId,
        {
          adminToken: settings.plexAdminToken,
          username: userConnections.username,
        },
      ),
    )
  }

  const sources = registry.all()
  if (sources.length === 0) return cached ?? TASTE_PROFILE_EMPTY

  const [likedResult, recentPlays, recentlyAdded] = await Promise.all([
    collectLikedTracks(sources, 200),
    collectRecentPlays(sources, 200),
    collectRecentlyAdded(sources, 100),
  ])
  const profile = buildTrackTasteProfile(
    likedResult.tracks,
    recentPlays,
    [],
    new Date(),
    undefined,
    undefined,
    recentlyAdded,
  )
  if (profile.signals.length === 0) return cached ?? TASTE_PROFILE_EMPTY

  const genresByArtist = await getArtistGenresByNames(
    db,
    profile.signals.map((s) => s.artistName),
  )

  const weightByGenre = new Map<string, number>()
  for (const signal of profile.signals) {
    const genres = genresByArtist.get(signal.artistName.trim().toLowerCase())
    if (!genres) continue
    for (const genre of genres) {
      weightByGenre.set(genre, (weightByGenre.get(genre) ?? 0) + signal.weight)
    }
  }
  if (weightByGenre.size === 0) return cached ?? TASTE_PROFILE_EMPTY

  const totalWeight = [...weightByGenre.values()].reduce((sum, w) => sum + w, 0)
  const genres = [...weightByGenre.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([genre, weight]) => ({
      genre,
      count: Math.round(weight),
      percentage: totalWeight > 0 ? Math.round((weight / totalWeight) * 100) : 0,
    }))

  // Which signal type(s) put each artist in the picture, for the AI prompt's
  // reasoning context -- deduped by artist since `profile.signals` is
  // deduped per track/album, not per artist, so the same artist can appear
  // several times in a row (once per liked/recent/added track).
  const signalTypesByArtist = new Map<string, Set<string>>()
  for (const signal of profile.signals) {
    const key = signal.artistName.trim().toLowerCase()
    if (!signalTypesByArtist.has(key)) signalTypesByArtist.set(key, new Set())
    signalTypesByArtist.get(key)?.add(signal.signalType)
  }
  const topArtists: { name: string; signalTypes: string[] }[] = []
  const seenArtists = new Set<string>()
  for (const signal of profile.signals) {
    const key = signal.artistName.trim().toLowerCase()
    if (seenArtists.has(key)) continue
    seenArtists.add(key)
    topArtists.push({
      name: signal.artistName,
      signalTypes: [...(signalTypesByArtist.get(key) ?? [])],
    })
    if (topArtists.length >= 10) break
  }

  let title: string | undefined
  let reasoning: string | undefined
  if (settings.aiProvider && settings.aiModel) {
    try {
      const provider = await providerRegistry.create(settings.aiProvider, {
        apiKey: settings.aiApiKey ?? null,
        model: settings.aiModel,
        baseUrl: settings.aiBaseUrl ?? null,
        timeoutSeconds: envConfig.aiTimeoutSeconds ?? null,
      })
      const prompt = buildTasteProfilePrompt(genres, topArtists)
      const recs = await provider.getRecommendations({
        topArtists: [],
        topGenres: [],
        listeningPatterns: { totalListens: 0, recentTrend: 'stable' },
        _rawPrompt: prompt,
      })
      const first = recs[0]
      if (first) {
        title = first.artistName
        reasoning = first.reasoning
      }
    } catch (err) {
      console.warn('[taste-profile] AI title/reasoning generation failed:', errMsg(err))
    }
  }

  const result: TasteProfileCache = { genres, title, reasoning }
  await updateTasteProfileCache(db, userId, result)
  return result
}

const appDeps: AppDependencies = {
  db,
  storeDb,
  orchestrator,
  scheduler,
  providerRegistry,
  isSetupComplete: () => isSetupComplete(db),
  getSettings: () => getSettings(db),
  updateSettings: (partial) => updateSettings(db, partial),
  completeSetup: (config) => completeSetup(db, config),
  getLastBatch: async () => {
    const batches = await listBatches(db)
    return batches[0] ?? null
  },
  listRecommendations: (filters) => listRecommendations(db, filters),
  getRecommendation: (id) => getRecommendation(db, id),
  updateRecommendationStatus: (id, status, extra) =>
    updateRecommendationStatus(db, id, status, extra),
  rejectRecommendation: (params) => rejectRecommendation(db, params),
  listArtistBlocks: (params) => listArtistBlocksQuery(db, params),
  removeArtistBlock: (params) => removeArtistBlockQuery(db, params),
  addArtistBlock: (params) =>
    addArtistBlockQuery(db, {
      userId: params.userId,
      artistId: params.artistId,
      reason: params.reason ?? null,
      reasonText: params.reasonText ?? null,
      source: 'manual',
    }),
  listAlbumBlocks: (userId) => listAlbumBlocksQuery(db, userId),
  removeAlbumBlock: (params) => removeAlbumBlockQuery(db, params),
  bulkUpdateStatus: (ids, status) => bulkUpdateStatus(db, ids, status),
  bulkDelete: (ids) => bulkDelete(db, ids),
  filterOwnedIds: (ids, userId) => filterOwnedIds(db, ids, userId),
  listBatches: (opts?: Parameters<typeof listBatches>[1]) => listBatches(db, opts),
  getBatch: (id) => getBatch(db, id),
  getArtistById: (id) => getArtistById(db, id),
  restartScheduler: (cron: string | null) => {
    if (!cron) {
      scheduler.remove('main-pipeline')
      console.log('Scheduler stopped')
      return
    }
    scheduler.schedule('main-pipeline', cron, runPipeline)
    console.log(`Scheduler restarted with cron: ${cron}`)
  },
  restartPlaylistScheduler,
  restartLibraryMaintenanceScheduler,
  restartDigestNotifier,
  createUser: (data) => createUser(db, data),
  getUserByUsername: (username) => getUserByUsername(db, username),
  getUserById: (id) => getUserById(db, id),
  getUserCount: () => getUserCount(db),
  updateUser: (id, data) => updateUser(db, id, data),
  listUsers: (opts?: Parameters<typeof listUsers>[1]) => listUsers(db, opts),
  getLastSignInByUser: () => getLastSignInByUser(db),
  deleteUser: (id) => deleteUser(db, id),
  genreService,
  libraryHealth,
  skyhookWarmer,
  librarySync: librarySyncOrchestrator,
  librarySyncStore,
  albumCoverage,
  handleLibraryWebhookEvent,
  getFeedbackHistory: (userId) => getGenreFeedbackHistory(db, userId),
  dashboardQueries: {
    getTasteProfile,
    getLatestGenreCoverage: (userId) => getLatestGenreCoverage(db, userId),
    getRecentActivity: (userId, isAdmin, limit) => getRecentActivity(db, userId, isAdmin, limit),
  },
  jobRecorder,
  jobQueries: {
    listJobs: (filters) => jobQueries.listJobs(db, filters),
    getJobById: (id) => jobQueries.getJobById(db, id),
    getJobHealth: (nextRun) => jobQueries.getJobHealth(db, nextRun),
  },
  getEnabledTargetsForUser: (userId) => getEnabledTargetsForResolvedUser(userId),
  playlistDeps: {
    db,
    playlistScheduler,
    runPlaylistGeneration: (playlistId) => executePlaylistGeneration(playlistId),
    pushPendingReviewPlaylist: (playlistId) => pushPendingReviewPlaylist(playlistId),
    restartPlaylistScheduler,
    generateAiPlaylistPreview: (userId, prompt, size, options) =>
      generateAiPlaylistPreview(userId, prompt, size, options),
    previewPlaylistFilterCount: (userId, filters) => previewPlaylistFilterCount(userId, filters),
    duplicatePlaylist: (playlistId, name) => executePlaylistDuplicate(playlistId, name),
    sweepLiveTracks: (playlistId) => sweepLiveTracksInPlaylist(playlistId),
    listMissingTracks: (playlistId) => listMissingTracksWithResolution(playlistId),
    deleteMissingTrack: (playlistId, id) => deletePlaylistMissingTrack(db, playlistId, id),
    removePlaylistTrack,
    addPlaylistTrack,
    getPlaylistSuggestions: (playlistId) => getPlaylistSuggestions(playlistId),
    getUserById: (id) => getUserById(db, id),
  },
}
const app = createApp(appDeps)

const port = envConfig.port
const server = serve({ fetch: app.fetch, port })

// Auto-complete setup from env vars, then bootstrap user, then start scheduler
;(async () => {
  try {
    const done = await isSetupComplete(db)
    if (!done && canAutoSetup()) {
      const config: SetupConfig = {
        lidarrUrl: envConfig.lidarrUrl ?? '',
        lidarrApiKey: envConfig.lidarrApiKey ?? '',
        skipTlsVerify: envConfig.skipTlsVerify,
        aiProvider: envConfig.aiProvider,
        aiApiKey: envConfig.aiApiKey,
        aiModel: envConfig.aiModel,
        aiBaseUrl: envConfig.aiBaseUrl,
      }
      if (envConfig.webhookUrl) {
        config.preferences = { ...DEFAULT_PREFERENCES, webhookUrl: envConfig.webhookUrl }
      }
      await completeSetup(db, config)
      console.log('Setup auto-completed from environment variables')
    }

    // Backfill: keep the system Lidarr target (see db/queries/targets.ts) in
    // sync with settings for existing installations, including ones still on
    // the old per-user manual target model.
    const settings = await getSettings(db)
    if (settings?.lidarrUrl && settings?.lidarrApiKey) {
      const systemLidarrTarget = await getSystemTarget(db, 'lidarr')
      if (!systemLidarrTarget) {
        await upsertSystemTarget(db, 'lidarr', 'Lidarr', {
          url: settings.lidarrUrl as string,
          apiKey: settings.lidarrApiKey as string,
          skipTlsVerify: (settings.skipTlsVerify as boolean) ?? false,
        })
        console.log(
          '[boot] Created system Lidarr target from existing settings (migration backfill)',
        )
      }
    }

    // Start schedulers - single getSettings() call shared across all
    const prefs = mergePreferences(settings?.preferences)
    const cron = prefs.scheduleCron
    if (cron) {
      scheduler.schedule('main-pipeline', cron, runPipeline)
      console.log(`Scheduler started with cron: ${cron}`)
    }

    await restartPlaylistScheduler()

    void backfillImportedPlaylistArt().catch((err) =>
      console.error('[playlist-art] Backfill failed:', err),
    )

    // Library maintenance schedulers - background, idempotent. Boot fire is non-blocking.
    restartLibraryMaintenanceScheduler(librarySyncIntervalHours)
    // Fire one sync + health scan at boot so fresh installs don't wait for the first cron tick.
    void librarySyncOrchestrator
      .syncGlobal()
      .catch((err) => console.error('[boot] initial library syncGlobal failed:', err))
    libraryHealth.startScan()

    // Scheduled artist-image cache warming for Listening Activity -- resolves
    // images for reconciled library artists through the same AudioDB/Lidarr/
    // fanart/musicinfo chain the discovery pipeline uses, so the dashboard
    // normally just reads a warm cache instead of live-calling on page load.
    // 15min offset after the library-sync cadence so newly-reconciled MBIDs
    // are already in library_artists by the time this runs.
    const runArtistImageBackfillTick = async () => {
      const result = await runArtistImageBackfill({
        db,
        getSettings: () => getSettings(db),
        tryConsumeRateLimit: storeDb.tryConsumeRateLimit,
      })
      if (!result.skipped && result.attempted > 0) {
        console.log(
          `[artist-image-backfill] attempted=${result.attempted} updated=${result.updated} failed=${result.failed}`,
        )
      }
    }
    scheduler.schedule('artist-image-backfill', '15 */6 * * *', runArtistImageBackfillTick)
    void runArtistImageBackfillTick().catch((err) =>
      console.error('[boot] initial artist image backfill failed:', err),
    )

    // Mirrors Plex's server-sharing list into DJ Llama accounts (add/remove
    // automatically) -- same 6h cadence as the library maintenance jobs, plus
    // a manual "Sync now" in Settings > Users for immediate reconciliation.
    plexUserSyncCron = new Cron('0 */6 * * *', async () => {
      if (isMaintenance()) return
      try {
        const result = await syncPlexServerUsers(db)
        if (result.error) {
          console.warn('[plex-user-sync] tick skipped:', result.error)
        } else if (result.added || result.updated || result.revoked) {
          console.log(
            `[plex-user-sync] added=${result.added} updated=${result.updated} revoked=${result.revoked}`,
          )
        }
      } catch (err) {
        console.error('[plex-user-sync] tick failed:', err)
      }
    })
    void syncPlexServerUsers(db).catch((err) =>
      console.error('[boot] initial Plex user sync failed:', err),
    )

    stuckDetectorCron = startStuckDetector(jobRecorder)

    // Start scheduled notification digest (no-op until digestCron is configured)
    digestNotifierCron = await startDigestNotifier(buildDigestDeps())
  } catch (err: unknown) {
    console.error('Failed to initialize:', err)
  }
})()

// Clean up expired sessions every 6 hours
setInterval(
  async () => {
    if (isMaintenance()) return
    try {
      await sessionQueries(db).deleteExpired()
    } catch {
      /* best-effort cleanup */
    }
  },
  6 * 60 * 60 * 1000,
)

console.log(`DJ Llama running on http://localhost:${port}`)
if (!envConfig.allowedOrigin && process.env.NODE_ENV === 'production') {
  console.warn(
    'ALLOWED_ORIGIN not set - CORS rejects all cross-origin requests. Set ALLOWED_ORIGIN to your domain.',
  )
}
if (envConfig.authToken && envConfig.authToken.length < 16) {
  console.warn(
    'DJLLAMA_AUTH_TOKEN is shorter than 16 characters - this is trivially brute-forceable. Use a longer token.',
  )
}
if (envConfig.authToken) {
  console.warn(
    'DEPRECATED: DJLLAMA_AUTH_TOKEN provides read-only access with no admin privileges, no per-user features, and no audit trail. Create a user account instead.',
  )
}

// Graceful shutdown - flip readiness, drain, wait for in-flight work, exit
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, async () => {
    console.log(`${signal} received, shutting down...`)
    // Flip /health to 503 so any health-checking proxy stops routing traffic
    // here, then wait long enough for it to observe draining before closing
    // the server so in-flight requests finish on the listener we still own.
    markShuttingDown()
    setMaintenance(true)
    await new Promise((resolve) => setTimeout(resolve, 12_000))
    scheduler.stopAll()
    playlistScheduler.stopAll()
    stuckDetectorCron?.stop()
    digestNotifierCron?.stop()
    librarySyncCron?.stop()
    libraryHealthCron?.stop()
    plexUserSyncCron?.stop()
    server.close()
    // Hard deadline: exit no matter what after 30s
    const deadline = setTimeout(() => {
      console.warn('Shutdown deadline exceeded, forcing exit')
      process.exit(1)
    }, 30_000)
    deadline.unref()
    // Wait for pipeline to finish if running (up to 25s)
    if (orchestrator.isRunning) {
      console.log('Waiting for pipeline to finish...')
      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (!orchestrator.isRunning) {
            clearInterval(check)
            resolve()
          }
        }, 500)
        setTimeout(() => {
          clearInterval(check)
          resolve()
        }, 25_000)
      })
    }
    await waitForGenreWarmers()
    await waitForImageBackfill()
    await closeDb()
    clearTimeout(deadline)
    process.exit(0)
  })
}
