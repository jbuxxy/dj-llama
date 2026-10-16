import { sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  real,
  serial,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import type { HealthCheckResult } from '@/core/library/types'
import type { NotificationChannel } from '@/core/notifications/types'
import type { GenreCoverage } from '@/core/types'

export type RecommendationBatchSourceConfig = Record<string, unknown> & {
  trigger?: 'manual' | 'scheduled'
}

export type JobMetadata = Record<string, unknown> & {
  trigger?: 'manual' | 'scheduled'
  seedArtist?: string
  genreCoverage?: GenreCoverage
}

export const settings = pgTable('settings', {
  id: serial('id').primaryKey(),
  // Server owner's (accountID 1) resolved Plex connection -- the one data-access
  // token used for anything Plex's API only exposes server-wide (history, etc).
  // Per-user browsing/playlist actions use each user's own resolved token
  // (users.plex_token) instead, wherever Plex itself filters by token.
  plexAdminUrl: text('plex_admin_url'),
  plexAdminToken: text('plex_admin_token'),
  plexMachineIdentifier: text('plex_machine_identifier'),
  // Admin-picked during first login (see auth-plex.ts's select-library step) --
  // not auto-detected, since Plex types audiobook libraries as "artist" too,
  // same as real music libraries. A user is authorized if they have access to
  // ANY section in this list; at least one is required to complete bootstrap.
  plexMusicSectionIds: text('plex_music_section_ids').array(),
  lidarrUrl: text('lidarr_url'),
  lidarrApiKey: text('lidarr_api_key'),
  aiProvider: text('ai_provider'),
  aiApiKey: text('ai_api_key'),
  aiModel: text('ai_model'),
  aiBaseUrl: text('ai_base_url'),
  skipTlsVerify: boolean('skip_tls_verify').default(false).notNull(),
  audiodbApiKey: text('audiodb_api_key'),
  // Optional: enables Last.fm as a second similar-artists source for discovery.
  lastfmApiKey: text('lastfm_api_key'),
  audiodbProxyImages: boolean('audiodb_proxy_images').notNull().default(false),
  wikidataEnabled: boolean('wikidata_enabled').notNull().default(true),
  preferences: jsonb('preferences').$type<Preferences>(),
  setupComplete: boolean('setup_complete').default(false).notNull(),
  librarySyncIntervalHours: integer('library_sync_interval_hours').notNull().default(6),
  digestLastSentAt: timestamp('digest_last_sent_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

export const libraryHealthState = pgTable('library_health_state', {
  id: serial('id').primaryKey(),
  checks: jsonb('checks').$type<HealthCheckResult[]>().notNull().default([]),
  lastStartedAt: timestamp('last_started_at', { withTimezone: true }),
  lastCompletedAt: timestamp('last_completed_at', { withTimezone: true }),
  lastError: text('last_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

export const users = pgTable(
  'users',
  {
    id: serial('id').primaryKey(),
    username: text('username').unique().notNull(),
    passwordHash: text('password_hash').notNull(),
    isAdmin: boolean('is_admin').default(false).notNull(),
    email: text('email'),
    plexAccountId: integer('plex_account_id'),
    authProvider: text('auth_provider').notNull().default('local'),
    // Set exactly once, at bootstrap, for the Plex identity that was verified
    // (via Plex's own `owned: true` resource flag) to actually own the
    // configured server -- never re-derived afterward, and never true for
    // anyone else. The permanent admin: no one, including other admins, can
    // demote this user (see users.ts route). Do not confuse with isAdmin,
    // which other users can also hold and can be revoked.
    isOwner: boolean('is_owner').notNull().default(false),
    // Whether this Plex identity currently has access to the admin-picked
    // Music library section(s) -- set at login time and refreshed by the
    // periodic Plex user sync (core/auth/plex-user-sync.ts). Someone can have
    // real server access but not this, in which case they get a "contact
    // your admin" screen instead of the app rather than being blocked from
    // logging in at all.
    hasMusicAccess: boolean('has_music_access').notNull().default(false),
    // Set by the sync job when this Plex identity no longer appears in the
    // server's shared-users list at all (fully unshared, not just lost Music
    // access). Null means still has server access. Soft revoke, not a hard
    // delete -- some tables reference users.id without ON DELETE CASCADE, and
    // an automated job should never risk losing recommendation/request
    // history to a transient Plex API hiccup.
    plexAccessRevokedAt: timestamp('plex_access_revoked_at', { withTimezone: true }),
    // Admin-granted trust flag for the manual search/request workflow (requests
    // table below) -- distinct from preferences.autoApproveEnabled, which is
    // that user's own setting for the separate AI-recommendation pipeline.
    // A trusted user's requests dispatch to Lidarr immediately instead of
    // sitting in the admin approval queue. Admins and the owner always
    // auto-dispatch their own requests regardless of this flag.
    autoApproveRequests: boolean('auto_approve_requests').notNull().default(false),
    preferences: jsonb('preferences').$type<Preferences>(),
    plexUrl: text('plex_url'),
    plexToken: text('plex_token'),
    plexSectionId: text('plex_section_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    // "Your Taste" dashboard widget: populated synchronously the first time
    // it's requested (see getTasteProfile in index.ts), then served from
    // here and only recomputed once TASTE_PROFILE_TTL_MS has elapsed --
    // computing it fresh on every dashboard load would mean a Plex fetch
    // plus an AI call (for the title/reasoning) on every page view.
    tasteProfileCache: jsonb('taste_profile_cache').$type<TasteProfileCache>(),
    tasteProfileCachedAt: timestamp('taste_profile_cached_at', { withTimezone: true }),
  },
  (table) => ({
    emailUniqueIdx: uniqueIndex('users_email_unique_idx')
      .on(table.email)
      .where(sql`${table.email} IS NOT NULL`),
    plexAccountIdUniqueIdx: uniqueIndex('users_plex_account_id_unique_idx')
      .on(table.plexAccountId)
      .where(sql`${table.plexAccountId} IS NOT NULL`),
  }),
)

export type TasteProfileGenre = {
  genre: string
  count: number
  percentage: number
}

export type TasteProfileCache = {
  genres: TasteProfileGenre[]
  // AI-generated persona title + reasoning (see buildTasteProfilePrompt in
  // core/providers/prompt.ts) -- absent when no AI provider is configured,
  // in which case the widget shows genres only.
  title?: string
  reasoning?: string
}

export const genres = pgTable(
  'genres',
  {
    id: serial('id').primaryKey(),
    name: text('name').notNull(),
    slug: text('slug').notNull().unique(),
    source: text('source').notNull(),
    parentGenreId: integer('parent_genre_id').references((): AnyPgColumn => genres.id),
    artistCount: integer('artist_count').default(0),
    cachedAt: timestamp('cached_at', { withTimezone: true }),
  },
  (table) => ({
    parentGenreIdx: index('genres_parent_genre_id_idx').on(table.parentGenreId),
  }),
)

export const subscriptions = pgTable(
  'subscriptions',
  {
    id: serial('id').primaryKey(),
    name: text('name').notNull(),
    userId: integer('user_id').references(() => users.id),
    enabled: boolean('enabled').notNull().default(true),
    sourceType: text('source_type').notNull(),
    sourceProvider: text('source_provider').notNull(),
    sourceConfig: jsonb('source_config').notNull().$type<Record<string, unknown>>(),
    maxArtistsPerRun: integer('max_artists_per_run').notNull().default(20),
    listenerRange: jsonb('listener_range').$type<{ min?: number; max?: number } | null>(),
    cron: text('cron').notNull(),
    action: text('action').notNull().default('add_to_recommendations'),
    scoreThreshold: real('score_threshold'),
    scoringWeightPreset: text('scoring_weight_preset').default('default'),
    scoringWeightOverrides: jsonb('scoring_weight_overrides').$type<Record<
      string,
      number
    > | null>(),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    lastResultCount: integer('last_result_count'),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userIdx: index('subscriptions_user_id_idx').on(table.userId),
    enabledIdx: index('subscriptions_enabled_idx').on(table.enabled),
  }),
)

export type TopTrack = {
  name: string
  previewUrl?: string
  durationMs?: number
}

export type TopTracksCache = {
  tracks: TopTrack[]
  cachedAt: string
}

export const artists = pgTable('artists', {
  id: serial('id').primaryKey(),
  mbid: uuid('mbid').unique().notNull(),
  name: text('name').notNull(),
  disambiguation: text('disambiguation'),
  tags: text('tags').array(),
  genres: text('genres').array(),
  imageUrl: text('image_url'),
  logoUrl: text('logo_url'),
  streamingUrls: jsonb('streaming_urls').$type<Record<string, string>>(),
  imageFailedAt: timestamp('image_failed_at', { withTimezone: true }),
  cachedAt: timestamp('cached_at', { withTimezone: true }),
  genresCachedAt: timestamp('genres_cached_at', { withTimezone: true }),
  beginYear: integer('begin_year'),
  endYear: integer('end_year'),
  topTracks: jsonb('top_tracks').$type<TopTracksCache>(),
  description: jsonb('description').$type<Record<string, string> | null>(),
  externalLinks: jsonb('external_links').$type<Record<string, string> | null>(),
  wikidataId: text('wikidata_id'),
  wikidataFetchedAt: timestamp('wikidata_fetched_at', { withTimezone: true }),
  wikidataFailedAt: timestamp('wikidata_failed_at', { withTimezone: true }),
})

export const artistGenreAliases = pgTable(
  'artist_genre_aliases',
  {
    id: serial('id').primaryKey(),
    source: text('source').notNull(),
    nameNormalized: text('name_normalized').notNull(),
    mbid: uuid('mbid')
      .references(() => artists.mbid, { onDelete: 'cascade' })
      .notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    sourceNameUnique: uniqueIndex('artist_genre_aliases_source_name_unique').on(
      table.source,
      table.nameNormalized,
    ),
    mbidIdx: index('artist_genre_aliases_mbid_idx').on(table.mbid),
  }),
)

export const rateLimitBuckets = pgTable('rate_limit_buckets', {
  key: text('key').primaryKey(),
  tokens: numeric('tokens', { precision: 10, scale: 4 }).notNull(),
  lastRefillAt: timestamp('last_refill_at', { withTimezone: true }).defaultNow().notNull(),
})

export const recommendationBatches = pgTable(
  'recommendation_batches',
  {
    id: serial('id').primaryKey(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    sourceConfig: jsonb('source_config').$type<RecommendationBatchSourceConfig | null>(),
    stats: jsonb('stats'),
    status: text('status').notNull().default('running'),
    subscriptionId: integer('subscription_id').references(() => subscriptions.id),
  },
  (table) => ({
    subscriptionIdx: index('recommendation_batches_subscription_id_idx').on(table.subscriptionId),
    createdAtIdx: index('recommendation_batches_created_at_id_idx').on(table.createdAt, table.id),
  }),
)

export const recommendations = pgTable(
  'recommendations',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id').references(() => users.id),
    artistId: integer('artist_id')
      .references(() => artists.id)
      .notNull(),
    batchId: integer('batch_id')
      .references(() => recommendationBatches.id)
      .notNull(),
    score: real('score').notNull(),
    sources: jsonb('sources').$type<Record<string, number>>(),
    aiReasoning: text('ai_reasoning'),
    status: text('status').notNull().default('pending'),
    kind: text('kind').notNull().default('artist'),
    lidarrArtistId: integer('lidarr_artist_id'),
    lidarrError: text('lidarr_error'),
    recommendedReleaseGroupId: text('recommended_release_group_id'),
    recommendedReleaseGroupTitle: text('recommended_release_group_title'),
    targetActions: jsonb('target_actions').$type<Record<string, unknown>>(),
    rejectionReason: text('rejection_reason'),
    rejectionReasonText: text('rejection_reason_text'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    actedOnAt: timestamp('acted_on_at', { withTimezone: true }),
    // Set once the library sync actually finds this artist/album by mbid
    // (see core/library/reconcile-fulfillment.ts) -- distinct from `status`,
    // which only ever reflected "Lidarr accepted the add," never whether it
    // actually arrived. Null = not yet confirmed; layered on top of status
    // as a separate "In Library" badge rather than replacing it.
    libraryConfirmedAt: timestamp('library_confirmed_at', { withTimezone: true }),
  },
  (table) => ({
    batchIdx: index('recommendations_batch_idx').on(table.batchId),
    artistIdx: index('recommendations_artist_idx').on(table.artistId),
    userStatusScoreIdx: index('recommendations_user_status_score_idx').on(
      table.userId,
      table.status,
      table.score,
    ),
    userCreatedIdx: index('recommendations_user_created_idx').on(table.userId, table.createdAt),
    userActedOnIdx: index('recommendations_user_acted_on_idx').on(table.userId, table.actedOnAt),
    statusActedOnIdx: index('recommendations_status_acted_on_idx').on(
      table.status,
      table.actedOnAt,
    ),
  }),
)

// A user explicitly searching for and requesting a specific artist/album,
// gated by admin approval -- distinct from `recommendations` (AI-curated
// suggestions the user self-serve approves, no admin gate). Dispatch reuses
// the same DestinationTarget.addArtist/addAlbum machinery as recommendation
// approval (see server/routes/requests.ts).
export const requests = pgTable(
  'requests',
  {
    id: serial('id').primaryKey(),
    requestedByUserId: integer('requested_by_user_id')
      .references(() => users.id)
      .notNull(),
    kind: text('kind').notNull(), // 'artist' | 'album'
    artistMbid: text('artist_mbid').notNull(),
    artistName: text('artist_name').notNull(),
    // Set only for kind = 'album'.
    releaseGroupMbid: text('release_group_mbid'),
    albumTitle: text('album_title'),
    coverUrl: text('cover_url'),
    // 'pending' | 'dispatched' | 'failed' | 'rejected'. Dispatch happens
    // synchronously at approval time (same as recommendation approval), so
    // there is no separate 'approved-but-not-dispatched-yet' state.
    status: text('status').notNull().default('pending'),
    targetActions: jsonb('target_actions').$type<Record<string, unknown>>(),
    rejectionReason: text('rejection_reason'),
    decidedByUserId: integer('decided_by_user_id').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    // Set once the library sync actually finds this artist/album by mbid
    // (see core/library/reconcile-fulfillment.ts) -- distinct from `status`,
    // which only ever reflected "Lidarr accepted the add," never whether it
    // actually arrived. Null = not yet confirmed; layered on top of status
    // as a separate "In Library" badge rather than replacing it.
    libraryConfirmedAt: timestamp('library_confirmed_at', { withTimezone: true }),
    // User-initiated "remove from My Requests" -- a pure UI declutter action,
    // not a status transition. Null = still visible. Permanent (no undo UI);
    // the row and its status/history are untouched, just excluded from the
    // My Requests list query. Taste-profile/playlist signal queries (see
    // listRequestsForUser's excludeDismissed param) ignore this entirely.
    dismissedAt: timestamp('dismissed_at', { withTimezone: true }),
    // The playlist whose missing-track import auto-created this request (see
    // index.ts's autoRequestMissingPlaylistTracks), so the dashboard activity
    // feed can name it. Null for every other request path, for rows created
    // before this column existed, and once that playlist is deleted.
    sourcePlaylistId: integer('source_playlist_id').references(() => playlists.id, {
      onDelete: 'set null',
    }),
  },
  (table) => ({
    requestedByCreatedIdx: index('requests_requested_by_created_idx').on(
      table.requestedByUserId,
      table.createdAt,
    ),
    statusCreatedIdx: index('requests_status_created_idx').on(table.status, table.createdAt),
  }),
)

export const jobRuns = pgTable(
  'job_runs',
  {
    id: serial('id').primaryKey(),
    type: text('type').notNull(), // 'pipeline' | 'quick_discover' | 'target' | 'playlist' | 'library_sync'
    status: text('status').notNull(), // 'running' | 'completed' | 'failed' | 'stuck' | 'interrupted'
    userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    durationMs: integer('duration_ms'),
    error: text('error'),
    metadata: jsonb('metadata').$type<JobMetadata>().notNull().default({}),
    sourceResults: jsonb('source_results'),
    subscriptionId: integer('subscription_id').references(() => subscriptions.id, {
      onDelete: 'set null',
    }),
    batchId: integer('batch_id').references(() => recommendationBatches.id, {
      onDelete: 'set null',
    }),
  },
  (table) => ({
    userIdx: index('job_runs_user_id_idx').on(table.userId),
    batchIdx: index('job_runs_batch_id_idx').on(table.batchId),
    subscriptionIdx: index('idx_job_runs_subscription')
      .on(table.subscriptionId)
      .where(sql`${table.subscriptionId} IS NOT NULL`),
    typeStartedAtIdx: index('job_runs_type_started_at_idx').on(table.type, table.startedAt),
  }),
)

export const targets = pgTable(
  'targets',
  {
    id: serial('id').primaryKey(),
    // 'lidarr' -- the only type now. System-managed: userId is always null
    // (a single shared row per type, auto-created and kept in sync with
    // settings.lidarrUrl/apiKey whenever an admin saves that Connections
    // card). Never inserted or edited directly by end users. `enabled` is
    // toggled off (never deleted) when a connection is cleared.
    type: text('type').notNull(),
    name: text('name').notNull(),
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
    userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }),
    enabled: boolean('enabled').default(true).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    userIdx: index('targets_user_id_idx').on(table.userId),
    typeIdx: index('targets_type_idx').on(table.type),
  }),
)

export const sessions = pgTable(
  'sessions',
  {
    token: text('token').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => ({
    userExpiresIdx: index('sessions_user_expires_idx').on(table.userId, table.expiresAt),
    expiresIdx: index('sessions_expires_idx').on(table.expiresAt),
  }),
)

export const artistMetadata = pgTable('artist_metadata', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  nameNormalized: text('name_normalized').notNull().unique(),
  spotifyGenres: text('spotify_genres').array(),
  spotifyPopularity: integer('spotify_popularity'),
  deezerFans: integer('deezer_fans'),
  cachedAt: timestamp('cached_at', { withTimezone: true }).defaultNow(),
})

export const oauthTokens = pgTable(
  'oauth_tokens',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    provider: text('provider').notNull(),
    accessToken: text('access_token').notNull(),
    refreshToken: text('refresh_token'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    scopes: text('scopes'),
    clientId: text('client_id'),
    clientSecret: text('client_secret'),
    // Connected account's own identity/tier, e.g. Spotify's display_name and
    // product ("premium"/"free"/"open") from GET /v1/me -- lets the settings
    // UI show "Connected as X" instead of just a boolean connected state.
    accountLabel: text('account_label'),
    accountTier: text('account_tier'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [unique('oauth_tokens_user_provider').on(t.userId, t.provider)],
)

export const playlists = pgTable(
  'playlists',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    // Imported playlists only: the source playlist's own cover image (a
    // Spotify/Deezer/Apple Music/YouTube Music CDN URL), refreshed on every
    // re-sync. Null for generated playlists, which have no source cover.
    coverUrl: text('cover_url'),
    strategy: text('strategy').notNull(),
    targetIds: jsonb('target_ids').$type<number[]>().default([]).notNull(),
    schedule: text('schedule'),
    config: jsonb('config').$type<PlaylistConfig>(),
    lastGeneratedAt: timestamp('last_generated_at', { withTimezone: true }),
    trackCount: integer('track_count').default(0),
    enabled: boolean('enabled').default(true).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    // Explicit lifecycle state, replacing the old implicit "non-null
    // lastGeneratedAt = currently live" convention. 'active' = generated and
    // pushed (or seasonal/live for its window); 'pending_review' = generated,
    // waiting on the user or an auto-add toggle; 'expired' = review window
    // lapsed with no action taken.
    status: text('status').notNull().default('active'),
    pushedToPlex: boolean('pushed_to_plex').notNull().default(false),
    // Null = never expires (always true for ai_prompt/manual playlists, and
    // for anything currently 'active'). Non-null = the review-expiry tick
    // will tear this playlist down once passed, if still 'pending_review'.
    reviewExpiresAt: timestamp('review_expires_at', { withTimezone: true }),
    // import strategy only: whether re-syncing this playlist actually pushes
    // the mirrored tracks to Plex, vs. just resolving/flagging missing
    // entries without touching Plex at all. Default off -- some imports are
    // only meant to surface what's missing from the library, not maintain a
    // live Plexamp playlist. Every other strategy always pushes per the
    // autoPush logic in executePlaylistGeneration and ignores this column.
    autoPushToPlex: boolean('auto_push_to_plex').notNull().default(false),
    // ai_prompt (Mediasage) only: a short AI/generator-produced blurb shown
    // alongside the generated title -- see core/playlists/mix-title.ts's
    // generateMixDescription(). Null for every other strategy.
    description: text('description'),
  },
  (table) => ({
    userIdx: index('playlists_user_id_idx').on(table.userId),
    enabledLastGeneratedIdx: index('playlists_enabled_last_generated_idx').on(
      table.enabled,
      table.lastGeneratedAt,
    ),
    statusReviewExpiresIdx: index('playlists_status_review_expires_idx').on(
      table.status,
      table.reviewExpiresAt,
    ),
  }),
)

export const playlistTracks = pgTable(
  'playlist_tracks',
  {
    id: serial('id').primaryKey(),
    playlistId: integer('playlist_id')
      .references(() => playlists.id, { onDelete: 'cascade' })
      .notNull(),
    artistName: text('artist_name').notNull(),
    trackName: text('track_name'),
    mbid: text('mbid'),
    spotifyUri: text('spotify_uri'),
    deezerId: text('deezer_id'),
    localPath: text('local_path'),
    position: integer('position').notNull(),
  },
  (table) => ({
    playlistPositionIdx: index('playlist_tracks_playlist_position_idx').on(
      table.playlistId,
      table.position,
    ),
  }),
)

// Tracks from an imported external playlist (strategy 'import') that Plex
// couldn't match, reconciled on every re-sync (core/playlists/external-import.ts)
// instead of being re-flagged as a fresh `recommendations` row every run --
// that was the old behavior, and it stacked an unbounded number of duplicate
// entries for anything that stayed missing across syncs. A row disappears
// the moment its track is no longer in the unmatched set (added to the
// library, or the source playlist dropped it), and reappears next sync if
// it's still actually missing.
export const playlistMissingTracks = pgTable(
  'playlist_missing_tracks',
  {
    id: serial('id').primaryKey(),
    playlistId: integer('playlist_id')
      .references(() => playlists.id, { onDelete: 'cascade' })
      .notNull(),
    artistName: text('artist_name').notNull(),
    trackName: text('track_name').notNull(),
    albumTitle: text('album_title'),
    // The source playlist's own album art for this track (Spotify/Deezer/
    // Apple Music/YouTube Music CDN URL), so a missing track can show its
    // cover. Null for rows from before this column existed.
    coverUrl: text('cover_url'),
    // null = legacy row from before this column existed, treated like 'not_found'.
    // 'not_found': Plex genuinely has no matching track. 'search_error': the Plex
    // search itself failed/timed out, so this may just need a retry rather than
    // a Lidarr request -- see targets/plex-playlist.ts searchTrack().
    reason: text('reason'),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).defaultNow().notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    naturalKey: uniqueIndex('playlist_missing_tracks_natural_key_idx').on(
      table.playlistId,
      table.artistName,
      table.trackName,
    ),
    playlistIdx: index('playlist_missing_tracks_playlist_idx').on(table.playlistId),
  }),
)

// Push-based recent-play signal from Plex's own webhook feature (Plex Pass
// required on the Plex side) -- see src/server/routes/webhooks.ts. Only Plex
// supports an inbound webhook; other sources have no equivalent and stay
// poll-based via getRecentListening(). Pruned to the
// most recent PLEX_SCROBBLE_CAP rows per user (see queries/plex-scrobbles.ts)
// so this never grows unbounded for an always-on webhook.
export const plexScrobbles = pgTable(
  'plex_scrobbles',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    artistName: text('artist_name').notNull(),
    trackName: text('track_name').notNull(),
    playedAt: timestamp('played_at', { withTimezone: true }).notNull(),
  },
  (table) => ({
    userPlayedAtIdx: index('plex_scrobbles_user_played_at_idx').on(table.userId, table.playedAt),
  }),
)

export type PlaylistConfig = {
  size: number // default 25
  genre?: string // for genre_focus strategy
  mood?: string // for mood_mix strategy
  presetKey?: string // for seasonal strategy -- see core/playlists/seasonal-presets.ts
  // for seasonal strategy -- per-row override of the preset's built-in
  // default calendar window, falls back to it when absent
  windowOverride?: { startMonth: number; startDay: number; endMonth: number; endDay: number }
  prompt?: string // for ai_prompt strategy -- free-text description of the desired playlist
  // for ai_prompt strategy -- optionally blend the listener's Plex play
  // history in as additional context for album selection
  useListeningHistory?: boolean
  // for ai_prompt strategy -- mediasage-style filter-first scoping, applied
  // to the library candidate pool before the AI ever sees it (see
  // core/playlists/library-filter.ts). Both are OR-matched (any one of the
  // selected genres/decades); decadeFilters holds decade start years (1990 =
  // 90s) -- empty/unset means every decade is available.
  genreFilters?: string[]
  decadeFilters?: number[]
  excludeLiveVersions?: boolean
  trackSourcePriority: ('local' | 'spotify' | 'deezer')[]
  // for import strategy -- mirrors an exact external playlist into Plex
  // (core/playlists/external-import.ts), re-fetched fresh on each regenerate
  importSource?: 'spotify' | 'deezer' | 'youtube_music' | 'apple_music'
  importPlaylistId?: string
  importPlaylistName?: string
  // for daily_mix strategy -- which of the DAILY_MIX_COUNT genre buckets
  // (core/playlists/daily-mix.ts) this row renders; each bucket is its own
  // playlists row, mirroring how each seasonal preset gets its own row.
  mixIndex?: number
  // for seasonal strategy -- the listener's own edits, kept across every
  // regeneration: songs they removed never come back, songs they added
  // always stay (see core/playlists/seasonal-generator.ts).
  excludedTracks?: Array<{ artistName: string; trackName: string }>
  pinnedTracks?: Array<{ artistName: string; trackName: string; localPath?: string | null }>
  // for seasonal strategy -- the next-best seasonal candidates from the last
  // generation, offered as replacements when a song is removed.
  seasonalCandidates?: Array<{
    artistName: string
    trackName: string
    localPath: string
    reason: string
    score: number
  }>
}

export type PlaylistStrategy =
  | 'weekly_digest'
  | 'genre_focus'
  | 'mood_mix'
  | 'rediscover'
  | 'seasonal'
  | 'import'
  | 'ai_prompt'
  | 'daily_mix'

export type Preferences = {
  qualityProfileId: number
  metadataProfileId: number
  rootFolderId?: number
  scheduleCron: string
  scoreThreshold: number
  scoringWeights: {
    consensus: number
    similarity: number
    genreOverlap: number
    aiConfidence: number
    feedbackBoost: number
    popularity: number
  }
  rejectionCooldownDays: number
  topArtistsLimit: number
  librarySeedRatio: number // 0-1: fraction of seed artists from Lidarr library
  webhookUrl?: string
  channels?: NotificationChannel[]
  digestCron?: string // cron string for the periodic digest webhook; absent/empty = disabled
  lidarrPublicUrl?: string // browser-accessible Lidarr URL (may differ from API URL)
  autoApproveEnabled?: boolean
  autoApproveThreshold?: number // 0-1: minimum score to auto-approve
  autoApproveMonitorOption?: 'recommended' | 'all' | 'new' | 'none' // 'none' is legacy, treated as 'recommended'
  playlistSize?: number // default 25
  playlistSchedule?: string // cron, default '0 6 * * 1' (Monday 6am)
  dismissedHints?: string[] // for UX hints system
  fanartApiKey?: string
  metadataFallbackUrl?: string
  // Per-user opt-out for whether a connected service's plays feed the taste
  // profile. Absent/true = enabled (matches prior behavior, where any
  // connected service always contributed).
  historySourcesEnabled?: { plex?: boolean }
  // Remembers whether the Settings > Connections "what does each integration
  // do" reference table is expanded. Absent/false = collapsed.
  integrationCapabilitiesExpanded?: boolean
  // Master toggle for the seasonal-playlist category as a whole -- gates
  // whether the seasonal tick does anything at all. Individual presets keep
  // their own per-row `enabled` flag underneath this (tristate).
  seasonalPlaylistsEnabled?: boolean
  // Days a pending_review playlist waits before the review-expiry tick
  // removes it. Every strategy except ai_prompt/seasonal/daily_mix always
  // auto-pushes on success now, so this only fires as a fallback when a
  // push attempt itself fails (e.g. Plex unreachable); ai_prompt never
  // expires regardless of this value (its reviewExpiresAt is always null).
  reviewWindowDays?: number
  // Dashboard cards the user has manually collapsed (by section id, e.g.
  // 'dashboard-recently-approved') -- absent/not-listed = expanded.
  collapsedDashboardSections?: string[]
}

export type ScoringWeights = Preferences['scoringWeights']

export const DEFAULT_PREFERENCES: Preferences = {
  qualityProfileId: 1,
  metadataProfileId: 1,
  scheduleCron: '0 0 * * 0',
  scoreThreshold: 0.5,
  scoringWeights: {
    consensus: 0.3,
    similarity: 0.25,
    genreOverlap: 0.2,
    aiConfidence: 0.15,
    feedbackBoost: 0.1,
    popularity: 0.0,
  },
  rejectionCooldownDays: 90,
  topArtistsLimit: 30,
  librarySeedRatio: 0.3,
  autoApproveEnabled: false,
  autoApproveThreshold: 0.8,
  autoApproveMonitorOption: 'recommended',
  playlistSize: 25,
  playlistSchedule: '0 6 * * 1',
  dismissedHints: [],
  seasonalPlaylistsEnabled: false,
  reviewWindowDays: 14,
  collapsedDashboardSections: [],
}

/**
 * Merge a partial/unknown preferences value with DEFAULT_PREFERENCES.
 * Handles the scoringWeights sub-object so neither level is left with
 * undefined fields when the DB row contains only a partial preference set.
 */
export function mergePreferences(raw: Partial<Preferences> | null | undefined): Preferences {
  const partial = raw ?? {}
  const merged: Preferences = {
    ...DEFAULT_PREFERENCES,
    ...partial,
    scoringWeights: {
      ...DEFAULT_PREFERENCES.scoringWeights,
      ...partial.scoringWeights,
    },
  }
  if ((!merged.channels || merged.channels.length === 0) && merged.webhookUrl) {
    merged.channels = [
      {
        id: 'legacy-webhook',
        type: 'webhook',
        enabled: true,
        events: ['batch_complete', 'digest'],
        url: merged.webhookUrl,
      },
    ]
  }
  return merged
}

export const libraryArtists = pgTable(
  'library_artists',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }),
    // null = global config (Lidarr), non-null = per-user (Plex)
    source: text('source').notNull(),
    // 'lidarr' | 'plex'
    sourceArtistId: text('source_artist_id').notNull(),
    name: text('name').notNull(),
    nameNormalized: text('name_normalized').notNull(),
    mbid: uuid('mbid'),
    // null when reconciliation failed; dedup query uses `WHERE mbid IS NOT NULL`
    matchMethod: text('match_method'),
    // 'mbid' | 'name_exact' | 'name_anchored' | 'name_disambiguated' | null
    matchConfidence: real('match_confidence'),
    genres: text('genres').array(),
    syncedAt: timestamp('synced_at', { withTimezone: true }).defaultNow().notNull(),
    // gap-fill rotation cursor: least-recently-checked artists first; null = never checked
    lastGapCheckAt: timestamp('last_gap_check_at', { withTimezone: true }),
  },
  (table) => ({
    naturalKey: uniqueIndex('library_artists_natural_key_idx').on(
      table.userId,
      table.source,
      table.sourceArtistId,
    ),
    dedupIdx: index('library_artists_dedup_idx').on(table.userId, table.mbid),
    nameIdx: index('library_artists_name_idx').on(table.userId, table.nameNormalized),
  }),
)

export const libraryAlbums = pgTable(
  'library_albums',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }),
    source: text('source').notNull(),
    sourceAlbumId: text('source_album_id').notNull(),
    sourceArtistId: text('source_artist_id').notNull(),
    title: text('title').notNull(),
    titleNormalized: text('title_normalized').notNull(),
    albumMbid: uuid('album_mbid'),
    artistMbid: uuid('artist_mbid'),
    releaseYear: integer('release_year'),
    primaryType: text('primary_type'),
    matchMethod: text('match_method'),
    matchConfidence: real('match_confidence'),
    syncedAt: timestamp('synced_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    naturalKey: uniqueIndex('library_albums_natural_key_idx').on(
      table.userId,
      table.source,
      table.sourceAlbumId,
    ),
    artistLookup: index('library_albums_artist_idx').on(table.userId, table.artistMbid),
  }),
)

export const libraryMatchOverrides = pgTable(
  'library_match_overrides',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }),
    source: text('source').notNull(),
    sourceArtistId: text('source_artist_id').notNull(),
    correctMbid: uuid('correct_mbid'),
    // null means "this row has no MB equivalent, leave unreconciled forever"
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    naturalKey: uniqueIndex('library_match_overrides_natural_key_idx').on(
      table.userId,
      table.source,
      table.sourceArtistId,
    ),
  }),
)

export const libraryAlbumMatchOverrides = pgTable(
  'library_album_match_overrides',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }),
    source: text('source').notNull(),
    sourceAlbumId: text('source_album_id').notNull(),
    correctAlbumMbid: uuid('correct_album_mbid'),
    // null means "treat this source album as intentionally unmatched"
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    naturalKey: uniqueIndex('library_album_match_overrides_natural_key_idx').on(
      table.userId,
      table.source,
      table.sourceAlbumId,
    ),
  }),
)

export type LibrarySyncCounts = {
  total: number
  matchedMbid: number
  matchedNameExact: number
  matchedNameAnchored: number
  matchedDisambiguated: number
  unreconciledAmbiguous: number
  unreconciledNoCandidate: number
  cacheHits: number
  mbApiCalls: number
  /** MB API calls that threw (5xx, timeout, network). Artists/albums degrade to unreconciled. */
  mbApiCallsFailed?: number
  estimatedSecondsRemaining?: number
  albumsSynced?: number
}

export const librarySyncState = pgTable(
  'library_sync_state',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }),
    source: text('source').notNull(),
    lastSyncStartedAt: timestamp('last_sync_started_at', { withTimezone: true }),
    lastSyncCompletedAt: timestamp('last_sync_completed_at', { withTimezone: true }),
    lastSyncStatus: text('last_sync_status'),
    // 'running' | 'completed' | 'failed'
    lastSyncError: text('last_sync_error'),
    lastSyncCounts: jsonb('last_sync_counts').$type<LibrarySyncCounts>(),
  },
  (table) => ({
    naturalKey: uniqueIndex('library_sync_state_natural_key_idx').on(table.userId, table.source),
  }),
)

export const recordingArtistCache = pgTable('recording_artist_cache', {
  recordingMbid: uuid('recording_mbid').primaryKey(),
  artistMbid: uuid('artist_mbid').notNull(),
  artistName: text('artist_name').notNull(),
  cachedAt: timestamp('cached_at', { withTimezone: true }).defaultNow().notNull(),
})

// Caches playlist-import's MusicBrainz track -> original-release-group
// resolution (see index.ts's autoRequestMissingPlaylistTracks /
// pickBestReleaseGroup), keyed by (artistName, trackName) as reported by the
// source playlist rather than by recording MBID -- that's the actual lookup
// key callers have on hand, and resolving it took up to 1 search + several
// candidate lookups against MusicBrainz's shared rate limit. A still-missing
// track gets re-resolved on every playlist resync without this cache, which
// measured at several minutes for one ~30-track playlist. releaseGroupMbid
// is nullable: MusicBrainz not having a usable original release for a track
// is itself worth caching, so a permanently-unresolvable classic (e.g. one
// only ever released on a soundtrack/compilation) doesn't get retried from
// scratch every sync either.
export const trackAlbumResolutionCache = pgTable(
  'track_album_resolution_cache',
  {
    id: serial('id').primaryKey(),
    artistName: text('artist_name').notNull(),
    trackName: text('track_name').notNull(),
    releaseGroupMbid: uuid('release_group_mbid'),
    // MusicBrainz artist MBID for the resolved release-group's credited
    // artist -- lets a cache hit still look the artist up directly in Lidarr
    // (see autoRequestMissingPlaylistTracks) instead of falling back to a
    // fuzzy artist-name text search. Nullable: rows written before this
    // column existed, and negative-cache rows (no resolvable release-group),
    // legitimately have no artist to record.
    artistMbid: uuid('artist_mbid'),
    albumTitle: text('album_title'),
    cachedAt: timestamp('cached_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    naturalKey: uniqueIndex('track_album_resolution_cache_key_idx').on(
      table.artistName,
      table.trackName,
    ),
  }),
)

export const artistBlocks = pgTable(
  'artist_blocks',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    artistId: integer('artist_id')
      .notNull()
      .references(() => artists.id, { onDelete: 'cascade' }),
    reason: text('reason'),
    reasonText: text('reason_text'),
    source: text('source').notNull().default('rejection'),
    blockedAt: timestamp('blocked_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    userArtistUnique: uniqueIndex('artist_blocks_user_artist_idx').on(table.userId, table.artistId),
    userIdx: index('artist_blocks_user_idx').on(table.userId),
    artistIdx: index('artist_blocks_artist_idx').on(table.artistId),
  }),
)

export const albumBlocks = pgTable(
  'album_blocks',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    artistId: integer('artist_id')
      .notNull()
      .references(() => artists.id, { onDelete: 'cascade' }),
    releaseGroupMbid: text('release_group_mbid').notNull(),
    reason: text('reason'),
    reasonText: text('reason_text'),
    source: text('source').notNull().default('rejection'),
    blockedAt: timestamp('blocked_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    userReleaseGroupUnique: uniqueIndex('album_blocks_user_release_group_idx').on(
      table.userId,
      table.releaseGroupMbid,
    ),
    userIdx: index('album_blocks_user_idx').on(table.userId),
    artistIdx: index('album_blocks_artist_idx').on(table.artistId),
  }),
)
