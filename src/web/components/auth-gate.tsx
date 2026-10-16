import { useCallback, useEffect, useRef, useState } from 'react'
import { errMsg } from '@/core/validation'
import {
  AUTH_EXPIRED_EVENT,
  clearStoredToken,
  getAuthStatus,
  getLegacyStoredToken,
  logoutUser,
  migrateLegacySession,
  type PlexSection,
  type PlexServerChoice,
  pollPlexLogin,
  selectPlexLibrary,
  selectPlexServer,
  startPlexLogin,
} from '../lib/api'
import { consumeQueryFlag, goTopLevel, usesSameTabPlexSignIn } from '../lib/plex-same-tab'
import { Button } from './ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card'

type AuthState = 'loading' | 'authenticated' | 'plex-signin' | 'no-music-access'
type AuthFragment = { retiredToken: boolean; oidcError: boolean }
type MigrationRetryState = 'fresh' | 'retry' | 'unavailable'

const MIGRATION_RETRY_KEY = 'djllama-session-migration-retry'

function getMigrationRetryState(): MigrationRetryState {
  try {
    return window.sessionStorage.getItem(MIGRATION_RETRY_KEY) === null ? 'fresh' : 'retry'
  } catch {
    return 'unavailable'
  }
}

function markMigrationForRetry(): boolean {
  try {
    window.sessionStorage.setItem(MIGRATION_RETRY_KEY, '1')
    return true
  } catch {
    return false
  }
}

function clearMigrationRetryMarker() {
  try {
    window.sessionStorage.removeItem(MIGRATION_RETRY_KEY)
  } catch {
    // An unavailable marker store is already a fail-secure state.
  }
}

function clearLegacyMigrationState() {
  clearStoredToken()
  clearMigrationRetryMarker()
}

function consumeAuthFragment(): AuthFragment {
  const hash = window.location.hash
  const params = new URLSearchParams(hash.slice(1))
  const fragment = {
    retiredToken: params.has('oidc_token'),
    oidcError: params.has('oidc_error'),
  }
  if (fragment.retiredToken || fragment.oidcError) {
    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}${window.location.search}`,
    )
  }
  return fragment
}

export function AuthGate({ children }: { children: React.ReactNode }) {
  const fragment = useRef<AuthFragment | null>(null)
  if (!fragment.current) fragment.current = consumeAuthFragment()

  const [state, setState] = useState<AuthState>('loading')
  const [bootstrapRequired, setBootstrapRequired] = useState(false)
  const [notice, setNotice] = useState<string | null>(
    fragment.current.oidcError
      ? 'Login failed'
      : fragment.current.retiredToken
        ? 'Browser access-token sign-in has been retired. Sign in with your account or SSO.'
        : null,
  )
  const authCheckStarted = useRef(false)

  useEffect(() => {
    if (authCheckStarted.current) return
    authCheckStarted.current = true

    function applyStatus(
      status: Awaited<ReturnType<typeof getAuthStatus>>,
      allowAuthenticated: boolean,
    ) {
      setBootstrapRequired(!!status.bootstrapRequired)
      if (!status.authenticated || !allowAuthenticated) {
        setState('plex-signin')
      } else if (!status.hasMusicAccess) {
        setState('no-music-access')
      } else {
        setState('authenticated')
      }
    }

    async function requireLoginAfterMigrationFailure() {
      try {
        applyStatus(await getAuthStatus(), false)
      } catch {
        setState('plex-signin')
      }
    }

    async function checkAuth() {
      const legacyToken = getLegacyStoredToken()
      let allowAuthenticated = !fragment.current?.oidcError

      if (legacyToken) {
        const retryState = getMigrationRetryState()
        try {
          const result = await migrateLegacySession(legacyToken)
          clearLegacyMigrationState()
          if (result === 'legacy-rejected') {
            setNotice(
              'Browser access-token sign-in has been retired. Sign in with your account or SSO.',
            )
            allowAuthenticated = false
          } else if (result === 'invalid') {
            setNotice('Your saved browser session could not be upgraded. Sign in again.')
            allowAuthenticated = false
          }
        } catch {
          if (retryState !== 'fresh' || !markMigrationForRetry()) {
            clearLegacyMigrationState()
          }
          setNotice('Your saved browser session could not be upgraded. Sign in again.')
          await requireLoginAfterMigrationFailure()
          return
        }
      } else {
        clearMigrationRetryMarker()
      }

      try {
        const status = await getAuthStatus()
        applyStatus(status, allowAuthenticated)
      } catch {
        setNotice((current) => current ?? 'Login failed')
        setState('plex-signin')
      }
    }
    void checkAuth()
  }, [])

  // Listen for 401s from fetchApi and return to the sign-in screen
  useEffect(() => {
    const handler = () => {
      setNotice(null)
      setState('plex-signin')
    }
    window.addEventListener(AUTH_EXPIRED_EVENT, handler)
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, handler)
  }, [])

  async function handleAuthenticated() {
    setNotice(null)
    clearLegacyMigrationState()
    try {
      const status = await getAuthStatus()
      setBootstrapRequired(!!status.bootstrapRequired)
      if (!status.authenticated) {
        setNotice(
          'The browser did not accept the session cookie. Check the public URL and HTTPS configuration.',
        )
        setState('plex-signin')
      } else if (!status.hasMusicAccess) {
        setState('no-music-access')
      } else {
        setState('authenticated')
      }
    } catch {
      setNotice('The session could not be verified. Check your connection and try again.')
      setState('plex-signin')
    }
  }

  if (state === 'loading') return null
  if (state === 'authenticated') return <>{children}</>
  if (state === 'no-music-access') {
    return <NoMusicAccessScreen onRecheck={handleAuthenticated} />
  }
  return (
    <PlexSignIn
      notice={notice}
      bootstrapRequired={bootstrapRequired}
      onSuccess={handleAuthenticated}
    />
  )
}

// Shown to a Plex identity that's real and has an account, but isn't shared
// on the Music library the admin configured -- distinct from plex-signin,
// since blocking login entirely here would be wrong: they might legitimately
// gain access later, and the admin should be able to see them as a user (see
// user-management.tsx) rather than them never getting an account at all.
function NoMusicAccessScreen({ onRecheck }: { onRecheck: () => Promise<void> }) {
  const [checking, setChecking] = useState(false)

  async function handleRecheck() {
    setChecking(true)
    try {
      await onRecheck()
    } finally {
      setChecking(false)
    }
  }

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
    <div className="min-h-screen bg-bg flex flex-col items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="flex items-center justify-center gap-2">
            <img src="/icon.png" alt="" width="32" height="32" />
            <span className="text-3xl font-display tracking-wide text-accent">DJ LLAMA</span>
          </CardTitle>
          <CardDescription>
            You're signed in with Plex, but you don't have access to the Music library yet. Contact
            your admin to get access.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <Button type="button" className="w-full" disabled={checking} onClick={handleRecheck}>
            {checking ? 'Checking...' : 'Check again'}
          </Button>
          <Button type="button" variant="outline" className="w-full" onClick={handleLogout}>
            Log out
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}

// Plex sign-in -- the only way in. A logged-in Plex identity with access to
// the configured Music library section gets an account automatically; the
// very first person to sign in (or Plex accountID 1, the server owner,
// whenever they show up) becomes admin. See server/routes/auth-plex.ts.

const POLL_INTERVAL_MS = 1500
const POLL_TIMEOUT_MS = 5 * 60 * 1000

type SignInStatus = 'idle' | 'waiting' | 'select-server' | 'select-library' | 'submitting'

function PlexSignIn({
  notice,
  bootstrapRequired,
  onSuccess,
}: {
  notice: string | null
  bootstrapRequired: boolean
  onSuccess: () => Promise<void>
}) {
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<SignInStatus>('idle')
  const [servers, setServers] = useState<PlexServerChoice[]>([])
  const [serverSubmitting, setServerSubmitting] = useState(false)
  const [sections, setSections] = useState<PlexSection[]>([])
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  const pollDeadline = useRef(0)
  const pollInFlight = useRef(false)

  useEffect(() => {
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current)
    }
  }, [])

  const stopPolling = useCallback(() => {
    if (pollTimer.current) {
      clearInterval(pollTimer.current)
      pollTimer.current = null
    }
  }, [])

  // The Plex tab we open steals focus, which backgrounds this tab -- browsers
  // throttle setInterval in hidden tabs down to roughly once a minute (or
  // less), so the plain interval alone can look "stuck" for a long time even
  // though nothing failed. Firing an extra poll the moment this tab regains
  // focus/visibility (which is exactly when the user switches back after
  // finishing Plex login) fixes that without waiting on the throttled timer.
  const attemptPoll = useCallback(async () => {
    if (pollInFlight.current) return
    pollInFlight.current = true
    try {
      if (Date.now() > pollDeadline.current) {
        stopPolling()
        setStatus('idle')
        setError('Timed out waiting for Plex sign-in. Try again.')
        return
      }
      try {
        const result = await pollPlexLogin()
        if (result.status === 'complete') {
          stopPolling()
          await onSuccess()
        } else if (result.status === 'select-server') {
          stopPolling()
          setServers(result.servers)
          setStatus('select-server')
        } else if (result.status === 'select-library') {
          stopPolling()
          setSections(result.sections)
          setStatus('select-library')
        }
      } catch (err: unknown) {
        stopPolling()
        setStatus('idle')
        setError(errMsg(err))
      }
    } finally {
      pollInFlight.current = false
    }
  }, [onSuccess, stopPolling])

  useEffect(() => {
    if (status !== 'waiting') return
    function onFocusOrVisible() {
      if (document.visibilityState === 'hidden') return
      void attemptPoll()
    }
    document.addEventListener('visibilitychange', onFocusOrVisible)
    window.addEventListener('focus', onFocusOrVisible)
    return () => {
      document.removeEventListener('visibilitychange', onFocusOrVisible)
      window.removeEventListener('focus', onFocusOrVisible)
    }
  }, [status, attemptPoll])

  const startPolling = useCallback(() => {
    setStatus('waiting')
    pollDeadline.current = Date.now() + POLL_TIMEOUT_MS
    pollTimer.current = setInterval(() => void attemptPoll(), POLL_INTERVAL_MS)
  }, [attemptPoll])

  // Back from Plex after a same-tab sign-in: the PIN lives in a cookie, so
  // pick the poll loop back up instead of showing the sign-in button again.
  useEffect(() => {
    if (!consumeQueryFlag('plexAuthReturn')) return
    startPolling()
    void attemptPoll()
  }, [startPolling, attemptPoll])

  async function handleSignIn() {
    setError(null)
    const sameTab = usesSameTabPlexSignIn()
    try {
      const { authAppUrl } = await startPlexLogin(sameTab)
      if (sameTab) {
        goTopLevel(authAppUrl)
        return
      }
      window.open(authAppUrl, '_blank', 'noopener,noreferrer')
    } catch (err: unknown) {
      setError(errMsg(err))
      return
    }
    startPolling()
  }

  async function handleSelectServer(machineIdentifier: string) {
    setError(null)
    setServerSubmitting(true)
    try {
      const result = await selectPlexServer(machineIdentifier)
      setSections(result.sections)
      setStatus('select-library')
    } catch (err: unknown) {
      setError(errMsg(err))
    } finally {
      setServerSubmitting(false)
    }
  }

  function toggleSection(id: string) {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function handleConfirmLibraries() {
    if (selectedIds.size === 0) {
      setError('Select at least one library.')
      return
    }
    setError(null)
    setStatus('submitting')
    try {
      await selectPlexLibrary([...selectedIds])
      await onSuccess()
    } catch (err: unknown) {
      setStatus('select-library')
      setError(errMsg(err))
    }
  }

  if (status === 'select-server') {
    return (
      <div className="min-h-screen bg-bg flex flex-col items-center justify-center p-4">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle className="flex items-center justify-center gap-2">
              <img src="/icon.png" alt="" width="32" height="32" />
              <span className="text-3xl font-display tracking-wide text-accent">DJ LLAMA</span>
            </CardTitle>
            <CardDescription>
              This Plex account owns more than one server. Choose which one DJ Llama should connect
              to.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {servers.map((s) => (
                <button
                  key={s.machineIdentifier}
                  type="button"
                  disabled={serverSubmitting}
                  onClick={() => handleSelectServer(s.machineIdentifier)}
                  className="w-full text-left rounded border border-border px-3 py-2 hover:bg-surface disabled:opacity-50 transition-colors"
                >
                  <span className="text-sm text-text">{s.name}</span>
                </button>
              ))}
            </div>
            {error && <p className="text-sm text-reject text-center mt-2">{error}</p>}
          </CardContent>
        </Card>
      </div>
    )
  }

  if (status === 'select-library' || status === 'submitting') {
    return (
      <div className="min-h-screen bg-bg flex flex-col items-center justify-center p-4">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle className="flex items-center justify-center gap-2">
              <img src="/icon.png" alt="" width="32" height="32" />
              <span className="text-3xl font-display tracking-wide text-accent">DJ LLAMA</span>
            </CardTitle>
            <CardDescription>
              Select which Plex library section(s) count as Music. Anyone shared on at least one of
              these gets access to DJ Llama.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 mb-4">
              {sections.map((s) => (
                <label
                  key={s.id}
                  className="flex items-center gap-2 rounded border border-border px-3 py-2 cursor-pointer hover:bg-surface"
                >
                  <input
                    type="checkbox"
                    checked={selectedIds.has(s.id)}
                    onChange={() => toggleSection(s.id)}
                    className="accent-accent"
                  />
                  <span className="text-sm text-text">{s.title}</span>
                </label>
              ))}
            </div>
            <Button
              type="button"
              className="w-full"
              disabled={status === 'submitting'}
              onClick={handleConfirmLibraries}
            >
              {status === 'submitting' ? 'Saving...' : 'Continue'}
            </Button>
            {error && <p className="text-sm text-reject text-center mt-2">{error}</p>}
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-bg flex flex-col items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="flex flex-col items-center justify-center gap-2 text-center">
            <img src="/icon.png" alt="" width="72" height="72" />
            <span className="text-3xl font-display tracking-wide text-accent">DJ LLAMA</span>
          </CardTitle>
          <CardDescription className="text-center text-balance">
            {bootstrapRequired
              ? 'Sign in with the Plex account that owns this server to claim it.'
              : 'If you have access to the Music library, you have access to the DJ.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            type="button"
            className="w-full"
            disabled={status === 'waiting'}
            onClick={handleSignIn}
          >
            {status === 'waiting' ? 'Waiting for Plex...' : 'Sign in with Plex'}
          </Button>
          {status === 'waiting' && (
            <p className="text-sm text-muted text-center mt-2">
              Finish signing in in the Plex tab that just opened.
            </p>
          )}
          {(error || notice) && (
            <p className="text-sm text-reject text-center mt-2">
              {error ?? (notice ? notice : null)}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
