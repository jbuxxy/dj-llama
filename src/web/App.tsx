import { QueryClientProvider, useQuery } from '@tanstack/react-query'
import {
  Compass,
  Download,
  LayoutDashboard,
  ListMusic,
  Lock,
  LogOut,
  Mic,
  Monitor,
  Moon,
  Radar,
  Search,
  Settings,
  Sun,
  SunMoon,
  User,
} from 'lucide-react'
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { BrowserRouter, Navigate, NavLink, Route, Routes } from 'react-router-dom'
import { Toaster, toast } from 'sonner'
import { errMsg } from '@/core/validation'
import { CHANNEL, GIT_SHA, VERSION } from '@/version'
import { AuthGate } from './components/auth-gate'
import { BottomNav } from './components/bottom-nav'
import { ErrorBoundary } from './components/error-boundary'
import { KeyboardShortcuts } from './components/keyboard-shortcuts'
import { PreviewPlayer } from './components/preview-player'
import { SongIdentifyDialog } from './components/song-identify-dialog'
import { useAuditionQueue } from './hooks/use-audition-queue'
import { useClickOutside } from './hooks/use-click-outside'
import { useInstallPrompt } from './hooks/use-install-prompt'
import { useKeyboardShortcuts } from './hooks/use-keyboard-shortcuts'
import { usePreview } from './hooks/use-preview'
import {
  AUTH_EXPIRED_EVENT,
  clearStoredToken,
  getAuthStatus,
  getCurrentUser,
  getPipelineStatus,
  getSetupStatus,
  listPendingRequests,
  logoutUser,
  triggerPipeline,
} from './lib/api'
import { PreviewContext } from './lib/preview-context'
import { queryClient } from './lib/query-client'
import { applyTheme, getStoredMode, type Mode, setStoredMode } from './lib/theme'
import { useRealtimeUpdates } from './lib/use-realtime-updates'
// Eager: dashboard is the default landing surface and setup gates the entire app
import { Dashboard } from './pages/dashboard'
import { SetupWizard } from './pages/setup'

// Lazy: secondary routes split into per-page bundles to shrink first paint
const ArtistDiscographyPage = lazy(() =>
  import('./pages/artist-discography').then((m) => ({ default: m.ArtistDiscographyPage })),
)
const AlbumDetailsPage = lazy(() =>
  import('./pages/album-details').then((m) => ({ default: m.AlbumDetailsPage })),
)
const DiscoverPage = lazy(() =>
  import('./pages/discover').then((m) => ({ default: m.DiscoverPage })),
)
const PlaylistDetailPage = lazy(() =>
  import('./pages/playlist-detail').then((m) => ({ default: m.PlaylistDetailPage })),
)
const PlaylistsPage = lazy(() =>
  import('./pages/playlists').then((m) => ({ default: m.PlaylistsPage })),
)
const RequestsPage = lazy(() =>
  import('./pages/requests').then((m) => ({ default: m.RequestsPage })),
)
const SettingsPage = lazy(() =>
  import('./pages/settings').then((m) => ({ default: m.SettingsPage })),
)
const UserManagementPage = lazy(() =>
  import('./pages/user-management').then((m) => ({ default: m.UserManagementPage })),
)

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {})
}

// App shell

// Theme mode section rendered inline inside the profile dropdown (UserMenu) --
// folded in here rather than kept as its own top-level header button so the
// nav bar only has one "settings-ish" icon to hunt for.
function ThemeSection({ mode, onModeChange }: { mode: Mode; onModeChange: (m: Mode) => void }) {
  return (
    <div className="border-b border-border py-1">
      <div className="px-3 py-1 flex items-center gap-1.5 text-micro uppercase tracking-wider text-muted">
        <SunMoon size={12} aria-hidden="true" />
        Mode
      </div>
      <div className="px-3 py-1 flex items-center gap-1">
        {(['dark', 'light', 'system'] as const).map((m) => {
          const Icon = m === 'dark' ? Moon : m === 'light' ? Sun : Monitor
          const label = m === 'dark' ? 'Dark' : m === 'light' ? 'Light' : 'System'
          return (
            <button
              key={m}
              type="button"
              onClick={() => onModeChange(m)}
              aria-label={label}
              aria-pressed={mode === m}
              title={label}
              className={`flex h-8 flex-1 items-center justify-center rounded-md border transition-colors focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-[-2px] ${
                mode === m
                  ? 'bg-accent/10 border-accent/40 text-accent'
                  : 'border-transparent text-muted hover:text-text hover:bg-bg'
              }`}
            >
              <Icon size={14} />
            </button>
          )
        })}
      </div>
    </div>
  )
}

function UserMenu({
  username,
  isAdmin,
  mode,
  onModeChange,
}: {
  username: string
  isAdmin: boolean
  mode: Mode
  onModeChange: (m: Mode) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const { canInstall, showIosHint, promptInstall, dismiss } = useInstallPrompt()

  useClickOutside(ref, () => setOpen(false), open)

  async function handleLogout() {
    try {
      await logoutUser()
    } catch {
      // Session might already be invalid
    }
    clearStoredToken()
    window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT))
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-11 w-11 items-center justify-center rounded-md text-muted transition-colors hover:text-text focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2 sm:h-9 sm:w-9"
        aria-label={username}
        aria-expanded={open}
        aria-haspopup="menu"
        title={username}
      >
        <User size={18} />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 w-48 bg-surface border border-border rounded-lg shadow-lg z-50 py-1">
          <div className="px-3 py-2 border-b border-border">
            <p className="text-sm font-medium text-text truncate">
              {username}
              {isAdmin && (
                <span className="ml-2 text-xs bg-accent text-accent-fg px-1.5 py-0.5 rounded">
                  admin
                </span>
              )}
            </p>
          </div>
          <ThemeSection mode={mode} onModeChange={onModeChange} />
          <NavLink
            to="/settings"
            onClick={() => setOpen(false)}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-muted hover:text-text hover:bg-bg transition-colors"
          >
            <Settings size={14} />
            Settings
          </NavLink>
          {canInstall && (
            <button
              type="button"
              onClick={() => {
                void promptInstall()
                setOpen(false)
              }}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-muted hover:text-text hover:bg-bg transition-colors"
            >
              <Download size={14} />
              Install
            </button>
          )}
          {showIosHint && (
            <div className="px-3 py-2 border-t border-border">
              <p className="text-xs text-muted">Tap the share button, then "Add to Home Screen"</p>
              <button
                type="button"
                onClick={dismiss}
                className="mt-1 text-xs text-accent hover:underline"
              >
                Dismiss
              </button>
            </div>
          )}
          <button
            type="button"
            onClick={handleLogout}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-muted hover:text-text hover:bg-bg transition-colors"
          >
            <LogOut size={14} />
            Log out
          </button>
        </div>
      )}
    </div>
  )
}

function AppShell({ children, aiRequired }: { children: React.ReactNode; aiRequired: boolean }) {
  const [mode, setModeState] = useState<Mode>(getStoredMode)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [identifyOpen, setIdentifyOpen] = useState(false)
  const preview = usePreview()
  const audition = useAuditionQueue(preview)
  const { data: currentUser } = useQuery({ queryKey: ['currentUser'], queryFn: getCurrentUser })
  // Same query key requests.tsx's own admin queue uses -- warms that page's
  // cache and avoids a double-fetch when the admin navigates there from the
  // badge.
  const { data: pendingRequests } = useQuery({
    queryKey: ['requests-pending'],
    queryFn: listPendingRequests,
    enabled: !!currentUser?.isAdmin,
    staleTime: 30_000,
  })
  const pendingRequestsCount = pendingRequests?.length ?? 0
  const { data: pipelineStatus } = useQuery({
    queryKey: ['pipelineStatus'],
    queryFn: getPipelineStatus,
    refetchInterval: (query) => (query.state.data?.running ? 3000 : 15000),
  })
  const pipelineRunning = pipelineStatus?.running ?? false

  useRealtimeUpdates()
  useKeyboardShortcuts({ '?': () => setShortcutsOpen((v) => !v) })

  function handleModeChange(m: Mode) {
    setModeState(m)
    setStoredMode(m)
    applyTheme(m)
  }

  // Listen for system preference changes when in system mode
  useEffect(() => {
    if (mode !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    const handler = () => applyTheme('system')
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [mode])

  const navLinkClass = ({ isActive }: { isActive: boolean }) =>
    isActive ? 'text-text' : 'text-muted hover:text-text'

  return (
    <PreviewContext.Provider
      value={{
        play: preview.play,
        stop: preview.stop,
        hasPreview: preview.hasPreview,
        currentMbid: preview.state.artistMbid,
        playing: preview.state.playing,
        globalPlayId: preview.globalPlayId,
        volume: preview.volume,
        setVolume: preview.setVolume,
        audition,
      }}
    >
      <div className="min-h-screen bg-bg">
        <nav
          // Explicit bg-bg (not left transparent) so this bar reads as a
          // solid app-colored band under iOS's translucent/blurred status
          // bar on a home-screen install, instead of whatever's behind it
          // showing (and blurring) through. Deliberately not sticky: Discover
          // already has its own sticky top-0 toolbar further down the page,
          // and two competing sticky-top elements would fight over the same
          // viewport offset instead of stacking.
          //
          // The extra 14px on top of body's own safe-area-inset-top padding
          // (index.css) is deliberate: iOS's standalone-PWA status bar still
          // visibly blurs/tints whatever sits right at the exact inset
          // boundary (confirmed live -- matching the safe area exactly
          // wasn't enough), so this pushes the logo/buttons a bit further
          // down, clear of wherever that sampling actually starts.
          className="border-b border-border bg-bg px-4 sm:px-6 pb-3"
          style={{ paddingTop: 'calc(0.75rem + 14px)' }}
          aria-label="Main navigation"
        >
          <div className="max-w-6xl mx-auto flex items-center justify-between gap-2">
            <div className="flex items-center gap-4 sm:gap-6 min-w-0">
              <NavLink
                to="/"
                className="flex items-center gap-2 shrink-0 text-2xl font-display tracking-wide text-accent hover:opacity-90"
              >
                <img src="/icon.png" alt="" width="28" height="28" />
                DJ LLAMA
              </NavLink>
              {/* Desktop nav links - grouped */}
              <div className="hidden sm:flex items-center gap-4">
                <NavLink to="/" end className={navLinkClass}>
                  <span className="flex items-center gap-1">
                    <LayoutDashboard size={14} aria-hidden="true" />
                    Dashboard
                  </span>
                </NavLink>
                <NavLink to="/requests" className={navLinkClass}>
                  <span className="flex items-center gap-1">
                    <Search size={14} aria-hidden="true" />
                    Search
                    {pendingRequestsCount > 0 && (
                      <span className="ml-0.5 min-w-4 px-1 h-4 rounded-full bg-accent text-accent-fg text-micro-sm leading-4 text-center font-semibold">
                        {pendingRequestsCount}
                      </span>
                    )}
                  </span>
                </NavLink>
                <NavLink to="/discover" end className={navLinkClass}>
                  <span className="flex items-center gap-1">
                    <Compass size={14} aria-hidden="true" />
                    Discover
                    {aiRequired && <Lock size={11} className="text-muted" aria-hidden="true" />}
                  </span>
                </NavLink>
                <NavLink to="/playlists" className={navLinkClass}>
                  <span className="flex items-center gap-1">
                    <ListMusic size={14} aria-hidden="true" />
                    Playlists
                  </span>
                </NavLink>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                disabled={!!pipelineRunning}
                onClick={() =>
                  triggerPipeline()
                    .then((res) =>
                      toast.success(
                        res.status === 'duplicate'
                          ? 'Scan already running'
                          : res.queued
                            ? `Scan queued (position ${res.position ?? 0}) - it will start when the current run finishes`
                            : 'Scan started - check Dashboard for progress',
                      ),
                    )
                    .catch((err) => {
                      toast.error(errMsg(err))
                    })
                }
                aria-label={pipelineRunning ? 'Scanning...' : 'Run Scan'}
                title={pipelineRunning ? 'Scanning...' : 'Run Scan'}
                className="flex h-11 w-11 items-center justify-center rounded-md bg-accent text-accent-fg hover:opacity-90 focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2 disabled:opacity-60 sm:h-9 sm:w-9"
              >
                <Radar size={18} className={pipelineRunning ? 'animate-spin' : undefined} />
              </button>
              <button
                type="button"
                onClick={() => setIdentifyOpen(true)}
                aria-label="Identify song"
                title="Identify song"
                className="flex h-11 w-11 items-center justify-center rounded-md bg-accent text-accent-fg hover:opacity-90 focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2 disabled:opacity-60 sm:h-9 sm:w-9"
              >
                <Mic size={18} />
              </button>
              {identifyOpen && <SongIdentifyDialog onClose={() => setIdentifyOpen(false)} />}
              {currentUser && (
                <UserMenu
                  username={currentUser.username}
                  isAdmin={currentUser.isAdmin}
                  mode={mode}
                  onModeChange={handleModeChange}
                />
              )}
            </div>
          </div>
        </nav>
        {/* Main content - add pb-16 on mobile so bottom nav doesn't overlap */}
        <main className="pb-16 md:pb-0">{children}</main>
        <BottomNav pendingRequestsCount={pendingRequestsCount} />
        <KeyboardShortcuts open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
        <PreviewPlayer
          playing={preview.state.playing}
          artistName={preview.state.artistName}
          source={preview.state.source}
          loading={preview.state.loading}
          onStop={audition.active ? audition.stop : preview.stop}
          spotify={{
            command: preview.spotifyCommand,
            onPlaybackStarted: preview.onSpotifyPlaybackStarted,
            onPlaybackPaused: preview.onSpotifyPlaybackPaused,
            onPlaybackUnavailable: preview.onSpotifyPlaybackUnavailable,
            onPlaybackEnded: preview.onSpotifyPlaybackEnded,
          }}
          volume={preview.volume}
          onVolumeChange={preview.setVolume}
          queue={
            audition.active
              ? {
                  index: audition.index,
                  count: audition.count,
                  onNext: audition.next,
                  onPrevious: audition.previous,
                }
              : undefined
          }
        />
        <footer className="hidden md:block fixed bottom-2 right-3 text-micro text-muted select-none pointer-events-none z-10">
          v{VERSION}
          {CHANNEL === 'nightly' ? ` (${GIT_SHA.slice(0, 7)})` : ''}
        </footer>
      </div>
    </PreviewContext.Provider>
  )
}

// Inner app - only mounts after AuthGate has resolved auth
function InnerApp() {
  const [setupComplete, setSetupComplete] = useState<boolean | null>(null)
  // Live check (not just "did setup ever finish") -- Lidarr can't be
  // toggled off like every other connection, so if it's ever unset post-setup
  // the whole app gates behind fixing it rather than running with a broken
  // core feature. Re-checked whenever the gate screen calls onRecheck (e.g.
  // right after saving Lidarr in Settings).
  const [lidarrGate, setLidarrGate] = useState<{ required: boolean; isAdmin: boolean } | null>(null)
  // Recommendations-only gate (not app-wide like Lidarr) -- see AiRequiredRoute.
  const [aiRequired, setAiRequired] = useState(false)

  useEffect(() => {
    getSetupStatus()
      .then((s) => setSetupComplete(s.setupComplete))
      .catch(() => setSetupComplete(false))
  }, [])

  const checkLidarrGate = useCallback(() => {
    getAuthStatus()
      .then((s) => {
        setLidarrGate({ required: !!s.lidarrRequired, isAdmin: !!s.isAdmin })
        setAiRequired(!!s.aiRequired)
      })
      .catch(() => {
        setLidarrGate({ required: false, isAdmin: false })
        setAiRequired(false)
      })
  }, [])

  useEffect(() => {
    if (setupComplete) checkLidarrGate()
  }, [setupComplete, checkLidarrGate])

  if (setupComplete === null) return null

  if (!setupComplete) {
    return (
      <>
        <SetupWizard onComplete={() => setSetupComplete(true)} />
        <Toaster theme="system" />
      </>
    )
  }

  if (lidarrGate === null) return null

  if (lidarrGate.required) {
    return (
      <>
        {lidarrGate.isAdmin ? (
          <QueryClientProvider client={queryClient}>
            <BrowserRouter>
              <LidarrRequiredGate onLidarrConfigured={checkLidarrGate} />
            </BrowserRouter>
          </QueryClientProvider>
        ) : (
          <LidarrRequiredForMemberScreen />
        )}
        <Toaster theme="system" />
      </>
    )
  }

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ErrorBoundary>
          <AppShell aiRequired={aiRequired}>
            <Suspense
              fallback={<div className="p-6 text-sm text-muted">{/* lazy route loading */}</div>}
            >
              <Routes>
                <Route path="/" element={<Dashboard />} />
                <Route
                  path="/discover"
                  element={
                    <AiRequiredRoute
                      aiRequired={aiRequired}
                      isAdmin={lidarrGate.isAdmin}
                      onRecheck={checkLidarrGate}
                    >
                      <DiscoverPage />
                    </AiRequiredRoute>
                  }
                />
                <Route path="/playlists" element={<PlaylistsPage />} />
                <Route path="/playlists/:id" element={<PlaylistDetailPage />} />
                <Route path="/subscriptions" element={<Navigate to="/playlists" replace />} />
                <Route path="/search" element={<Navigate to="/requests" replace />} />
                <Route path="/requests" element={<RequestsPage />} />
                <Route path="/requests/artist/:mbid" element={<ArtistDiscographyPage />} />
                <Route path="/requests/album/:mbid" element={<AlbumDetailsPage />} />
                <Route
                  path="/library/health"
                  element={<Navigate to="/settings?tab=library-health" replace />}
                />
                <Route
                  path="/library/reconciliation"
                  element={<Navigate to="/settings?tab=library-health" replace />}
                />
                <Route
                  path="/analytics"
                  element={<Navigate to="/settings?tab=analytics" replace />}
                />
                <Route path="/settings" element={<SettingsPage />} />
                <Route
                  path="/settings/jobs"
                  element={<Navigate to="/settings?tab=system-health" replace />}
                />
                <Route
                  path="/settings/system-health"
                  element={<Navigate to="/settings?tab=system-health" replace />}
                />
                <Route path="/users" element={<UserManagementPage />} />
                <Route path="*" element={<Navigate to="/" />} />
              </Routes>
            </Suspense>
          </AppShell>
        </ErrorBoundary>
        <Toaster theme="system" />
      </BrowserRouter>
    </QueryClientProvider>
  )
}

// Shown to the admin instead of the normal app whenever Lidarr isn't
// configured -- Settings itself (already gated so Save is disabled until a
// connection test passes, see settings.tsx) is the only thing rendered, no
// nav/other routes reachable. "Continue" is an explicit re-check rather than
// polling, since the natural flow is: fill in Lidarr, test, save, then move on.
function LidarrRequiredGate({ onLidarrConfigured }: { onLidarrConfigured: () => void }) {
  return (
    <div className="min-h-screen bg-bg">
      <div className="border-b border-border bg-surface px-6 py-4 flex items-center justify-between gap-4 flex-wrap">
        <div>
          <p className="text-sm font-semibold text-text">Lidarr connection required</p>
          <p className="text-xs text-muted mt-0.5">
            DJ Llama needs a working Lidarr connection to do anything -- set it up below, then
            continue.
          </p>
        </div>
        <button
          type="button"
          onClick={onLidarrConfigured}
          className="px-3 py-1.5 bg-accent text-accent-fg rounded text-sm font-medium hover:opacity-90 transition-opacity shrink-0"
        >
          Continue
        </button>
      </div>
      <Suspense fallback={null}>
        <SettingsPage />
      </Suspense>
    </div>
  )
}

// Shown to a non-admin member if Lidarr is somehow unset -- they can't fix
// this themselves (Lidarr is admin-only in Settings), so this just explains
// the situation rather than showing a broken/half-working app.
function LidarrRequiredForMemberScreen() {
  return (
    <div className="min-h-screen bg-bg flex items-center justify-center p-4">
      <div className="max-w-sm text-center space-y-2">
        <p className="text-sm font-medium text-text">Lidarr connection required</p>
        <p className="text-sm text-muted">
          DJ Llama isn't fully set up yet. Ask your admin to finish connecting Lidarr in Settings.
        </p>
      </div>
    </div>
  )
}

// Route-level gate for Recommendations (/discover, /discover/modes) -- unlike
// Lidarr this only blocks one feature, not the whole app, since Plex-history
// recommendations genuinely need AI to turn raw signal into curated,
// album-level suggestions (see the pipeline orchestrator). An admin sees an
// inline path to fix it without leaving the page; a member sees an
// explanation, since AI is admin-only in Settings.
function AiRequiredRoute({
  aiRequired,
  isAdmin,
  onRecheck,
  children,
}: {
  aiRequired: boolean
  isAdmin: boolean
  onRecheck: () => void
  children: React.ReactNode
}) {
  if (!aiRequired) return <>{children}</>

  if (!isAdmin) {
    return (
      <div className="min-h-screen bg-bg flex items-center justify-center p-4">
        <div className="max-w-sm text-center space-y-2">
          <p className="text-sm font-medium text-text">AI connection required</p>
          <p className="text-sm text-muted">
            Recommendations aren't available yet. Ask your admin to connect an AI provider in
            Settings.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-bg">
      <div className="border-b border-border bg-surface px-6 py-4 flex items-center justify-between gap-4 flex-wrap">
        <div>
          <p className="text-sm font-semibold text-text">AI connection required</p>
          <p className="text-xs text-muted mt-0.5">
            Recommendations need an AI provider configured to turn your listening history into
            curated, album-level suggestions -- set one up below, then continue.
          </p>
        </div>
        <button
          type="button"
          onClick={onRecheck}
          className="px-3 py-1.5 bg-accent text-accent-fg rounded text-sm font-medium hover:opacity-90 transition-opacity shrink-0"
        >
          Continue
        </button>
      </div>
      <Suspense fallback={null}>
        <SettingsPage />
      </Suspense>
    </div>
  )
}

// The tab Plex's OAuth flow redirects back to after the user finishes signing
// in there -- see the `plexAuthWindow` marker set on `forwardUrl` in
// server/routes/auth-plex.ts. This tab has no job to do; the original tab's
// poll loop is what actually completes the login. Self-close rather than
// falling through to the normal sign-in screen, which would be confusing
// (still-signed-out-looking window sitting on top of the real app).
function PlexAuthWindowClosing() {
  useEffect(() => {
    window.close()
  }, [])
  return (
    <div className="min-h-screen bg-bg flex items-center justify-center p-4">
      <p className="text-sm text-muted text-center">
        Signed in with Plex. You can close this window.
      </p>
    </div>
  )
}

export function App() {
  // Apply theme immediately on mount (before first render flicker)
  useEffect(() => {
    applyTheme(getStoredMode())
  }, [])

  if (new URLSearchParams(window.location.search).has('plexAuthWindow')) {
    return <PlexAuthWindowClosing />
  }

  return (
    <AuthGate>
      <InnerApp />
    </AuthGate>
  )
}
