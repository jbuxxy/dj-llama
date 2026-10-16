// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthGate } from '@/web/components/auth-gate'

const apiMocks = vi.hoisted(() => ({
  clearStoredToken: vi.fn(),
  getAuthStatus: vi.fn(),
  getLegacyStoredToken: vi.fn(),
  migrateLegacySession: vi.fn(),
  startPlexLogin: vi.fn(),
  pollPlexLogin: vi.fn(),
}))

vi.mock('@/web/lib/api', () => ({
  AUTH_EXPIRED_EVENT: 'djllama:auth-expired',
  clearStoredToken: apiMocks.clearStoredToken,
  getAuthStatus: apiMocks.getAuthStatus,
  getLegacyStoredToken: apiMocks.getLegacyStoredToken,
  migrateLegacySession: apiMocks.migrateLegacySession,
  startPlexLogin: apiMocks.startPlexLogin,
  pollPlexLogin: apiMocks.pollPlexLogin,
}))

const unauthenticatedStatus = {
  required: true,
  hasUsers: true,
  authenticated: false,
}

const authenticatedStatus = {
  ...unauthenticatedStatus,
  authenticated: true,
  userId: 1,
  isAdmin: true,
  hasMusicAccess: true,
}

const migrationRetryKey = 'djllama-session-migration-retry'

function renderGate({ strict = false }: { strict?: boolean } = {}) {
  const gate = (
    <AuthGate>
      <div>secret area</div>
    </AuthGate>
  )
  return render(strict ? <StrictMode>{gate}</StrictMode> : gate)
}

describe('AuthGate', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    window.sessionStorage.clear()
    window.history.replaceState({}, '', '/')
    vi.clearAllMocks()
    apiMocks.getAuthStatus.mockResolvedValue(unauthenticatedStatus)
    apiMocks.getLegacyStoredToken.mockReturnValue(null)
    apiMocks.migrateLegacySession.mockResolvedValue('migrated')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 401 })),
    )
  })

  afterEach(() => {
    cleanup()
  })

  it('migrates a stored browser session before trusting cookie auth', async () => {
    window.sessionStorage.setItem(migrationRetryKey, '1')
    apiMocks.getLegacyStoredToken.mockReturnValue('stored-session')
    apiMocks.getAuthStatus.mockResolvedValue(authenticatedStatus)

    renderGate()

    await screen.findByText('secret area')
    expect(apiMocks.migrateLegacySession).toHaveBeenCalledWith('stored-session')
    expect(apiMocks.clearStoredToken).toHaveBeenCalledTimes(1)
    expect(window.sessionStorage.getItem(migrationRetryKey)).toBeNull()
    expect(apiMocks.migrateLegacySession.mock.invocationCallOrder[0]).toBeLessThan(
      apiMocks.getAuthStatus.mock.invocationCallOrder[0] ?? 0,
    )
  })

  it('clears an invalid stored session and requires login despite another cookie', async () => {
    window.sessionStorage.setItem(migrationRetryKey, '1')
    apiMocks.getLegacyStoredToken.mockReturnValue('invalid-session')
    apiMocks.migrateLegacySession.mockResolvedValue('invalid')
    apiMocks.getAuthStatus.mockResolvedValue(authenticatedStatus)

    renderGate()

    expect(
      await screen.findByText('Your saved browser session could not be upgraded. Sign in again.'),
    ).toBeInTheDocument()
    expect(apiMocks.clearStoredToken).toHaveBeenCalledTimes(1)
    expect(window.sessionStorage.getItem(migrationRetryKey)).toBeNull()
    expect(screen.queryByText('secret area')).not.toBeInTheDocument()
  })

  it('explains that browser access-token login was retired', async () => {
    window.sessionStorage.setItem(migrationRetryKey, '1')
    apiMocks.getLegacyStoredToken.mockReturnValue('legacy-deployment-token')
    apiMocks.migrateLegacySession.mockResolvedValue('legacy-rejected')

    renderGate()

    expect(
      await screen.findByText(
        'Browser access-token sign-in has been retired. Sign in with your account or SSO.',
      ),
    ).toBeInTheDocument()
    expect(apiMocks.clearStoredToken).toHaveBeenCalledTimes(1)
    expect(window.sessionStorage.getItem(migrationRetryKey)).toBeNull()
    expect(screen.queryByText('secret area')).not.toBeInTheDocument()
  })

  it('keeps a stored session for one retry after a transient migration failure', async () => {
    apiMocks.getLegacyStoredToken.mockReturnValue('retryable-session')
    apiMocks.migrateLegacySession.mockRejectedValue(new Error('network unavailable'))
    apiMocks.getAuthStatus.mockResolvedValue(authenticatedStatus)

    renderGate()

    expect(
      await screen.findByText('Your saved browser session could not be upgraded. Sign in again.'),
    ).toBeInTheDocument()
    expect(apiMocks.clearStoredToken).not.toHaveBeenCalled()
    expect(window.sessionStorage.getItem(migrationRetryKey)).toBe('1')
    expect(apiMocks.getAuthStatus).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('secret area')).not.toBeInTheDocument()
  })

  it('ignores a scrubbed fragment token and requires normal login', async () => {
    window.history.replaceState({}, '', '/#oidc_token=fragment-session')

    renderGate()

    expect(window.location.hash).toBe('')
    expect(
      await screen.findByText(
        'Browser access-token sign-in has been retired. Sign in with your account or SSO.',
      ),
    ).toBeInTheDocument()
    expect(apiMocks.getLegacyStoredToken).toHaveBeenCalledTimes(1)
    expect(apiMocks.migrateLegacySession).not.toHaveBeenCalled()
    expect(apiMocks.clearStoredToken).not.toHaveBeenCalled()
    expect(screen.queryByText('secret area')).not.toBeInTheDocument()
  })

  it('clears a consumed stored session when a replay becomes invalid', async () => {
    apiMocks.getLegacyStoredToken.mockReturnValue('consumed-session')
    apiMocks.migrateLegacySession
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce('invalid')
    apiMocks.getAuthStatus.mockResolvedValue(authenticatedStatus)

    const firstRender = renderGate()
    await screen.findByText('Your saved browser session could not be upgraded. Sign in again.')
    expect(apiMocks.clearStoredToken).not.toHaveBeenCalled()
    expect(window.sessionStorage.getItem(migrationRetryKey)).toBe('1')
    expect(screen.queryByText('secret area')).not.toBeInTheDocument()
    firstRender.unmount()

    renderGate()
    await waitFor(() => expect(apiMocks.migrateLegacySession).toHaveBeenCalledTimes(2))
    expect(apiMocks.clearStoredToken).toHaveBeenCalledTimes(1)
    expect(window.sessionStorage.getItem(migrationRetryKey)).toBeNull()
    expect(screen.queryByText('secret area')).not.toBeInTheDocument()
  })

  it('clears a stored session after a second transient migration failure', async () => {
    apiMocks.getLegacyStoredToken.mockReturnValue('retryable-session')
    apiMocks.migrateLegacySession.mockRejectedValue(new Error('network unavailable'))
    apiMocks.getAuthStatus.mockResolvedValue(authenticatedStatus)

    const firstRender = renderGate()
    await screen.findByText('Your saved browser session could not be upgraded. Sign in again.')
    expect(window.sessionStorage.getItem(migrationRetryKey)).toBe('1')
    expect(apiMocks.clearStoredToken).not.toHaveBeenCalled()
    firstRender.unmount()

    renderGate()
    await waitFor(() => expect(apiMocks.migrateLegacySession).toHaveBeenCalledTimes(2))
    expect(apiMocks.clearStoredToken).toHaveBeenCalledTimes(1)
    expect(window.sessionStorage.getItem(migrationRetryKey)).toBeNull()
    expect(screen.queryByText('secret area')).not.toBeInTheDocument()
  })

  it('fails secure when the migration retry marker is unavailable', async () => {
    const storageError = new DOMException('blocked', 'SecurityError')
    vi.stubGlobal('sessionStorage', {
      getItem: vi.fn(() => {
        throw storageError
      }),
      setItem: vi.fn(() => {
        throw storageError
      }),
      removeItem: vi.fn(() => {
        throw storageError
      }),
    })
    apiMocks.getLegacyStoredToken.mockReturnValue('retryable-session')
    apiMocks.migrateLegacySession.mockRejectedValue(new Error('network unavailable'))
    apiMocks.getAuthStatus.mockResolvedValue(authenticatedStatus)

    renderGate()

    await screen.findByText('Your saved browser session could not be upgraded. Sign in again.')
    expect(apiMocks.clearStoredToken).toHaveBeenCalledTimes(1)
    expect(apiMocks.getAuthStatus).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('secret area')).not.toBeInTheDocument()
  })

  it('scrubs a fragment token without replacing an authenticated victim session', async () => {
    const historyState = { navigation: 'victim' }
    window.history.replaceState(historyState, '', '/?return=preserved#oidc_token=attacker-session')
    apiMocks.getAuthStatus.mockResolvedValue(authenticatedStatus)
    const replaceState = vi.spyOn(window.history, 'replaceState')

    renderGate()

    expect(window.location.pathname).toBe('/')
    expect(window.location.search).toBe('?return=preserved')
    expect(window.location.hash).toBe('')
    expect(replaceState).toHaveBeenCalledWith(historyState, '', '/?return=preserved')
    await screen.findByText('secret area')
    expect(apiMocks.migrateLegacySession).not.toHaveBeenCalled()
    expect(apiMocks.getLegacyStoredToken).toHaveBeenCalledTimes(1)
    expect(apiMocks.clearStoredToken).not.toHaveBeenCalled()
  })

  it('migrates only the stored session when a fragment token is also present', async () => {
    window.history.replaceState({}, '', '/#oidc_token=attacker-session')
    apiMocks.getLegacyStoredToken.mockReturnValue('stored-session')
    apiMocks.getAuthStatus.mockResolvedValue(authenticatedStatus)

    renderGate()

    await screen.findByText('secret area')
    expect(apiMocks.migrateLegacySession).toHaveBeenCalledTimes(1)
    expect(apiMocks.migrateLegacySession).toHaveBeenCalledWith('stored-session')
    expect(apiMocks.clearStoredToken).toHaveBeenCalledTimes(1)
  })

  it('does not switch identity for an ambiguous OIDC fragment', async () => {
    window.history.replaceState({}, '', '/#oidc_token=attacker-session&oidc_error=oidc_failed')
    apiMocks.getAuthStatus.mockResolvedValue(authenticatedStatus)

    renderGate()

    expect(window.location.hash).toBe('')
    expect(await screen.findByText('Login failed')).toBeInTheDocument()
    expect(apiMocks.migrateLegacySession).not.toHaveBeenCalled()
    expect(apiMocks.clearStoredToken).not.toHaveBeenCalled()
    expect(screen.queryByText('secret area')).not.toBeInTheDocument()
  })

  it('scrubs a recognized error fragment and shows a safe localized OIDC error', async () => {
    window.history.replaceState({}, '', '/#oidc_error=oidc_failed')

    renderGate()

    expect(window.location.hash).toBe('')
    expect(await screen.findByText('Login failed')).toBeInTheDocument()
    expect(apiMocks.migrateLegacySession).not.toHaveBeenCalled()
  })

  it('preserves ordinary navigation anchors', async () => {
    window.history.replaceState({ navigation: 'section' }, '', '/?view=details#albums')
    apiMocks.getAuthStatus.mockResolvedValue(authenticatedStatus)
    const replaceState = vi.spyOn(window.history, 'replaceState')

    renderGate()

    await screen.findByText('secret area')
    expect(window.location.search).toBe('?view=details')
    expect(window.location.hash).toBe('#albums')
    expect(replaceState).not.toHaveBeenCalled()
  })

  it('uses cookie-authenticated status when no legacy session exists', async () => {
    apiMocks.getAuthStatus.mockResolvedValue(authenticatedStatus)

    renderGate()

    await screen.findByText('secret area')
    expect(apiMocks.migrateLegacySession).not.toHaveBeenCalled()
    expect(apiMocks.clearStoredToken).not.toHaveBeenCalled()
  })

  it('does not replay migration when React re-enters the mount effect', async () => {
    apiMocks.getLegacyStoredToken.mockReturnValue('stored-session')
    apiMocks.getAuthStatus.mockResolvedValue(authenticatedStatus)

    renderGate({ strict: true })

    await screen.findByText('secret area')
    expect(apiMocks.migrateLegacySession).toHaveBeenCalledTimes(1)
  })

  it('returns to the Plex sign-in screen when the cookie session expires', async () => {
    apiMocks.getAuthStatus.mockResolvedValue(authenticatedStatus)
    renderGate()
    await screen.findByText('secret area')

    act(() => window.dispatchEvent(new Event('djllama:auth-expired')))

    expect(await screen.findByRole('button', { name: 'Sign in with Plex' })).toBeInTheDocument()
    expect(screen.queryByText('secret area')).not.toBeInTheDocument()
  })

  describe('same-tab Plex sign-in', () => {
    it('resumes polling after Plex returns the tab, then lets the user in', async () => {
      window.history.replaceState({}, '', '/?plexAuthReturn=1')
      apiMocks.pollPlexLogin.mockResolvedValue({ status: 'complete' })
      apiMocks.getAuthStatus
        .mockResolvedValueOnce(unauthenticatedStatus)
        .mockResolvedValue(authenticatedStatus)

      renderGate()

      expect(await screen.findByText('secret area')).toBeTruthy()
      expect(apiMocks.pollPlexLogin).toHaveBeenCalled()
      expect(apiMocks.startPlexLogin).not.toHaveBeenCalled()
      expect(window.location.search).toBe('')
    })

    it('sends the whole tab to Plex in browsers without real popups', async () => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
        'Mozilla/5.0 (X11; GNU/Linux) AppleWebKit/537.36 Chrome/124.0 Safari/537.36 Tesla/2025.32',
      )
      const open = vi.spyOn(window, 'open').mockReturnValue(null)
      apiMocks.startPlexLogin.mockResolvedValue({
        authAppUrl: 'https://app.plex.tv/auth#?code=abc',
      })

      renderGate()
      const button = await screen.findByRole('button', { name: 'Sign in with Plex' })
      await act(async () => {
        button.click()
      })

      expect(apiMocks.startPlexLogin).toHaveBeenCalledWith(true)
      expect(open).not.toHaveBeenCalled()
    })

    it('keeps the popup flow for regular browsers', async () => {
      const open = vi.spyOn(window, 'open').mockReturnValue(null)
      apiMocks.startPlexLogin.mockResolvedValue({
        authAppUrl: 'https://app.plex.tv/auth#?code=abc',
      })
      apiMocks.pollPlexLogin.mockResolvedValue({ status: 'pending' })

      renderGate()
      const button = await screen.findByRole('button', { name: 'Sign in with Plex' })
      await act(async () => {
        button.click()
      })

      expect(apiMocks.startPlexLogin).toHaveBeenCalledWith(false)
      expect(open).toHaveBeenCalledWith(
        'https://app.plex.tv/auth#?code=abc',
        '_blank',
        'noopener,noreferrer',
      )
    })
  })
})
