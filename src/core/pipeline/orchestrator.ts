import { EventEmitter } from 'node:events'
import { envConfig } from '@/config/env'
import { createLastFmClient } from '@/core/clients/lastfm'
import { createMusicBrainzClient } from '@/core/clients/musicbrainz'
import { decryptChannelSecrets } from '@/core/crypto'
import { recordFailureSafely } from '@/core/jobs/record-failure-safely'
import { dispatch, logDispatchFailures } from '@/core/notifications'
import { createPlexSource } from '@/core/plugins/plex'
import { LISTENING_SOURCE_IDS, SourceRegistry } from '@/core/plugins/registry'
import type { AiProviderRegistry } from '@/core/providers/registry'
import type { SimilarTrackProvider } from '@/core/similarity/providers'
import { errMsg } from '@/core/validation'
import type { UserConnections } from '@/db/queries/users'
import { mergePreferences, type Preferences } from '@/db/schema'
import { analyze } from './analyze'
import { type AutoApproveDeps, autoApprove } from './auto-approve'
import { collectLikedTracks, collectRecentPlays } from './collect-tracks'
import { discover } from './discover'
import { artistPicksToTracks, discoverSimilarTracks } from './discover-tracks'
import { enrichGenres } from './enrich'
import { filter } from './filter'
import { type GenreBackfillDb, hydrateArtistGenres, warmArtistGenres } from './genre-backfill'
import { createArtistImageClients } from './image-clients'
import { mergeTrackResolutions, resolve, resolveTrackToAlbum } from './resolve'
import { score } from './score'
import type { StoreDb } from './store'
import { store } from './store'
import { buildTrackTasteProfile } from './track-taste'

export interface PipelineSettings {
  lidarrUrl: string | null
  lidarrApiKey: string | null
  // Server-owner token -- required to read any managed/shared user's Plex
  // watch history (see the Plex registration block below); the regular
  // per-user plexToken can't see it, even for that user's own plays.
  plexAdminToken?: string | null
  aiProvider: string | null
  aiApiKey: string | null
  aiModel: string | null
  aiBaseUrl: string | null
  preferences: Preferences | null
  skipTlsVerify?: boolean
  audiodbApiKey?: string | null
  lastfmApiKey?: string | null
}

export interface PipelineDeps {
  db: StoreDb
  settings: PipelineSettings
  userId: number
  providerRegistry?: AiProviderRegistry
  userConnections?: UserConnections | null
  autoApproveDeps?: AutoApproveDeps | null
  jobRecorder?: import('@/core/jobs/types').JobRecorder
  trigger?: 'scheduled' | 'manual'
  /** Similar-track lookups (see buildSimilarityProviders); none when omitted. */
  similarityProviders?: SimilarTrackProvider[]
  // Only needed for the per-user recommendations_available notification below --
  // optional so partial StoreDb-style mocks in tests still work without it.
  getUserById?: (id: number) => Promise<{ preferences?: Preferences | null } | null>
  librarySync: {
    syncForUser: (
      userId: number,
      options?: {
        force?: boolean
        onProgress?: (msg: string, itemProgress?: { current: number; total: number }) => void
      },
    ) => Promise<unknown>
  }
}

export type AlbumFilterSets = {
  blockedArtistMbids: Set<string>
  blockedAlbumKeys: Set<string>
  existingAlbumRgs: Set<string>
}

/**
 * Pure predicate: should an album-kind candidate be dropped from the pipeline?
 * Drops when its artist is blocked (cascade), the album itself is blocked, or
 * the album release group is already recommended. No IO.
 */
export function shouldDropAlbumCandidate(
  candidate: { artistMbid: string; releaseGroupMbid: string },
  sets: AlbumFilterSets,
): boolean {
  return (
    sets.blockedArtistMbids.has(candidate.artistMbid) ||
    sets.blockedAlbumKeys.has(candidate.releaseGroupMbid) ||
    sets.existingAlbumRgs.has(candidate.releaseGroupMbid)
  )
}

interface QueuedRun {
  userId: number | undefined
  deps: PipelineDeps
}

export type EnqueueResult = {
  status: 'started' | 'queued' | 'duplicate'
  position: number
}

export class PipelineOrchestrator extends EventEmitter {
  private running = false
  private currentStage: string | null = null
  private currentMessage: string | null = null
  private _currentUserId: number | undefined = undefined
  private queue: QueuedRun[] = []

  override emit(eventName: string | symbol, ...args: unknown[]): boolean {
    if (eventName === 'progress') {
      const progress = args[0] as { stage?: string; message?: string } | undefined
      if (progress?.stage) this.currentStage = progress.stage
      if (progress?.message) this.currentMessage = progress.message
      // Inject userId so SSE clients can filter events
      if (progress && this._currentUserId !== undefined) {
        ;(progress as Record<string, unknown>).userId = this._currentUserId
      }
    }
    return super.emit(eventName, ...args)
  }

  async run(deps: PipelineDeps): Promise<{ batchId: number }> {
    if (this.running) throw new Error('Pipeline already running')
    this.running = true
    this.currentStage = null
    this.currentMessage = null
    this._currentUserId = deps.userId

    let jobId: number | null = null

    try {
      const { db, settings, providerRegistry } = deps
      // Merge with defaults so partially-saved preferences don't leave fields undefined
      const prefs: Preferences = mergePreferences(settings.preferences)

      if (deps.jobRecorder) {
        try {
          jobId = await deps.jobRecorder.start({
            type: 'pipeline',
            userId: deps.userId,
            metadata: { trigger: deps.trigger ?? 'manual' },
          })
        } catch (err) {
          console.error('[pipeline] Failed to record job start:', err)
        }
      }

      const { audiodbClient, lidarrClient, fanartClient, musicinfoClient } =
        createArtistImageClients({
          settings,
          preferences: prefs,
          tryConsumeRateLimit: db.tryConsumeRateLimit,
        })

      // Listening connections are always user-scoped.
      const { userConnections } = deps

      const registry = new SourceRegistry()

      // Spotify and Deezer have no listening-history equivalent to register --
      // neither has a per-user OAuth connection that can be established
      // anymore (Spotify: see core/clients/spotify.ts; Deezer: app
      // registration is closed, so no fresh OAuth credentials can exist).

      // Plex
      const plexUrl = userConnections?.plexUrl
      const plexToken = userConnections?.plexToken
      if (plexUrl && plexToken && prefs.historySourcesEnabled?.plex !== false) {
        registry.register(
          createPlexSource(plexUrl, plexToken, userConnections?.plexSectionId, {
            adminToken: settings.plexAdminToken,
            username: userConnections?.username,
          }),
        )
      }

      const aiProvider =
        providerRegistry && settings.aiProvider && settings.aiModel
          ? await providerRegistry.create(settings.aiProvider, {
              apiKey: settings.aiApiKey ?? null,
              model: settings.aiModel,
              baseUrl: settings.aiBaseUrl ?? null,
              timeoutSeconds: envConfig.aiTimeoutSeconds ?? null,
            })
          : null

      // Recommendations require AI to turn raw listening/library signal into
      // curated, album-level suggestions -- this is normally already enforced
      // by the ai_required gate on the HTTP routes (pipeline.ts), but the
      // scheduled cron run (index.ts's runPipeline) calls orchestrator.run()
      // directly and would otherwise bypass it entirely.
      if (!aiProvider) {
        throw new Error('An AI provider must be configured to generate recommendations')
      }

      if (
        deps.userId === undefined ||
        deps.librarySync === undefined ||
        typeof db.getLibraryArtistsForUser !== 'function' ||
        typeof db.userHasOwnSyncState !== 'function'
      ) {
        throw new Error(
          'Pipeline orchestrator requires librarySync, userId, and library StoreDb methods',
        )
      }

      const mbClient = createMusicBrainzClient()

      this.emit('progress', { stage: 'collect', message: 'Loading your library...' })

      const userIdForSync = deps.userId
      // Own states only: a global (userId=null) sync state must not mask a
      // user whose personal sources never synced, or their slow first sync
      // would run awaited instead of in the background.
      const hasOwnState = await db.userHasOwnSyncState(userIdForSync)
      if (!hasOwnState) {
        // First-sync detection: fire-and-forget so the pipeline doesn't hang
        // for the slow MB lookups on a fresh install.
        void deps.librarySync
          .syncForUser(userIdForSync)
          .catch((err: unknown) => console.error('[pipeline] first library sync failed:', err))
        this.emit('progress', {
          stage: 'collect',
          message: 'First library sync running in background -- proceeding without it',
        })
      } else {
        await deps.librarySync.syncForUser(userIdForSync, {
          onProgress: (msg, itemProgress) =>
            this.emit('progress', {
              stage: 'collect',
              message: msg,
              ...(itemProgress ? { current: itemProgress.current, total: itemProgress.total } : {}),
            }),
        })
      }

      const libraryArtists = await db.getLibraryArtistsForUser(userIdForSync, {
        onlyReconciled: true,
      })
      const libraryMbids = new Set(
        libraryArtists.map((a) => a.mbid).filter((m): m is string => m !== null),
      )
      const libraryGenres = [...new Set(libraryArtists.flatMap((a) => a.genres ?? []))]
      const librarySeeds = libraryArtists
        .filter((a): a is typeof a & { mbid: string } => a.mbid !== null)
        .map((a) => ({ mbid: a.mbid, name: a.name }))

      const genreDb: GenreBackfillDb | null =
        db.getArtistGenreCacheByMbids &&
        db.getArtistGenreCacheByAliases &&
        db.upsertArtistGenres &&
        db.upsertArtistGenreAlias
          ? {
              getArtistGenreCacheByMbids: db.getArtistGenreCacheByMbids,
              getArtistGenreCacheByAliases: db.getArtistGenreCacheByAliases,
              upsertArtistGenres: db.upsertArtistGenres,
              upsertArtistGenreAlias: db.upsertArtistGenreAlias,
            }
          : null
      const genreLibraryArtists = genreDb
        ? await db.getLibraryArtistsForUser(userIdForSync)
        : libraryArtists

      const sourceCount = new Set(libraryArtists.map((a) => a.source)).size
      this.emit('progress', {
        stage: 'collect',
        message: `Loaded ${libraryMbids.size} library artists across ${sourceCount} ${
          sourceCount === 1 ? 'source' : 'sources'
        }`,
      })

      const rejectedMbids = await db.getRejectedMbids(prefs.rejectionCooldownDays)
      const blockedMbids = await db.getBlockedMbids(userIdForSync)
      const feedbackHistory = await db.getFeedbackHistory(userIdForSync)

      this.emit('progress', { stage: 'analyze', message: 'Building your taste profile...' })
      const tasteProfile = await analyze(
        registry.all(),
        genreDb
          ? {
              genreHydrator: (artists) =>
                hydrateArtistGenres(artists, genreDb, genreLibraryArtists),
            }
          : {},
      )
      this.emit('progress', {
        stage: 'analyze',
        message: `Profiled ${tasteProfile.topArtists.length} top artists, ${tasteProfile.topGenres.length} genres`,
      })
      console.log(
        `[debug-diag] taste profile: ${tasteProfile.topArtists.length} top artists, ${tasteProfile.topGenres.length} top genres`,
      )

      this.emit('progress', {
        stage: 'discover',
        message: 'Finding similar artists from all sources...',
      })
      const discoverFailures = new Map<string, string>()
      const similarity = deps.similarityProviders ?? []
      const lastfmClient = settings.lastfmApiKey ? createLastFmClient(settings.lastfmApiKey) : null
      const discovered = await discover(
        tasteProfile,
        {
          listeningSources: registry.all(),
          ai: aiProvider,
        },
        prefs.topArtistsLimit,
        librarySeeds,
        prefs.librarySeedRatio ?? 0.3,
        {
          onSourceFailure: (sourceId, error) => discoverFailures.set(sourceId, error),
        },
      )
      const aiFailure = discoverFailures.get('ai')
      if (aiFailure) {
        this.emit('progress', {
          stage: 'discover',
          message: `AI provider failed: ${aiFailure} - continuing without AI suggestions`,
        })
      }
      console.log(
        `[debug-diag] discover() returned ${discovered.length} candidates; ai configured=${aiProvider != null}; aiFailure=${aiFailure ?? 'none'}`,
      )
      this.emit('progress', {
        stage: 'discover',
        message: `Discovered ${discovered.length} candidate artists`,
      })

      // Collect per-source results for job recording
      const sourceResults: Record<string, import('@/core/jobs/types').SourceResult> = {}

      // Mark unconfigured (or user-disabled) sources as skipped
      for (const id of LISTENING_SOURCE_IDS) {
        if (!registry.all().some((s) => s.id === id)) {
          const disabled = id === 'plex' && prefs.historySourcesEnabled?.plex === false
          sourceResults[id] = {
            status: 'skipped',
            reason: disabled ? 'disabled_by_user' : 'not_configured',
          }
        }
      }
      if (!aiProvider) {
        sourceResults.ai = { status: 'skipped', reason: 'not_configured' }
      }
      if (!similarity.some((p) => p.id === 'lastfm')) {
        sourceResults.lastfm = { status: 'skipped', reason: 'not_configured' }
      }

      // Tally source contributions from discovered artists
      const sourceArtistCounts = new Map<string, number>()
      for (const d of discovered) {
        const src = d.source ?? 'unknown'
        sourceArtistCounts.set(src, (sourceArtistCounts.get(src) ?? 0) + 1)
      }
      for (const source of registry.all()) {
        // History-only sources (Plex) feed the taste profile's seed artists,
        // not candidates -- judge them on that, or they always read as failing.
        if (!sourceResults[source.id] && !source.capabilities.includes('similarArtists')) {
          const seeds = tasteProfile.topArtists.filter((a) => a.source === source.id).length
          sourceResults[source.id] =
            seeds > 0
              ? { status: 'ok', role: 'history', artists: seeds }
              : { status: 'error', role: 'history', error: 'No listening history returned' }
          continue
        }
        if (!sourceResults[source.id]) {
          const count = sourceArtistCounts.get(source.id) ?? 0
          sourceResults[source.id] =
            count > 0
              ? { status: 'ok', artists: count }
              : {
                  status: 'error',
                  error: discoverFailures.get(source.id) ?? 'No artists returned',
                }
        }
      }
      if (aiProvider) {
        const aiCount = sourceArtistCounts.get('ai') ?? 0
        sourceResults.ai =
          aiCount > 0
            ? { status: 'ok', artists: aiCount }
            : { status: 'error', error: aiFailure ?? 'No artists returned' }
      }

      // Gap-fill: studio albums missing from artists already in the user's
      // library (owned artist, unowned album). Runs as its own parallel
      // branch, feeding the same resolve()/score()/filter()/store() tail
      // rather than a separate path, since resolve() already special-cases
      // album-kind discoveries that arrive with a releaseGroupMbid pre-set
      // (see resolve.ts:55-58).
      const gapFillPromise = (async () => {
        try {
          return (await deps.db.getGapFillCandidates?.(deps.userId, 25)) ?? []
        } catch (err) {
          console.warn('[pipeline] gap-fill discovery failed, continuing without it:', err)
          return []
        }
      })()

      // Track-based discovery: a parallel branch alongside the artist-
      // similarity path above, feeding the same resolve/score/filter/store
      // tail. Kicked off here so it overlaps with the artist-path resolve()
      // call below rather than adding to the pipeline's latency serially.
      // Wrapped in its own try/catch (on top of every internal call already
      // degrading gracefully) so a user with zero track-level signal --  or
      // any unexpected failure in this still-new path -- falls back to
      // today's artist-similarity behavior with no special-case code needed.
      const trackDiscoveryPromise = (async () => {
        try {
          const [likedTracksResult, plexWebhookPlays] = await Promise.all([
            collectLikedTracks(registry.all()),
            deps.userId != null && db.getRecentPlexScrobbles
              ? db.getRecentPlexScrobbles(deps.userId, 100)
              : Promise.resolve([]),
          ])
          const recentPlays = await collectRecentPlays(registry.all(), 100, plexWebhookPlays)
          const requestHistory =
            deps.userId != null && db.getRequestHistoryForUser
              ? await db.getRequestHistoryForUser(deps.userId, 50)
              : []
          const trackTasteProfile = buildTrackTasteProfile(
            likedTracksResult.tracks,
            recentPlays,
            requestHistory,
            new Date(),
            tasteProfile,
          )

          const similarFailures = new Map<string, string>()
          const discoveredTracks = await discoverSimilarTracks(
            trackTasteProfile,
            { ai: aiProvider, similar: similarity },
            {
              libraryArtists: librarySeeds,
              onSourceFailure: (id, error) => similarFailures.set(id, error),
              onSourceResults: (id, count) => {
                sourceResults[id] =
                  count > 0
                    ? { status: 'ok', role: 'tracks', artists: count }
                    : {
                        status: 'error',
                        role: 'tracks',
                        error: similarFailures.get(id) ?? 'No similar tracks found',
                      }
              },
            },
          )
          console.log(
            `[debug-diag] discoverSimilarTracks() returned ${discoveredTracks.length} track candidates`,
          )

          const trackResolutions = await Promise.all(
            discoveredTracks.map((track) =>
              resolveTrackToAlbum(
                track,
                mbClient,
                audiodbClient,
                lidarrClient,
                fanartClient,
                musicinfoClient,
              ),
            ),
          )
          return trackResolutions.filter((r): r is NonNullable<typeof r> => r !== null)
        } catch (err) {
          console.warn(
            '[pipeline] track-based discovery failed, continuing with artist-similarity only:',
            err,
          )
          return []
        }
      })()

      const gapFillCandidates = await gapFillPromise
      console.log(
        `[debug-diag] gap-fill discovery found ${gapFillCandidates.length} missing-album candidates`,
      )

      // Albums are always chosen through a track: each AI artist pick names
      // the song to start with (or gets the artist's top Last.fm track), and
      // that song's album is what's recommended -- same path as the track
      // branch. Only gap-fill candidates (a specific missing album by an
      // artist you own) go through resolve() below.
      const artistPickTracks = await artistPicksToTracks(
        discovered,
        lastfmClient ? (name, mbid) => lastfmClient.getTopTracks(name, mbid, 3) : null,
      )
      this.emit('progress', {
        stage: 'resolve',
        message: `Finding albums for ${artistPickTracks.length + gapFillCandidates.length} picks via MusicBrainz...`,
      })
      const artistPickResolved = (
        await Promise.all(
          artistPickTracks.map((track) =>
            resolveTrackToAlbum(
              track,
              mbClient,
              audiodbClient,
              lidarrClient,
              fanartClient,
              musicinfoClient,
            ),
          ),
        )
      ).filter((r): r is NonNullable<typeof r> => r !== null)
      const rawResolved = await resolve(
        gapFillCandidates,
        mbClient,
        (progress) => {
          this.emit('progress', progress)
        },
        lidarrClient,
        fanartClient,
        musicinfoClient,
        audiodbClient,
        // Recommendations are album-focused end to end now that AI is
        // required to reach this feature at all (see auth-status's
        // aiRequired gate) -- every candidate resolves to a specific album
        // or gets dropped below, never surfaced as a bare artist.
        true,
      )
      const trackResolved = await trackDiscoveryPromise

      // Enrich sparse genres from artist_metadata (if available), then drop
      // anything that still didn't resolve to a specific album (no AI
      // suggestion matched, and the artist has no Album/EP in MusicBrainz at
      // all) rather than falling back to an artist-level recommendation.
      // mergeTrackResolutions also combines any artist-path and track-path
      // candidates that landed on the exact same (artist, release-group) --
      // e.g. the artist-similarity and track-similarity AI passes both
      // independently pointing at the same album -- into one candidate with
      // both `discoveries` entries, so score()'s existing consensus calc applies.
      const resolved = (
        await enrichGenres(
          mergeTrackResolutions([...rawResolved, ...artistPickResolved, ...trackResolved]),
          db.lookupArtistMetadata ?? null,
        )
      ).filter((a) => a.kind === 'album' && a.releaseGroupMbid)

      this.emit('progress', {
        stage: 'score',
        message: `Scoring ${resolved.length} resolved artists...`,
      })
      const popularityMap = (await db.getPopularityMap?.()) ?? new Map<string, number>()
      const referenceGenres =
        libraryGenres.length > 0 ? libraryGenres : tasteProfile.topGenres.map((g) => g.name)
      const scored = score(
        resolved,
        referenceGenres,
        prefs.scoringWeights,
        feedbackHistory,
        popularityMap,
      )

      this.emit('progress', {
        stage: 'filter',
        message: `Filtering ${scored.length} scored artists...`,
      })
      const existingMbids = await db.getExistingRecommendationMbids(deps.userId)
      for (const mbid of existingMbids) {
        libraryMbids.add(mbid)
      }

      // Album-aware block/dedup sets. Album-kind candidates flow through this
      // stage to drop blocked albums and ones already in the library. Guarded so
      // partial StoreDb mocks without these optional methods still work.
      const albumSets: AlbumFilterSets = {
        blockedArtistMbids: blockedMbids,
        blockedAlbumKeys: (await db.getBlockedAlbumKeys?.(deps.userId)) ?? new Set<string>(),
        existingAlbumRgs:
          (await db.getExistingAlbumReleaseGroupMbids?.(deps.userId)) ?? new Set<string>(),
      }
      const albumAware = scored.filter((c) => {
        // Not an album candidate -> keep; the artist filter path handles it.
        if (c.kind !== 'album' || !c.releaseGroupMbid) return true
        return !shouldDropAlbumCandidate(
          { artistMbid: c.mbid, releaseGroupMbid: c.releaseGroupMbid },
          albumSets,
        )
      })

      // Also exclude top artists from listening history - the AI prompt asks
      // models to skip these, but smaller models ignore the instruction.
      const topArtistNames = new Set<string>()
      for (const artist of tasteProfile.topArtists) {
        topArtistNames.add(artist.name.toLowerCase())
        if (artist.mbid) libraryMbids.add(artist.mbid)
      }

      // Album-kind candidates bypass the artist-existence filters (library /
      // top-artists): release-radar targets artists you already track, so those
      // filters would drop every album. They already passed the album block/dedup
      // layer above; here they only face the score threshold. Artist-kind
      // candidates take the full artist filter unchanged.
      const albumKind = albumAware.filter((c) => c.kind === 'album' && c.releaseGroupMbid)
      const artistKind = albumAware.filter((c) => !(c.kind === 'album' && c.releaseGroupMbid))

      const filteredArtists = filter(
        artistKind,
        libraryMbids,
        rejectedMbids,
        blockedMbids,
        prefs.rejectionCooldownDays,
        prefs.scoreThreshold,
        topArtistNames,
      )
      const filteredAlbums = albumKind.filter((c) => c.score >= prefs.scoreThreshold)
      const filtered = [...filteredArtists, ...filteredAlbums]

      this.emit('progress', {
        stage: 'store',
        message: `Saving ${filtered.length} recommendations...`,
      })
      const batchId = await store(filtered, db, {
        userId: deps.userId,
      })

      // Auto-approve if enabled
      if (prefs.autoApproveEnabled && deps.autoApproveDeps) {
        const autoConfig = {
          threshold: prefs.autoApproveThreshold ?? 0.8,
          monitorOption:
            prefs.autoApproveMonitorOption === 'all' || prefs.autoApproveMonitorOption === 'new'
              ? prefs.autoApproveMonitorOption
              : ('recommended' as const),
          qualityProfileId: prefs.qualityProfileId,
          metadataProfileId: prefs.metadataProfileId,
          rootFolderId: prefs.rootFolderId,
        }
        this.emit('progress', {
          stage: 'store',
          message: `Auto-requesting above ${Math.round(autoConfig.threshold * 100)}%...`,
        })
        const autoResult = await autoApprove(batchId, autoConfig, deps.autoApproveDeps)
        if (autoResult.approved > 0 || autoResult.failed > 0) {
          console.log(`Auto-approve: ${autoResult.approved} added, ${autoResult.failed} failed`)
        }
      }

      // Fire-and-forget notification dispatch
      dispatch(decryptChannelSecrets(prefs.channels ?? []), 'batch_complete', {
        event: 'batch_complete',
        batchId,
        stats: { discovered: scored.length, added: filtered.length, failed: 0 },
        message: `Scan complete: ${filtered.length} new recommendations found.`,
        timestamp: new Date().toISOString(),
      })
        .then(logDispatchFailures)
        .catch((err) => console.error('Notification dispatch failed:', err))

      // Per-user recommendations_available -- distinct from batch_complete above,
      // which always goes to the global admin channels. This goes to the run's own
      // user's own channels (see auth.ts's /api/v1/auth/me/preferences), since a
      // recommendation batch is inherently addressed to one person, not a broadcast.
      if (filtered.length > 0 && deps.getUserById) {
        deps
          .getUserById(deps.userId)
          .then((user) => {
            const userChannels = decryptChannelSecrets(
              mergePreferences(user?.preferences).channels ?? [],
            )
            return dispatch(userChannels, 'recommendations_available', {
              event: 'recommendations_available',
              batchId,
              count: filtered.length,
              message: `Scan complete: ${filtered.length} new recommendations found.`,
              timestamp: new Date().toISOString(),
            })
          })
          .then(logDispatchFailures)
          .catch((err) => console.error('Notification dispatch failed:', err))
      }

      this.emit('progress', {
        stage: 'complete',
        message: `Done! ${filtered.length} new recommendations found.`,
      })

      if (jobId != null && deps.jobRecorder) {
        await deps.jobRecorder.complete(jobId, {
          metadata: {
            trigger: deps.trigger ?? 'manual',
            artistsDiscovered: scored.length,
            artistsStored: filtered.length,
            artistsFiltered: scored.length - filtered.length,
            ...(tasteProfile.genreCoverage ? { genreCoverage: tasteProfile.genreCoverage } : {}),
            ...(aiProvider?.lastUsage ? { aiUsage: aiProvider.lastUsage } : {}),
          },
          sourceResults,
          batchId,
        })
      }

      if (genreDb) {
        void warmArtistGenres(tasteProfile.topArtists, {
          db: genreDb,
          musicbrainz: mbClient,
        }).catch((error: unknown) =>
          console.error(
            '[genre-backfill] background warm failed:',
            error instanceof Error ? error.message : String(error),
          ),
        )
      }

      return { batchId }
    } catch (err: unknown) {
      if (jobId != null && deps.jobRecorder) {
        await recordFailureSafely(deps.jobRecorder, jobId, errMsg(err))
      }
      this.emit('error', err)
      throw err
    } finally {
      this.running = false
      // Drop the userId so subsequent non-pipeline emits don't inherit a stale owner
      this._currentUserId = undefined
      this.drainQueue()
    }
  }

  /**
   * Start a run now, or queue it FIFO behind the in-flight one. Single-flight is
   * preserved (one pipeline at a time, shared API/RAM budgets); a busy caller is
   * parked instead of rejected. Deduped per userId so a double-click doesn't
   * stack two runs.
   */
  enqueue(deps: PipelineDeps): EnqueueResult {
    if (!this.running) {
      this.startRun(deps)
      return { status: 'started', position: 0 }
    }
    if (this._currentUserId === deps.userId) return { status: 'duplicate', position: 0 }
    const existing = this.queue.findIndex((q) => q.userId === deps.userId)
    if (existing >= 0) return { status: 'duplicate', position: existing + 1 }
    this.queue.push({ userId: deps.userId, deps })
    return { status: 'queued', position: this.queue.length }
  }

  private startRun(deps: PipelineDeps): void {
    this.run(deps).catch((err: unknown) => {
      console.error('[orchestrator] queued run failed:', err)
    })
  }

  private drainQueue(): void {
    const next = this.queue.shift()
    if (next) this.startRun(next.deps)
  }

  get isRunning(): boolean {
    return this.running
  }

  get queueLength(): number {
    return this.queue.length
  }

  /** 1-based position of userId in the queue; 0 if running or not queued. */
  queuePositionFor(userId: number | undefined): number {
    const i = this.queue.findIndex((q) => q.userId === userId)
    return i >= 0 ? i + 1 : 0
  }

  get stage(): string | null {
    return this.currentStage
  }

  get stageMessage(): string | null {
    return this.currentMessage
  }

  get currentUserId(): number | undefined {
    return this._currentUserId
  }
}
