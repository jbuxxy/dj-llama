import type { GenreInfo } from '../../core/genre/types'
import type { NotificationChannel } from '../../core/notifications/types'

export type LibraryArtist = {
  id: number
  mbid: string
  name: string
  disambiguation: string | null
  genres: string[] | null
  imageUrl: string | null
}

const BASE = '/api/v1'

const AUTH_TOKEN_KEY = 'djllama-auth-token'
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export function getLegacyStoredToken(): string | null {
  try {
    return localStorage.getItem(AUTH_TOKEN_KEY)
  } catch {
    return null
  }
}

export function clearStoredToken(): void {
  try {
    localStorage.removeItem(AUTH_TOKEN_KEY)
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public data: unknown,
  ) {
    super(extractApiErrorMessage(status, data))
  }
}

function extractApiErrorMessage(status: number, data: unknown): string {
  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>
    if (typeof record.title === 'string' && record.title.trim()) {
      return record.title
    }
    if (typeof record.error === 'string' && record.error.trim()) {
      return record.error
    }
    if (typeof record.message === 'string' && record.message.trim()) {
      return record.message
    }
  }

  return `API Error ${status}`
}

// Fired when any fetchApi call gets 401 - AuthGate listens and shows login
export const AUTH_EXPIRED_EVENT = 'djllama:auth-expired'

function getBrowserHeaders(options?: RequestInit): Headers {
  const headers = new Headers(options?.headers)
  headers.delete('Authorization')

  // Skip Content-Type for FormData - browser sets it with the correct boundary
  if (options?.body instanceof FormData) {
    headers.delete('Content-Type')
  } else if (!headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  const method = (options?.method ?? 'GET').toUpperCase()
  if (SAFE_METHODS.has(method)) {
    headers.delete('X-DJLlama-CSRF')
  } else {
    headers.set('X-DJLlama-CSRF', '1')
  }

  return headers
}

async function fetchApi<T>(path: string, options?: RequestInit): Promise<T> {
  const { headers: _extraHeaders, ...restOptions } = options ?? {}
  const res = await fetch(`${BASE}${path}`, {
    ...restOptions,
    credentials: 'same-origin',
    headers: getBrowserHeaders(options),
  })
  if (!res.ok) {
    if (res.status === 401) {
      clearStoredToken()
      window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT))
      throw new ApiError(res.status, { error: 'Session expired' })
    }
    const error = await res.json().catch(() => ({ error: res.statusText }))
    throw new ApiError(res.status, error)
  }
  if (res.status === 204) {
    return undefined as T
  }
  return res.json() as Promise<T>
}

function authedRawFetch(path: string, options?: RequestInit): Promise<Response> {
  const { headers: _extraHeaders, ...restOptions } = options ?? {}
  return fetch(`${BASE}${path}`, {
    ...restOptions,
    credentials: 'same-origin',
    headers: getBrowserHeaders(options),
  })
}

// Auth
export type AuthStatus = {
  required: boolean
  hasUsers: boolean
  registrationOpen?: boolean
  authenticated?: boolean
  userId?: number
  isAdmin?: boolean
  // Whether this Plex identity currently has access to the admin-picked
  // Music library section(s). Admins always read as true. False (for a
  // non-admin) means the app should show a "contact your admin" screen
  // rather than the app itself -- see auth-gate.tsx.
  hasMusicAccess?: boolean
  // True until the very first (owner) Plex login completes bootstrap -- the
  // sign-in screen shows different copy while this is true. See auth-gate.tsx.
  bootstrapRequired?: boolean
  // Live check (not just "was setup ever completed") -- true whenever
  // settings.lidarrUrl/lidarrApiKey are unset. Lidarr can't be toggled off
  // in Settings, so this gates the whole app behind fixing it rather than
  // letting a broken core connection run silently. See auth-gate.tsx.
  lidarrRequired?: boolean
  // Live check -- true whenever settings.aiProvider/aiModel are unset.
  // Unlike lidarrRequired this only gates the Recommendations feature (see
  // AiRequiredRoute in App.tsx), not the whole app.
  aiRequired?: boolean
  // version is auth-gated on /auth/meta - do NOT re-add it here without
  // rechecking the fingerprint-hardening audit (1.5).
}
export const getAuthStatus = () => fetchApi<AuthStatus>('/auth/status')

export type PlexLoginStart = { authAppUrl: string }
export const startPlexLogin = (sameTab = false) =>
  fetchApi<PlexLoginStart>(`/auth/plex/start${sameTab ? '?sameTab=1' : ''}`, { method: 'POST' })

export type PlexSection = { id: string; title: string; type: string }
export type PlexServerChoice = { name: string; machineIdentifier: string }
export type PlexLoginPoll =
  | { status: 'pending' }
  | { status: 'complete' }
  | { status: 'select-server'; servers: PlexServerChoice[] }
  | { status: 'select-library'; sections: PlexSection[] }
export const pollPlexLogin = () => fetchApi<PlexLoginPoll>('/auth/plex/poll')

export const selectPlexServer = (machineIdentifier: string) =>
  fetchApi<Extract<PlexLoginPoll, { status: 'select-library' }>>('/auth/plex/select-server', {
    method: 'POST',
    body: JSON.stringify({ machineIdentifier }),
  })

export const selectPlexLibrary = (sectionIds: string[]) =>
  fetchApi<{ status: 'complete' }>('/auth/plex/select-library', {
    method: 'POST',
    body: JSON.stringify({ sectionIds }),
  })

export type UserProfile = {
  id: number
  username: string
  isAdmin: boolean
  email: string | null
}
export async function getCurrentUser(): Promise<UserProfile | null> {
  try {
    const res = await fetch(`${BASE}/auth/me`, { credentials: 'same-origin' })
    if (!res.ok) return null
    return res.json() as Promise<UserProfile>
  } catch {
    return null
  }
}
export type SessionMigrationResult = 'migrated' | 'legacy-rejected' | 'invalid'

export async function migrateLegacySession(token: string): Promise<SessionMigrationResult> {
  const res = await fetch(`${BASE}/auth/session/migrate`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      Authorization: `Bearer ${token}`,
      'X-DJLlama-CSRF': '1',
      'X-DJLlama-Auth-Mode': 'cookie',
    },
  })
  if (res.status === 204) return 'migrated'
  if (res.status === 401) return 'invalid'

  const body = (await res.json().catch(() => ({ error: res.statusText }))) as {
    type?: string
    error?: string
  } | null
  if (res.status === 403 && body?.type === '/problems/auth-session-migration-legacy-token') {
    return 'legacy-rejected'
  }
  throw new ApiError(res.status, body)
}
export const logoutUser = () => fetchApi<void>('/auth/logout', { method: 'POST' })

// Setup
export const getSetupStatus = () => fetchApi<{ setupComplete: boolean }>('/setup/status')
export const completeSetup = (config: Record<string, unknown>) =>
  fetchApi('/setup/complete', { method: 'POST', body: JSON.stringify(config) })

// Settings
export const getSettings = () => fetchApi<Record<string, unknown>>('/settings')
export const updateSettings = (partial: Record<string, unknown>) =>
  fetchApi('/settings', { method: 'PATCH', body: JSON.stringify(partial) })
export const getPlexServerName = () =>
  fetchApi<{ name: string | null }>('/settings/plex-server-name')

// Admin-only: change which Plex library section(s) count as Music, without
// re-authenticating (the server connection is already known-good).
export const getPlexLibrarySections = () =>
  fetchApi<{ sections: PlexSection[]; currentSectionIds: string[] }>(
    '/settings/plex/library-sections',
  )
export const updatePlexLibrarySections = (sectionIds: string[]) =>
  fetchApi<{ success: true }>('/settings/plex/library-sections', {
    method: 'POST',
    body: JSON.stringify({ sectionIds }),
  })

// Admin-only: change which Plex server the whole app connects to. Requires a
// fresh Plex sign-in (the account-level identity token is never persisted),
// so this is the same start/poll/select-server/select-library shape as the
// login flow above, just admin-gated and pointed at different endpoints.
export const startPlexReconfigure = (sameTab = false) =>
  fetchApi<PlexLoginStart>(`/settings/plex/reconfigure/start${sameTab ? '?sameTab=1' : ''}`, {
    method: 'POST',
  })
export const pollPlexReconfigure = () => fetchApi<PlexLoginPoll>('/settings/plex/reconfigure/poll')
export const selectPlexReconfigureServer = (machineIdentifier: string) =>
  fetchApi<Extract<PlexLoginPoll, { status: 'select-library' }>>(
    '/settings/plex/reconfigure/select-server',
    { method: 'POST', body: JSON.stringify({ machineIdentifier }) },
  )
export const selectPlexReconfigureLibrary = (sectionIds: string[]) =>
  fetchApi<{ status: 'complete' }>('/settings/plex/reconfigure/select-library', {
    method: 'POST',
    body: JSON.stringify({ sectionIds }),
  })
export const testService = (service: string, config: Record<string, unknown>) =>
  fetchApi<{
    message: string
    version?: string
    latencyMs?: number
    // Plex probe extras: selected library section + all music-type sections
    sectionId?: string
    sections?: Array<{ key: string; title: string }>
    // Ollama probe extra: models actually installed on the configured server
    models?: string[]
  }>(`/settings/test/${service}`, {
    method: 'POST',
    body: JSON.stringify(config),
  })
export const testNotificationChannel = (channel: NotificationChannel) =>
  fetchApi<void>('/settings/test-webhook', { method: 'POST', body: JSON.stringify(channel) })

// Pipeline
export const triggerPipeline = () =>
  fetchApi<{
    message: string
    status?: 'started' | 'queued' | 'duplicate'
    queued?: boolean
    position?: number
  }>('/pipeline/run', {
    method: 'POST',
  })
export const getPipelineStatus = () =>
  fetchApi<{
    running: boolean
    stage?: string
    message?: string
    queueLength?: number
    queuePosition?: number
    lastRun?: unknown
  }>('/pipeline/status')
export const rescanArtists = () =>
  fetchApi<{ attempted: number; updated: number; failed: number; total: number }>(
    '/pipeline/rescan',
    { method: 'POST' },
  )

// Recommendations
export const getRecommendations = (params?: Record<string, string>) => {
  const qs = params ? `?${new URLSearchParams(params).toString()}` : ''
  return fetchApi<{ items: unknown[]; total: number }>(`/recommendations${qs}`)
}
export type ApprovalTargetSummary = {
  total: number
  succeeded: number
  failed: number
  failures: Array<{ id: string; name: string; error?: string | null }>
  warnings?: string[]
}
export type ApprovalResponse = {
  status: string
  targetActions?: Record<string, unknown>
  targetSummary?: ApprovalTargetSummary
  lidarrError?: string | null
}
export const updateRecommendation = (id: number, body: Record<string, unknown>) =>
  fetchApi<ApprovalResponse>(`/recommendations/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
export const approveRecommendation = (
  id: number,
  options?: {
    monitorOption?: string
    selectedAlbumIds?: string[]
    qualityProfileId?: number
    metadataProfileId?: number
    rootFolderId?: number
    // Deliberately expand an album-kind rec to whole-artist approval (the
    // "approve whole discography" secondary action) instead of the default
    // single-release-group approve.
    expandToDiscography?: boolean
  },
) => updateRecommendation(id, { status: 'approved', ...options })
export const bulkAction = (
  ids: number[],
  action: string,
  options?: { reason?: string | null; permanent?: boolean },
) =>
  fetchApi('/recommendations/bulk', {
    method: 'POST',
    body: JSON.stringify({ ids, action, ...options }),
  })

export const getFeedbackSummary = () =>
  fetchApi<{
    summary: Array<{
      genre: string
      approved: number
      rejected: number
      total: number
      rate: number
    }>
  }>('/recommendations/feedback-summary')

// Albums
export type ReleaseGroup = {
  id: string
  title: string
  type: string
  firstReleaseDate?: string
}
export const getAlbums = (mbid: string) =>
  fetchApi<ReleaseGroup[]>(`/albums/${encodeURIComponent(mbid)}`)

export type ArtistEnrichment = {
  description: string | null
  externalLinks: Record<string, string>
  wikidataId: string | null
}
export const getArtistEnrichment = (id: number) =>
  fetchApi<ArtistEnrichment>(`/artists/${id}/enrichment`)

// Listening
export type ListeningTopRange = 'this_week' | 'this_month' | 'this_year' | 'all_time'

export type TopArtistEntry = {
  artist: string
  track: string
  source: string
  imageUrl?: string
  mbid?: string
}

export type RecentTrackEntry = {
  artist: string
  track: string
  source: string
  imageUrl?: string
  playedAt?: string
  nowPlaying?: boolean
  mbid?: string
}

export const getTopArtists = (range: ListeningTopRange, offset = 0, limit = 5) => {
  const qs = new URLSearchParams({ range, offset: String(offset), limit: String(limit) })
  return fetchApi<{
    tracks: TopArtistEntry[]
    total: number
    offset: number
    limit: number
    hasSource: boolean
    source: 'plex' | 'spotify' | null
  }>(`/listening/top-artists?${qs}`)
}

export const getRecentTracks = (range: ListeningTopRange, offset = 0, limit = 5) => {
  const qs = new URLSearchParams({ range, offset: String(offset), limit: String(limit) })
  return fetchApi<{
    tracks: RecentTrackEntry[]
    total: number
    offset: number
    limit: number
    hasSource: boolean
    source: 'plex' | 'spotify' | null
  }>(`/listening/recent-tracks?${qs}`)
}

// Quick discover
export const quickDiscover = (
  artistName: string,
  options?: { suggestedAlbum?: string; reasoning?: string },
) =>
  fetchApi<{ message: string }>('/pipeline/quick-discover', {
    method: 'POST',
    body: JSON.stringify({ artistName, ...options }),
  })

// Analytics
export type AnalyticsOverview = {
  totalRecs: number
  approvalRate: number
  avgScore: number
  totalBatches: number
}
export type AnalyticsBatch = {
  id: number
  createdAt: string
  status: string
  stats: unknown
  total: number
  approved: number
  rejected: number
  pending: number
}
export type AnalyticsGenre = {
  genre: string
  count: number
  approved: number
  approvalRate: number
}
export const getAnalyticsOverview = () => fetchApi<AnalyticsOverview>('/analytics/overview')
export const getAnalyticsBatches = () => fetchApi<AnalyticsBatch[]>('/analytics/batches')
export const getAnalyticsGenres = () => fetchApi<AnalyticsGenre[]>('/analytics/genres')
export type ApprovalTrend = {
  batchId: number
  createdAt: string
  approvalRate: number
  approved: number
  acted: number
}
export const getApprovalTrend = () => fetchApi<ApprovalTrend[]>('/analytics/trend')

// Lidarr
export const getLidarrProfiles = () =>
  fetchApi<Array<{ id: number; name: string }>>('/lidarr/profiles')
export const getLidarrMetadataProfiles = () =>
  fetchApi<Array<{ id: number; name: string }>>('/lidarr/metadataprofiles')
export const getLidarrRootFolders = () =>
  fetchApi<Array<{ id: number; path: string; freeSpace?: number }>>('/lidarr/rootfolders')

// Library Health
export type HealthCheckItem = {
  artistId: number
  artistName: string
  mbid: string
  detail: string
}
export type HealthCheckResult = {
  id: string
  name: string
  description: string
  severity: 'info' | 'warning' | 'error'
  count: number
  items: HealthCheckItem[]
  fixable: boolean
}
export type HealthCheckResponse = {
  checks: HealthCheckResult[]
  scanning: boolean
  lastStartedAt: string | null
  lastCompletedAt: string | null
  lastError: string | null
  syncIntervalHours: number
}
export type LibraryStats = {
  totalArtists: number
  totalAlbums: number
  monitoredArtists: number
  genreDistribution: Array<{ genre: string; count: number }>
  rootFolders: Array<{ path: string; freeSpace: number }>
}
export const getLibraryHealth = () => fetchApi<HealthCheckResponse>('/library/health')
export const scanLibraryHealth = () =>
  fetchApi<{ scanning: boolean }>('/library/health/scan', { method: 'POST' })
export type HealthFixResult = {
  checkId: string
  total: number
  completed: number
  failed: number
  status: 'completed' | 'failed'
  errors: string[]
}
export const fixHealthCheck = (checkId: string) =>
  fetchApi<HealthFixResult>(`/library/health/${encodeURIComponent(checkId)}/fix`, {
    method: 'POST',
  })
export const getLibraryStats = () => fetchApi<LibraryStats>('/library/stats')

// Genres
export const getGenres = () => fetchApi<GenreInfo[]>('/genres')

export type GenreArtist = {
  name: string
  mbid: string
  imageUrl: string | null
  score: number
  genres: string[] | null
  aiReasoning: string | null
  streamingUrls: Record<string, string> | null
}

export const getGenreArtists = (slug: string, view: string, limit = 20) =>
  fetchApi<{ artists: GenreArtist[] }>(
    `/genres/${encodeURIComponent(slug)}/artists?view=${encodeURIComponent(view)}&limit=${limit}`,
  )

// Library warm status
export const getWarmStatuses = (mbids: string) =>
  fetchApi<{ statuses: Record<string, string> }>(`/library/warm/status?mbids=${mbids}`)
export const warmArtists = (mbids: string[]) =>
  fetchApi('/library/warm', {
    method: 'POST',
    body: JSON.stringify({ mbids }),
  })

// Library sync
// LibrarySyncCounts mirrors src/db/schema.ts - redeclared here to avoid pulling drizzle into the web bundle
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
  mbApiCallsFailed?: number
  estimatedSecondsRemaining?: number
  albumsSynced?: number
}
export type LibrarySyncSourceRow = {
  id: number
  userId: number | null
  source: string
  lastSyncStartedAt: string | null
  lastSyncCompletedAt: string | null
  lastSyncStatus: string | null
  lastSyncError: string | null
  lastSyncCounts: LibrarySyncCounts | null
}
export type LibraryUnreconciledRow = {
  id: number
  userId: number | null
  source: string
  sourceArtistId: string
  name: string
  nameNormalized: string
  mbid: string | null
  matchMethod: string | null
  matchConfidence: number | null
  genres: string[] | null
  syncedAt: string
}
export type LibrarySourceSyncResult =
  | { source: string; status: 'completed'; counts: LibrarySyncCounts }
  | { source: string; status: 'skipped_fresh'; counts: LibrarySyncCounts | null }
  | { source: string; status: 'failed'; error: string }
export type LibrarySyncSummary = {
  userId: number | null
  results: LibrarySourceSyncResult[]
}
export type LibraryOverrideInput = {
  source: string
  sourceArtistId: string
  correctMbid: string | null
  note?: string
}
export type LibraryAlbumCoverage = {
  artistMbid: string
  ownedCount: number
  totalCount: number
  owned: Array<{
    albumMbid: string
    title: string
    releaseYear: number | null
  }>
  missing: Array<{
    albumMbid: string
    title: string
    releaseYear: number | null
  }>
}
export type LibraryUnreconciledAlbumRow = {
  id: number
  userId: number | null
  source: string
  sourceArtistId: string
  sourceAlbumId: string
  title: string
  titleNormalized: string
  albumMbid: string | null
  artistMbid: string | null
  primaryType: string | null
  releaseYear: number | null
  syncedAt: string
}
export type LibraryAlbumOverrideInput = {
  source: string
  sourceAlbumId: string
  correctAlbumMbid: string | null
  note?: string
}
export const getLibrarySources = () =>
  fetchApi<{ sources: LibrarySyncSourceRow[] }>('/library/sources')
// Returns LibrarySourceSyncResult when source is given, LibrarySyncSummary when not.
// Caller can distinguish by presence of `results` (summary) vs `status` (single result).
export const triggerLibrarySync = (source?: string) =>
  fetchApi<LibrarySourceSyncResult | LibrarySyncSummary>('/library/sync', {
    method: 'POST',
    body: JSON.stringify(source ? { source } : {}),
  })
export const getLibraryUnreconciled = () =>
  fetchApi<{ items: LibraryUnreconciledRow[] }>('/library/unreconciled')
export const getLibraryAlbumCoverage = (artistMbid: string) =>
  fetchApi<LibraryAlbumCoverage>(`/library/album-coverage/${encodeURIComponent(artistMbid)}`)
export const getLibraryUnreconciledAlbums = () =>
  fetchApi<{ items: LibraryUnreconciledAlbumRow[] }>('/library/unreconciled-albums')
export const saveLibraryOverride = (payload: LibraryOverrideInput) =>
  fetchApi<void>('/library/overrides', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
export const saveLibraryAlbumOverride = (payload: LibraryAlbumOverrideInput) =>
  fetchApi<void>('/library/album-overrides', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
export const rerunLibraryReconciler = () => fetchApi<void>('/library/reconcile', { method: 'POST' })

// User management (admin) -- accounts are Plex-driven: added/removed
// automatically by the sync job, not created/deleted by hand. Manual levers:
// the admin toggle, and the auto-approve-requests trust flag.
export type AdminUser = {
  id: number
  username: string
  isAdmin: boolean
  isOwner: boolean
  autoApproveRequests: boolean
  email: string | null
  authProvider: string
  hasMusicAccess: boolean
  createdAt: string
  hasSignedIn: boolean
  lastSignInAt: string | null
}
export const listUsers = () => fetchApi<AdminUser[]>('/users')
export const updateUserAdmin = (id: number, isAdmin: boolean) =>
  fetchApi(`/users/${id}`, { method: 'PATCH', body: JSON.stringify({ isAdmin }) })
export const updateUserAutoApproveRequests = (id: number, autoApproveRequests: boolean) =>
  fetchApi(`/users/${id}`, { method: 'PATCH', body: JSON.stringify({ autoApproveRequests }) })
export const deleteUserApi = (id: number) => fetchApi(`/users/${id}`, { method: 'DELETE' })
export type PlexUserSyncResult = { added: number; updated: number; revoked: number; error?: string }
export const syncPlexUsers = () =>
  fetchApi<PlexUserSyncResult>('/users/sync-plex', { method: 'POST' })

// Targets available to approve/dispatch to (read-only -- Lidarr is a
// global connection configured in Settings, not a per-user manual target)
export type TargetInfo = {
  id: number
  type: string
  name: string
  enabled: boolean
  owned: boolean
}
export const listTargets = () => fetchApi<TargetInfo[]>('/targets')

// Target-aware approve
export async function approveToTarget(
  recId: number,
  targetId: string,
  options?: {
    monitorOption?: string
    selectedAlbumIds?: string[]
    qualityProfileId?: number
    metadataProfileId?: number
    rootFolderId?: number
    expandToDiscography?: boolean
  },
): Promise<ApprovalResponse> {
  return fetchApi(`/recommendations/${recId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      status: 'approved',
      targetId,
      ...options,
    }),
  })
}

export async function exportRecommendations(
  format: 'json' | 'csv' | 'm3u' | 'xspf',
  params?: { status?: string; batchId?: number },
) {
  const query = new URLSearchParams()
  if (params?.status) query.set('status', params.status)
  if (params?.batchId) query.set('batchId', String(params.batchId))
  const qs = query.toString() ? `?${query}` : ''
  const response = await authedRawFetch(`/exports/${format}${qs}`)
  if (!response.ok) throw new Error('Export failed')
  await downloadResponseBlob(
    response,
    `djllama-export-${new Date().toISOString().slice(0, 10)}.${format}`,
  )
}

async function downloadResponseBlob(response: Response, fallbackFilename: string): Promise<void> {
  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = getDownloadFilename(response.headers.get('content-disposition'), fallbackFilename)
  a.click()
  URL.revokeObjectURL(url)
}

function getDownloadFilename(contentDisposition: string | null, fallbackFilename: string): string {
  const match = /filename="([^"]+)"/.exec(contentDisposition ?? '')
  return match?.[1] ?? fallbackFilename
}

// Requests -- user-submitted, admin-approved artist/album requests dispatched
// to Lidarr. Distinct from Recommendations (AI-curated, self-approve).
export type RequestSearchAlbum = {
  kind: 'album'
  artistMbid?: string
  artistName?: string
  releaseGroupMbid: string
  albumTitle: string
  releaseDate?: string
  coverUrl?: string
  alreadyOwned: boolean
}
export type RequestSearchArtist = {
  kind: 'artist'
  artistMbid: string
  artistName: string
  genres: string[]
  coverUrl?: string
}
export type RequestSearchResults = {
  albums: RequestSearchAlbum[]
  artists: RequestSearchArtist[]
}

export const searchRequestable = (q: string) =>
  fetchApi<RequestSearchResults>(`/requests/search?q=${encodeURIComponent(q)}`)

export type RequestSearchTrack = {
  recordingMbid: string
  trackName: string
  artistMbid: string
  artistName: string
  releaseGroupMbid: string
  albumTitle: string
  releaseDate?: string
  primaryType: string
  secondaryTypes?: string[]
  coverUrl?: string
  inLidarr: boolean
}

export const searchTracksRequestable = (q: string) =>
  fetchApi<{ tracks: RequestSearchTrack[] }>(`/requests/search-tracks?q=${encodeURIComponent(q)}`)

export type IdentifySongResult =
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

export const identifySong = (audio: Blob, filename: string) => {
  const formData = new FormData()
  formData.append('file', audio, filename)
  return fetchApi<IdentifySongResult>('/identify', { method: 'POST', body: formData })
}

export type RequestStatus = 'pending' | 'dispatched' | 'failed' | 'rejected'
export type RequestRecord = {
  id: number
  requestedByUserId: number
  kind: 'artist' | 'album'
  artistMbid: string
  artistName: string
  releaseGroupMbid: string | null
  albumTitle: string | null
  coverUrl: string | null
  status: RequestStatus
  targetActions: Record<string, unknown> | null
  rejectionReason: string | null
  decidedByUserId: number | null
  createdAt: string
  decidedAt: string | null
  libraryConfirmedAt: string | null
  dismissedAt: string | null
}
export type PendingRequestRecord = RequestRecord & { requestedByUsername: string }

export type CreateRequestInput = {
  kind: 'artist' | 'album'
  artistMbid: string
  artistName: string
  releaseGroupMbid?: string
  albumTitle?: string
  coverUrl?: string
}

export const createRequest = (data: CreateRequestInput) =>
  fetchApi<RequestRecord>('/requests', { method: 'POST', body: JSON.stringify(data) })

export type ListRequestsResult = {
  items: RequestRecord[]
  total: number
  failedCount?: number
  // True while a "Retry failed" run for this user is still going.
  retryingFailed?: boolean
}

export const listMyRequests = (params?: Record<string, string>) => {
  const qs = params ? `?${new URLSearchParams(params).toString()}` : ''
  return fetchApi<ListRequestsResult>(`/requests${qs}`)
}

export const listPendingRequests = () => fetchApi<PendingRequestRecord[]>('/requests/pending')

export const approveRequest = (id: number) =>
  fetchApi<RequestRecord>(`/requests/${id}/approve`, { method: 'POST' })

export const rejectRequest = (id: number, rejectionReason?: string) =>
  fetchApi<RequestRecord>(`/requests/${id}/reject`, {
    method: 'POST',
    body: JSON.stringify({ rejectionReason }),
  })

export const retryRequest = (id: number) =>
  fetchApi<RequestRecord>(`/requests/${id}/retry`, { method: 'POST' })

export const retryFailedRequests = () =>
  fetchApi<{ retrying: number }>('/requests/retry-failed', { method: 'POST' })

export const dismissRequest = (id: number) =>
  fetchApi<void>(`/requests/${id}/dismiss`, { method: 'POST' })

export const dismissAllInLibraryRequests = () =>
  fetchApi<{ count: number }>('/requests/dismiss-all', { method: 'POST' })

export type ArtistRequestDetail = {
  artistMbid: string
  artistName: string
  genres: string[]
  coverUrl?: string
}
export const getRequestArtistDetail = (mbid: string) =>
  fetchApi<ArtistRequestDetail>(`/requests/artist/${encodeURIComponent(mbid)}`)

export type AlbumTrack = {
  title: string
  position: string
  length?: number
}
export type AlbumRequestDetail = {
  releaseGroupMbid: string
  albumTitle: string
  artistMbid?: string
  artistName?: string
  releaseDate?: string
  coverUrl?: string
  alreadyOwned: boolean
  tracks: AlbumTrack[]
}
export const getRequestAlbumDetail = (mbid: string) =>
  fetchApi<AlbumRequestDetail>(`/requests/album/${encodeURIComponent(mbid)}`)

// Mood discovery
export const moodDiscover = (query: string) =>
  fetchApi<{
    results: Array<{
      artistName: string
      reasoning: string
      confidence: number
      genres: string[]
      suggestedAlbum?: string
      coverUrl?: string
      alreadyOwned: boolean
    }>
  }>('/mood/discover', { method: 'POST', body: JSON.stringify({ query }) })

// OAuth
export async function initiateOAuth(
  provider: string,
  data: Partial<{ clientId: string; clientSecret: string; redirectUri: string }> = {},
): Promise<{ authUrl: string }> {
  return fetchApi(`/auth/oauth/${provider}/initiate`, {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

// User preferences (per-user scoring weights, thresholds, etc.)
export const getUserPreferences = () => fetchApi<Record<string, unknown>>('/auth/me/preferences')
export const updateUserPreferences = (prefs: Record<string, unknown>) =>
  fetchApi('/auth/me/preferences', { method: 'PATCH', body: JSON.stringify(prefs) })

export async function disconnectOAuth(provider: string): Promise<void> {
  await fetchApi(`/auth/oauth/${provider}`, { method: 'DELETE' })
}

export async function getOAuthStatus(provider: string): Promise<{
  connected: boolean
  scopes: string | null
  accountLabel: string | null
  accountTier: string | null
}> {
  return fetchApi(`/auth/oauth/${provider}/status`)
}

export async function getPopularAlbumsAvailability(): Promise<{
  available: boolean
  spotify: boolean
}> {
  return fetchApi('/recommendations/popular-albums/availability')
}

// Dashboard
export type TasteGenre = {
  genre: string
  count: number
  percentage: number
}

export type TasteProfile = {
  genres: TasteGenre[]
  // AI-generated persona title + reasoning -- absent when no AI provider is
  // configured, in which case the widget shows genres only.
  title?: string
  reasoning?: string
}

export type GenreCoverage = {
  coveredArtists: number
  pendingArtists: number
  totalArtists: number
}

export type ActivityEntry = {
  type: 'approved' | 'rejected' | 'scan_completed' | 'auto_request_added'
  timestamp: string
  data: {
    artistName?: string
    albumTitle?: string
    discovered?: number
    added?: number
    username?: string
    playlistName?: string
  }
}

export const getDashboardTaste = () => fetchApi<TasteProfile>('/dashboard/taste')

export const getDashboardGenreCoverage = () =>
  fetchApi<GenreCoverage | null>('/dashboard/genre-coverage')

export const getDashboardActivity = (limit = 5) =>
  fetchApi<ActivityEntry[]>(`/dashboard/activity?limit=${limit}`)

// Playlists
export type PlaylistConfig = {
  size: number
  genre?: string
  mood?: string
  presetKey?: string
  // for seasonal strategy -- per-row override of the preset's built-in
  // default calendar window
  windowOverride?: { startMonth: number; startDay: number; endMonth: number; endDay: number }
  prompt?: string
  useListeningHistory?: boolean
  genreFilters?: string[]
  decadeFilters?: number[]
  excludeLiveVersions?: boolean
  trackSourcePriority: ('local' | 'spotify' | 'deezer')[]
  importSource?: 'spotify' | 'deezer' | 'youtube_music' | 'apple_music'
  importPlaylistId?: string
  importPlaylistName?: string
  mixIndex?: number
}

export type PlaylistRow = {
  id: number
  userId: number | null
  name: string
  strategy: string
  targetIds: number[]
  schedule: string | null
  config: PlaylistConfig | null
  lastGeneratedAt: string | null
  trackCount: number | null
  enabled: boolean
  createdAt: string
  status: 'active' | 'pending_review' | 'expired' | string
  pushedToPlex: boolean
  reviewExpiresAt: string | null
  autoPushToPlex: boolean
  description: string | null
  // Imported playlists only: the source playlist's cover image.
  coverUrl: string | null
  // Up to 4 album covers from the playlist's own tracks, for playlists
  // without a coverUrl (see db/queries/playlist-collage.ts).
  collageUrls?: string[]
}

export type PlaylistMissingTrack = {
  id: number
  playlistId: number
  artistName: string
  trackName: string
  // The source playlist's own tag (Spotify/Apple Music/etc.) -- often a
  // deluxe reissue, compilation, or otherwise-wrong bundle, NOT what DJ Llama
  // actually searches Lidarr for. See resolvedAlbumTitle below for that.
  albumTitle: string | null
  // The album DJ Llama actually resolved and is requesting from Lidarr for
  // this track (MusicBrainz or AI). Null when nothing has resolved yet.
  resolvedAlbumTitle: string | null
  // The source playlist's album art for this track.
  coverUrl: string | null
  reason: 'not_found' | 'search_error' | null
  firstSeenAt: string
  lastSeenAt: string
}

export type PlaylistTrackRow = {
  id: number
  playlistId: number
  artistName: string
  trackName: string | null
  mbid: string | null
  spotifyUri: string | null
  deezerId: string | null
  localPath: string | null
  position: number
}

export type PlaylistInsert = {
  name: string
  strategy: string
  targetIds?: number[]
  schedule?: string | null
  config?: PlaylistConfig | null
  enabled?: boolean
  autoPushToPlex?: boolean
  description?: string | null
}

export const getPlaylists = () => fetchApi<PlaylistRow[]>('/playlists')

export const getPlaylist = (id: number) =>
  fetchApi<{ playlist: PlaylistRow; tracks: PlaylistTrackRow[] }>(`/playlists/${id}`)

export const createPlaylistApi = (data: PlaylistInsert) =>
  fetchApi<{ id: number }>('/playlists', {
    method: 'POST',
    body: JSON.stringify(data),
  })

export const updatePlaylistApi = (id: number, data: Partial<PlaylistInsert>) =>
  fetchApi<void>(`/playlists/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  })

export const deletePlaylistApi = (id: number) =>
  fetchApi<void>(`/playlists/${id}`, { method: 'DELETE' })

export const generatePlaylistApi = (id: number) =>
  fetchApi<{ status: string }>(`/playlists/${id}/generate`, { method: 'POST' })

export const pushPlaylistApi = (id: number) =>
  fetchApi<void>(`/playlists/${id}/push`, { method: 'POST' })

export type AdminImportedPlaylistRow = PlaylistRow & { ownerUsername: string }

export const getAdminImportedPlaylists = () =>
  fetchApi<AdminImportedPlaylistRow[]>('/playlists/admin/imports')

export const generateAdminImportedPlaylistApi = (id: number) =>
  fetchApi<{ status: string }>(`/playlists/admin/${id}/generate`, { method: 'POST' })

export const deleteAdminImportedPlaylistApi = (id: number) =>
  fetchApi<void>(`/playlists/admin/${id}`, { method: 'DELETE' })

export const setAdminImportedPlaylistEnabledApi = (id: number, enabled: boolean) =>
  fetchApi<void>(`/playlists/admin/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ enabled }),
  })

export const duplicatePlaylistApi = (id: number, name?: string) =>
  fetchApi<{ pushed: boolean; itemsAdded: number }>(`/playlists/${id}/duplicate`, {
    method: 'POST',
    body: JSON.stringify({ name }),
  })

export type LiveTrackSweepResult = {
  checked: number
  replaced: Array<{ artistName: string; trackName: string; previousAlbum?: string }>
  stillLive: Array<{ artistName: string; trackName: string; album?: string }>
}

export const sweepPlaylistLiveTracksApi = (id: number) =>
  fetchApi<LiveTrackSweepResult>(`/playlists/${id}/sweep-live-tracks`, { method: 'POST' })

export const getPlaylistMissingTracks = (id: number) =>
  fetchApi<PlaylistMissingTrack[]>(`/playlists/${id}/missing-tracks`)

export const deletePlaylistMissingTrackApi = (id: number, trackId: number) =>
  fetchApi<void>(`/playlists/${id}/missing-tracks/${trackId}`, { method: 'DELETE' })

export type PlaylistSuggestion = {
  artistName: string
  trackName: string
  localPath: string
  // 'classic' = a well-known song for the season, 'title' = seasonal word in
  // the title, 'genre' = from a seasonally-tagged artist.
  reason: string
}

export const removePlaylistTrackApi = (id: number, trackId: number) =>
  fetchApi<void>(`/playlists/${id}/tracks/${trackId}`, { method: 'DELETE' })

export const addPlaylistTrackApi = (
  id: number,
  track: { artistName: string; trackName: string; localPath?: string | null },
) => fetchApi<void>(`/playlists/${id}/tracks`, { method: 'POST', body: JSON.stringify(track) })

export const getPlaylistSuggestions = (id: number) =>
  fetchApi<PlaylistSuggestion[]>(`/playlists/${id}/suggestions`)

export type PlaylistPreviewTrack = {
  artistName: string
  trackName: string
  mbid?: string
  spotifyUri?: string
  deezerId?: string
  localPath?: string
  source: 'local' | 'spotify' | 'deezer' | 'musicbrainz'
}

export type PlaylistPreview = {
  tracks: PlaylistPreviewTrack[]
  artistCount: number
  strategy: string
}

export const previewAiPlaylist = (
  prompt: string,
  size?: number,
  options?: {
    useListeningHistory?: boolean
    genreFilters?: string[]
    decadeFilters?: number[]
    excludeLiveVersions?: boolean
  },
) =>
  fetchApi<PlaylistPreview>('/playlists/preview', {
    method: 'POST',
    body: JSON.stringify({ prompt, size, ...options }),
  })

export const previewPlaylistFilterCountApi = (filters: {
  genreFilters?: string[]
  decadeFilters?: number[]
  excludeLiveVersions?: boolean
}) => {
  const params = new URLSearchParams()
  if (filters.genreFilters && filters.genreFilters.length > 0) {
    params.set('genres', filters.genreFilters.join(','))
  }
  if (filters.decadeFilters && filters.decadeFilters.length > 0) {
    params.set('decades', filters.decadeFilters.join(','))
  }
  if (filters.excludeLiveVersions != null) {
    params.set('excludeLive', String(filters.excludeLiveVersions))
  }
  return fetchApi<{ count: number }>(`/playlists/preview-filter-count?${params}`)
}

export async function exportPlaylistApi(
  id: number,
  format: 'json' | 'csv' | 'm3u' | 'xspf',
): Promise<void> {
  const response = await authedRawFetch(`/playlists/${id}/export/${format}`)
  if (!response.ok) throw new Error('Playlist export failed')
  await downloadResponseBlob(response, `playlist-${id}.${format}`)
}

export const getPlaylistScheduler = () =>
  fetchApi<{ nextRun: string | null; cron: string | null; enabled: boolean }>(
    '/playlists/scheduler',
  )

// Artist top tracks. Pass albumTitle to scope the list (and its ranking) to
// one album, matching what getAlbumPreview loads into the embedded player.
export const getArtistTopTracks = (artistId: number, albumTitle?: string) =>
  fetchApi<{ tracks: Array<{ name: string; previewUrl?: string; durationMs?: number }> }>(
    `/artists/${artistId}/top-tracks${albumTitle ? `?album=${encodeURIComponent(albumTitle)}` : ''}`,
  )

// Spotify track embed for an album-kind recommendation
export const getAlbumPreview = (artistId: number, albumTitle: string) =>
  fetchApi<{ spotifyUrl: string | null }>(
    `/artists/${artistId}/album-preview?album=${encodeURIComponent(albumTitle)}`,
  )

// ── Admin: Backup & Restore ────────────────────

export async function downloadBackup(includeCaches = false): Promise<void> {
  const qs = includeCaches ? '?includeCaches=true' : ''
  const res = await authedRawFetch(`/admin/backup${qs}`, { method: 'POST' })
  if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => ({})))
  await downloadResponseBlob(res, 'djllama-backup.json')
}

export const restoreBackupApi = async (file: File, force = false) => {
  const formData = new FormData()
  formData.append('file', file)
  const qs = force ? '?force=true' : ''
  return fetchApi<{
    tablesRestored: Record<string, number>
    warnings: string[]
    encryptionMismatch: boolean
    affectedEncryptedFields: string[]
  }>(`/admin/restore${qs}`, {
    method: 'POST',
    body: formData,
  })
}

// ── Admin: System ──────────────────────────────

export type SystemInfo = {
  version: string
  gitSha: string
  channel: string
  dbBackend: 'postgres' | 'pglite'
  schemaVersion: string | null
  pendingMigrations: number
  lastAutoBackup: { filename: string; createdAt: string } | null
}
export const getSystemInfo = () => fetchApi<SystemInfo>('/admin/system')

// ── Admin: Migrate Backend ─────────────────────

type MigrateTarget = { backend: 'pglite'; path: string } | { backend: 'postgres'; dsn: string }

export const testMigrateTarget = (target: MigrateTarget) =>
  fetchApi<{ ok: boolean; backend?: string; description?: string; error?: string; code?: string }>(
    '/admin/migrate-backend/test',
    { method: 'POST', body: JSON.stringify(target) },
  )

export const migrateBackendApi = (target: MigrateTarget, overwrite = false) =>
  fetchApi<{
    ok: boolean
    verified: boolean
    contentVerified: boolean
    targetBackend: string
    targetDescription: string
    tablesMigrated: Record<string, number>
    excludedTables: string[]
    mismatches: { table: string; source: number; target: number; contentDiffers?: boolean }[]
    targetEnvHint: string
  }>('/admin/migrate-backend', {
    method: 'POST',
    body: JSON.stringify({ target, overwrite }),
  })

// ── Admin: Hygiene ─────────────────────────────

export const clearImageFailures = () =>
  fetchApi<{ cleared: number }>('/admin/hygiene/clear-image-failures', { method: 'POST' })

// Jobs

export type JobRun = {
  id: number
  type: string
  status: string
  userId: number | null
  startedAt: string
  completedAt: string | null
  durationMs: number | null
  error: string | null
  metadata: Record<string, unknown>
  sourceResults: Record<
    string,
    { status: string; artists?: number; ms?: number; error?: string; reason?: string }
  > | null
  subscriptionId: number | null
  batchId: number | null
}

export type JobHealthStatus = 'ok' | 'warning' | 'failing' | 'never'
export type JobHealthEntry = {
  status: JobHealthStatus
  running: boolean
  lastSuccessAt: string | null
  lastProblem: { at: string; error: string | null } | null
}
export type JobHealth = {
  discovery: JobHealthEntry & { nextRunAt: string | null }
  playlists: JobHealthEntry & { recentRuns: number; recentFailures: number }
  librarySync: JobHealthEntry
  sources: {
    name: string
    ok: boolean
    error: string | null
    role: 'history' | 'candidates' | 'tracks'
    artists: number | null
  }[]
}

export const getJobHealth = () => fetchApi<JobHealth>('/jobs/health')

export const listJobs = (params?: {
  type?: string
  status?: string
  limit?: number
  offset?: number
}) => {
  const sp = new URLSearchParams()
  if (params?.type) sp.set('type', params.type)
  if (params?.status) sp.set('status', params.status)
  if (params?.limit !== undefined) sp.set('limit', String(params.limit))
  if (params?.offset !== undefined) sp.set('offset', String(params.offset))
  const qs = sp.toString()
  return fetchApi<{ items: JobRun[]; total: number }>(`/jobs${qs ? `?${qs}` : ''}`)
}

export const getJob = (id: number) => fetchApi<JobRun>(`/jobs/${id}`)
