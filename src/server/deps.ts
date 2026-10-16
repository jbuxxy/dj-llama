// Per-domain slices of the old AppDependencies bag. Route files that only
// consume a subset can now import the narrower slice they need so their
// tests can mock less scaffolding. The full AppDependencies type in
// src/server/index.ts is an intersection of all slices and stays
// structurally compatible - existing callers do not need to change.

import type { GenreService } from '@/core/genre/service'
import type { AlbumCoverage } from '@/core/library/album-coverage'
import type { LibraryHealthService } from '@/core/library/health'
import type { SkyHookWarmer } from '@/core/library/skyhook-warmer'
import type { LibrarySyncStore } from '@/core/library/store'
import type { SyncOrchestrator } from '@/core/library/sync'
import type { CronScheduler } from '@/core/ops/cron-scheduler'
import type { PipelineOrchestrator } from '@/core/pipeline/orchestrator'
import type { GenreFeedback } from '@/core/pipeline/score'
import type { AiProviderRegistry } from '@/core/providers/registry'
import type { GenreCoverage } from '@/core/types'
import type { ArtistRow } from '@/db/queries/artists'
import type { BatchRow } from '@/db/queries/batches'
import type { ActivityEntry } from '@/db/queries/dashboard'
import type {
  ListRecommendationsFilters,
  ListRecommendationsResult,
  RecommendationWithArtist,
  StatusUpdateExtra,
} from '@/db/queries/recommendations'
import type { SettingsRow, SetupConfig } from '@/db/queries/settings'
import type { UserPublic } from '@/db/queries/users'
import type { TasteProfileCache } from '@/db/schema'
import type { Cursor } from '@/server/helpers/pagination-cursor'
import type { PlaylistDeps } from './routes/playlists'

// ---- DB / storage ----

export interface DbDeps {
  db: import('@/db').Database
  storeDb: import('@/core/pipeline/store').StoreDb
}

// ---- Settings / setup ----

export interface SettingsDeps {
  isSetupComplete: () => Promise<boolean>
  getSettings: () => Promise<SettingsRow | null>
  updateSettings: (partial: Record<string, unknown>) => Promise<void>
  completeSetup: (config: SetupConfig) => Promise<unknown>
}

// ---- Users / auth ----

export interface UserDeps {
  createUser: (data: {
    username: string
    passwordHash: string
    isAdmin?: boolean
  }) => Promise<UserPublic>
  getUserByUsername: (
    username: string,
  ) => Promise<{ id: number; username: string; passwordHash: string; isAdmin: boolean } | null>
  getUserById: (id: number) => Promise<UserPublic | null>
  getUserCount: () => Promise<number>
  updateUser: (
    id: number,
    data: {
      isAdmin?: boolean
      email?: string | null
      autoApproveRequests?: boolean
    },
  ) => Promise<void>
  listUsers: (opts?: { limit?: number; cursor?: Cursor | null }) => Promise<UserPublic[]>
  getLastSignInByUser?: () => Promise<Map<number, Date>>
  deleteUser: (id: number) => Promise<void>
}

// ---- Pipeline / scheduler / jobs ----

export interface PipelineDeps {
  orchestrator: PipelineOrchestrator
  scheduler: CronScheduler
  providerRegistry: AiProviderRegistry
  getLastBatch: () => Promise<{ id: number; createdAt: Date | string; status: string } | null>
  restartScheduler: (cron: string | null) => void
  restartPlaylistScheduler: () => Promise<void>
  restartLibraryMaintenanceScheduler?: (intervalHours: number) => void
  restartDigestNotifier?: () => Promise<void>
}

export interface JobDeps {
  jobRecorder: import('@/core/jobs/types').JobRecorder
  jobQueries: {
    listJobs: (
      filters?: import('@/db/queries/jobs').ListJobsFilters,
    ) => Promise<{ items: import('@/core/jobs/types').JobRunRow[]; total: number }>
    getJobById: (id: number) => Promise<import('@/core/jobs/types').JobRunRow | null>
    getJobHealth: (nextRun: Date | null) => Promise<import('@/db/queries/jobs').HealthSummary>
  }
}

// ---- Recommendations / batches / artists ----

export interface RecommendationDeps {
  listRecommendations: (filters?: ListRecommendationsFilters) => Promise<ListRecommendationsResult>
  getRecommendation: (id: number) => Promise<RecommendationWithArtist | null>
  updateRecommendationStatus: (
    id: number,
    status: string,
    extra?: StatusUpdateExtra,
  ) => Promise<void>
  rejectRecommendation: (
    params: import('@/db/queries/recommendations').RejectRecommendationParams,
  ) => Promise<number | null>
  bulkUpdateStatus: (ids: number[], status: string) => Promise<void>
  bulkDelete: (ids: number[]) => Promise<number>
  filterOwnedIds: (ids: number[], userId: number | undefined) => Promise<number[]>
  listBatches: (opts?: { limit?: number; cursor?: Cursor | null }) => Promise<BatchRow[]>
  getBatch: (id: number) => Promise<BatchRow | null>
  getArtistById: (id: number) => Promise<ArtistRow | null>
  getFeedbackHistory: (userId?: number) => Promise<Map<string, GenreFeedback>>
  listArtistBlocks: (params: {
    userId: number
    limit?: number
    cursor?: import('@/db/queries/artist-blocks').ListBlocksCursor | null
    q?: string | null
  }) => Promise<{
    items: import('@/db/queries/artist-blocks').BlockedArtistRow[]
    nextCursor: import('@/db/queries/artist-blocks').ListBlocksCursor | null
  }>
  removeArtistBlock: (params: { userId: number; artistId: number }) => Promise<boolean>
  addArtistBlock: (params: {
    userId: number
    artistId: number
    reason?: import('@/core/recommendations/rejection-reasons').RejectionReason | null
    reasonText?: string | null
  }) => Promise<void>
  listAlbumBlocks: (
    userId: number,
  ) => Promise<import('@/db/queries/album-blocks').BlockedAlbumRow[]>
  removeAlbumBlock: (params: { userId: number; releaseGroupMbid: string }) => Promise<void>
}

// ---- Targets ----

// Lidarr is a global, system-managed target now (see db/queries/targets.ts)
// -- there is no more per-user target CRUD or generic test-by-type probe;
// each connection has its own dedicated test/save flow in Settings instead.
export interface TargetDeps {
  getEnabledTargetsForUser: (
    userId: number,
  ) => Promise<import('@/core/targets/types').DestinationTarget[]>
}

// ---- Library ----

export interface LibraryDeps {
  genreService: GenreService
  libraryHealth: LibraryHealthService
  skyhookWarmer?: SkyHookWarmer | null
  librarySync: SyncOrchestrator
  librarySyncStore: LibrarySyncStore
  albumCoverage?: {
    getCoverageForArtist: (userId: number, artistMbid: string) => Promise<AlbumCoverage>
  }
  // Fire-and-forget: the Plex webhook (library.new) calls this when new
  // media shows up for a user. Debounced internally (a single album import
  // fires many library.new events in quick succession) -- triggers a forced
  // per-user library resync, reconciles fulfillment against pending
  // requests/recommendations, then broadcasts a realtime update.
  handleLibraryWebhookEvent?: (userId: number) => void
}

// ---- Dashboard ----

export interface DashboardDeps {
  dashboardQueries: {
    getTasteProfile: (userId: number | undefined) => Promise<TasteProfileCache>
    getLatestGenreCoverage: (userId: number | undefined) => Promise<GenreCoverage | null>
    getRecentActivity: (
      userId: number | undefined,
      isAdmin: boolean,
      limit?: number,
    ) => Promise<ActivityEntry[]>
  }
}

// ---- Playlist (already externalised) ----

export interface OptionalRouteDeps {
  playlistDeps?: PlaylistDeps
}

// Full app dependencies. Intersecting the per-domain slices keeps the
// structural shape identical so existing route factories that take
// `AppDependencies` keep compiling without changes.
export type AppDependencies = DbDeps &
  SettingsDeps &
  UserDeps &
  PipelineDeps &
  JobDeps &
  RecommendationDeps &
  TargetDeps &
  LibraryDeps &
  DashboardDeps &
  OptionalRouteDeps
