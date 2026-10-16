// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

function renderWithQuery(ui: ReactElement, initialEntries: string[] = ['/']) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return {
    client,
    ...render(
      <MemoryRouter initialEntries={initialEntries}>
        <QueryClientProvider client={client}>{ui}</QueryClientProvider>
      </MemoryRouter>,
    ),
  }
}

// ---------------------------------------------------------------------------
// Mock API
// ---------------------------------------------------------------------------

vi.mock('@/web/lib/api', () => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  getPlexServerName: vi.fn().mockResolvedValue({ name: null }),
  testNotificationChannel: vi.fn(),
  getPopularAlbumsAvailability: vi
    .fn()
    .mockResolvedValue({ available: true, spotify: true, lastfm: false }),
  testService: vi.fn(),
  getAuthStatus: vi.fn().mockResolvedValue({
    required: true,
    hasUsers: true,
    oidcEnabled: false,
    isAdmin: true,
  }),
  getLidarrProfiles: vi.fn(),
  getLidarrMetadataProfiles: vi.fn(),
  getLidarrRootFolders: vi.fn(),
  getPipelineStatus: vi.fn().mockResolvedValue({ running: false }),
  getDashboardGenreCoverage: vi.fn().mockResolvedValue({
    coveredArtists: 18,
    pendingArtists: 4,
    totalArtists: 25,
  }),
  triggerPipeline: vi.fn(),
  getSetupStatus: vi.fn().mockResolvedValue({ setupComplete: true }),
  exportRecommendations: vi.fn().mockResolvedValue(undefined),
  getCurrentUser: vi.fn().mockResolvedValue({
    id: 1,
    username: 'admin',
    isAdmin: true,
    preferredLocale: 'en',
  }),
  clearStoredToken: vi.fn(),
  logoutUser: vi.fn().mockResolvedValue({ ok: true }),
  AUTH_EXPIRED_EVENT: 'djllama:auth-expired',
  getUserPreferences: vi.fn().mockResolvedValue({
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
  }),
  getRecommendations: vi.fn().mockResolvedValue({ items: [], total: 0 }),
  approveRecommendation: vi.fn().mockResolvedValue({}),
  approveToTarget: vi.fn().mockResolvedValue({}),
  updateRecommendation: vi.fn().mockResolvedValue({}),
  getRecentListens: vi.fn().mockResolvedValue({ tracks: [] }),
  getDashboardTaste: vi.fn().mockResolvedValue([]),
  getDashboardActivity: vi.fn().mockResolvedValue([]),
  getJobHealth: vi.fn().mockResolvedValue({
    discovery: {
      status: 'ok',
      running: false,
      lastSuccessAt: null,
      lastProblem: null,
      nextRunAt: null,
    },
    playlists: {
      status: 'ok',
      running: false,
      lastSuccessAt: null,
      lastProblem: null,
      recentRuns: 0,
      recentFailures: 0,
    },
    librarySync: { status: 'ok', running: false, lastSuccessAt: null, lastProblem: null },
    sources: [],
  }),
  listJobs: vi.fn().mockResolvedValue({ items: [], total: 0 }),
  updateUserPreferences: vi.fn().mockResolvedValue({ success: true }),
}))

vi.mock('sonner', () => ({
  Toaster: () => null,
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    promise: vi.fn(),
  },
}))

vi.mock('@/web/components/bottom-nav', () => ({
  BottomNav: () => null,
}))

vi.mock('@/web/components/auth-gate', () => ({
  AuthGate: ({ children }: { children: React.ReactNode }) => children,
}))

vi.mock('@/web/components/error-boundary', () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => children,
}))

vi.mock('@/web/components/keyboard-shortcuts', () => ({
  KeyboardShortcuts: () => null,
}))

vi.mock('@/web/components/preview-player', () => ({
  PreviewPlayer: () => null,
}))

vi.mock('@/web/hooks/use-keyboard-shortcuts', () => ({
  useKeyboardShortcuts: vi.fn(),
}))

vi.mock('@/web/hooks/use-preview', () => ({
  usePreview: () => ({
    play: vi.fn(),
    stop: vi.fn(),
    hasPreview: false,
    state: {
      artistMbid: null,
      playing: false,
      artistName: '',
      source: '',
      loading: false,
    },
    globalPlayId: null,
  }),
}))

vi.mock('@/web/lib/hooks', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/web/lib/hooks')>()
  return {
    ...original,
    useSSE: vi.fn(() => ({ data: null, connected: false })),
  }
})

import {
  getCurrentUser,
  getJobHealth,
  getLidarrMetadataProfiles,
  getLidarrProfiles,
  getLidarrRootFolders,
  getPipelineStatus,
  getSettings,
  getUserPreferences,
  listJobs,
  testNotificationChannel,
  testService,
  updateSettings,
  updateUserPreferences,
} from '@/web/lib/api'
import { SettingsPage } from '@/web/pages/settings'

const mockGetSettings = getSettings as ReturnType<typeof vi.fn>
const mockGetPipelineStatus = getPipelineStatus as ReturnType<typeof vi.fn>
const mockUpdateSettings = updateSettings as ReturnType<typeof vi.fn>
const mockTestService = testService as ReturnType<typeof vi.fn>
const mockTestNotificationChannel = testNotificationChannel as ReturnType<typeof vi.fn>
const mockGetLidarrProfiles = getLidarrProfiles as ReturnType<typeof vi.fn>
const mockGetLidarrMetadataProfiles = getLidarrMetadataProfiles as ReturnType<typeof vi.fn>
const mockGetLidarrRootFolders = getLidarrRootFolders as ReturnType<typeof vi.fn>
const mockGetCurrentUser = getCurrentUser as ReturnType<typeof vi.fn>
const mockListJobs = listJobs as ReturnType<typeof vi.fn>
const mockGetJobHealth = getJobHealth as ReturnType<typeof vi.fn>
const mockGetUserPreferences = getUserPreferences as ReturnType<typeof vi.fn>
const mockUpdateUserPreferences = updateUserPreferences as ReturnType<typeof vi.fn>

// The desktop sidebar; the mobile <select> duplicates every label as an <option>.
async function findNav() {
  return screen.findByRole('navigation', { name: 'Settings sections' })
}

async function openTab(name: string) {
  fireEvent.click(within(await findNav()).getByRole('button', { name }))
}
// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const mockSettings = {
  lidarrUrl: 'http://localhost:8686',
  lidarrApiKey: '***',
  aiProvider: 'anthropic',
  aiModel: 'claude-3-5-haiku-20241022',
  aiApiKey: '***',
  preferences: {
    qualityProfileId: 1,
    metadataProfileId: 1,
    rootFolderId: 1,
    scheduleCron: '0 0 * * *',
    scoreThreshold: 0.5,
  },
  librarySyncIntervalHours: 6,
  setupComplete: true,
}

function setupMocks(settings: Record<string, unknown> = mockSettings) {
  mockGetSettings.mockResolvedValue(settings)
  mockGetLidarrProfiles.mockResolvedValue([{ id: 1, name: 'Any' }])
  mockGetLidarrMetadataProfiles.mockResolvedValue([{ id: 1, name: 'Standard' }])
  mockGetLidarrRootFolders.mockResolvedValue([{ id: 1, path: '/data/music' }])
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      value: class {
        observe = vi.fn()
        disconnect = vi.fn()
      },
    })
    const storage = new Map<string, string>()
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: vi.fn((key: string) => storage.get(key) ?? null),
        setItem: vi.fn((key: string, value: string) => {
          storage.set(key, value)
        }),
        removeItem: vi.fn((key: string) => {
          storage.delete(key)
        }),
        clear: vi.fn(() => {
          storage.clear()
        }),
      },
    })
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockReturnValue({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    })
    mockGetCurrentUser.mockResolvedValue({
      id: 1,
      username: 'admin',
      isAdmin: true,
    })
    mockGetPipelineStatus.mockResolvedValue({ running: false })
  })

  it('shows loading skeleton while fetching settings', () => {
    mockGetSettings.mockReturnValue(new Promise(() => {}))
    renderWithQuery(<SettingsPage />)
    const pulsingEls = document.querySelectorAll('.animate-pulse')
    expect(pulsingEls.length).toBeGreaterThan(0)
  })

  it('groups settings sections into You and Server for admins', async () => {
    setupMocks()
    renderWithQuery(<SettingsPage />)

    const nav = await findNav()
    for (const name of [
      'Connections',
      'Discovery',
      'Schedule',
      'Users',
      'Administration',
      'System Health',
      'Library Health',
      'Analytics',
    ]) {
      expect(within(nav).getByRole('button', { name })).toBeInTheDocument()
    }
    expect(within(nav).getByText('You')).toBeInTheDocument()
    expect(within(nav).getByText('Server')).toBeInTheDocument()
    expect(within(nav).getByRole('button', { name: 'Connections' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(within(nav).queryByRole('button', { name: 'Recommendations' })).toBeNull()
    // Merged into System Health and Library Health.
    expect(within(nav).queryByRole('button', { name: 'Job History' })).toBeNull()
    expect(within(nav).queryByRole('button', { name: 'Reconciliation' })).toBeNull()
  })

  it('hides the Server group from non-admins', async () => {
    setupMocks()
    mockGetCurrentUser.mockResolvedValue({ id: 2, username: 'viewer', isAdmin: false })
    renderWithQuery(<SettingsPage />)

    const nav = await findNav()
    await waitFor(() => {
      expect(within(nav).queryByText('Server')).toBeNull()
    })
    expect(within(nav).getByRole('button', { name: 'Discovery' })).toBeInTheDocument()
    expect(within(nav).queryByRole('button', { name: 'Schedule' })).toBeNull()
  })

  it('switches sections from the mobile section sheet', async () => {
    setupMocks()
    renderWithQuery(<SettingsPage />)

    await findNav()
    fireEvent.click(screen.getByRole('button', { name: /^Connections.*Sections$/ }))
    const sheet = await screen.findByRole('dialog', { name: 'Settings sections' })
    fireEvent.click(within(sheet).getByRole('button', { name: /^Schedule/ }))

    expect(await screen.findByText('Discovery schedule')).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'Settings sections' })).not.toBeInTheDocument()
  })

  it('opens Discovery for the legacy ?tab=recommendations link', async () => {
    setupMocks()
    renderWithQuery(<SettingsPage />, ['/settings?tab=recommendations'])

    expect(
      await screen.findByRole('heading', { name: 'How picky should DJ Llama be?' }),
    ).toBeInTheDocument()
    expect(within(await findNav()).getByRole('button', { name: 'Discovery' })).toHaveAttribute(
      'aria-current',
      'page',
    )
  })

  it('defaults to Connections tab showing Lidarr section', async () => {
    setupMocks()
    renderWithQuery(<SettingsPage />)

    await waitFor(() => {
      expect(screen.getAllByText('Lidarr').length).toBeGreaterThan(0)
    })
    // Lidarr card starts collapsed -- expand it before checking its fields
    fireEvent.click(screen.getByLabelText('Expand Lidarr'))
    expect(screen.getByDisplayValue('http://localhost:8686')).toBeInTheDocument()
  })

  it('labels Ollama as local when it points at localhost', async () => {
    setupMocks({
      ...mockSettings,
      aiProvider: 'ollama',
      aiBaseUrl: 'http://localhost:11434',
    })
    renderWithQuery(<SettingsPage />)

    // AI card starts collapsed -- expand it before its fields render
    fireEvent.click(await screen.findByLabelText('Expand AI Provider'))

    expect(await screen.findByText('Fully local')).toBeInTheDocument()
    expect(screen.getByText('Discovery prompts stay on your server.')).toBeInTheDocument()
  })

  it('warns when Ollama points at a remote host', async () => {
    setupMocks({
      ...mockSettings,
      aiProvider: 'ollama',
      aiBaseUrl: 'http://ollama.example.com:11434',
    })
    renderWithQuery(<SettingsPage />)

    // AI card starts collapsed -- expand it before its fields render
    fireEvent.click(await screen.findByLabelText('Expand AI Provider'))

    expect(await screen.findByText('Data leaves your server')).toBeInTheDocument()
    expect(
      screen.getByText(/Discovery prompts are sent to your chosen provider/),
    ).toBeInTheDocument()
  })

  it('Discovery shows plain-language presets instead of raw scoring weights', async () => {
    setupMocks()
    renderWithQuery(<SettingsPage />)

    await openTab('Discovery')

    expect(await screen.findByRole('button', { name: 'Balanced' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(screen.queryByText(/Scoring Weights/i)).toBeNull()
    expect(screen.queryByText(/Consensus/i)).toBeNull()
    expect(screen.queryByRole('slider')).toBeNull()
  })

  it('snaps an old custom threshold to the nearest preset', async () => {
    setupMocks()
    mockGetUserPreferences.mockResolvedValueOnce({
      scoreThreshold: 0.7,
      autoApproveThreshold: 0.93,
    })
    renderWithQuery(<SettingsPage />, ['/settings?tab=discovery'])

    expect(await screen.findByRole('button', { name: 'Strict' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(screen.getByRole('button', { name: 'Very confident' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  it('saves Discovery presets and resets custom scoring weights', async () => {
    setupMocks()
    mockGetUserPreferences.mockResolvedValueOnce({
      scoreThreshold: 0.5,
      scoringWeights: {
        consensus: 0.9,
        similarity: 0.1,
        genreOverlap: 0,
        aiConfidence: 0,
        feedbackBoost: 0,
        popularity: 0,
      },
      rejectionCooldownDays: 90,
      librarySeedRatio: 0.5,
    })
    renderWithQuery(<SettingsPage />, ['/settings?tab=discovery'])

    fireEvent.click(await screen.findByRole('button', { name: 'Strict' }))
    fireEvent.click(screen.getByRole('switch', { name: 'Enable auto-request' }))
    fireEvent.click(screen.getByRole('button', { name: 'Very confident' }))
    fireEvent.change(screen.getByLabelText('Hide rejected artists for'), {
      target: { value: '30' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(mockUpdateUserPreferences).toHaveBeenCalledWith(
        expect.objectContaining({
          scoreThreshold: 0.65,
          scoringWeights: {
            consensus: 0.3,
            similarity: 0.25,
            genreOverlap: 0.2,
            aiConfidence: 0.15,
            feedbackBoost: 0.1,
            popularity: 0,
          },
          rejectionCooldownDays: 30,
          // An existing custom library mix is kept while the toggle stays on.
          librarySeedRatio: 0.5,
          autoApproveEnabled: true,
          autoApproveThreshold: 0.9,
          historySourcesEnabled: { plex: true },
        }),
      )
    })
  })

  it('turning off library mix saves a zero seed ratio', async () => {
    setupMocks()
    renderWithQuery(<SettingsPage />, ['/settings?tab=discovery'])

    fireEvent.click(await screen.findByRole('switch', { name: 'Mix in your library' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(mockUpdateUserPreferences).toHaveBeenCalledWith(
        expect.objectContaining({ librarySeedRatio: 0 }),
      )
    })
  })

  it('saves artwork settings from Connections', async () => {
    setupMocks()
    mockUpdateSettings.mockResolvedValue(undefined as unknown as Record<string, unknown>)
    renderWithQuery(<SettingsPage />)

    fireEvent.click(await screen.findByRole('button', { name: /Artwork & Metadata/ }))
    fireEvent.change(screen.getByLabelText('Fanart.tv API key (optional)'), {
      target: { value: 'fanart-key' },
    })
    fireEvent.click(screen.getByRole('switch', { name: 'Wikidata enrichment' }))
    const card = screen.getByLabelText('Fanart.tv API key (optional)').closest('.rounded-lg')
    fireEvent.click(within(card as HTMLElement).getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(mockUpdateUserPreferences).toHaveBeenCalledWith(
        expect.objectContaining({ fanartApiKey: 'fanart-key' }),
      )
      expect(mockUpdateSettings).toHaveBeenCalledWith(
        expect.objectContaining({ wikidataEnabled: false }),
      )
    })
  })

  it('tab switching shows Schedule content', async () => {
    setupMocks()
    renderWithQuery(<SettingsPage />)

    await openTab('Schedule')

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Every day' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Certain days' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Monthly' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Every few hours' })).toBeInTheDocument()
    })
  })

  it('System Health includes the job history', async () => {
    setupMocks()
    mockListJobs.mockResolvedValue({
      items: [],
      total: 0,
    })
    renderWithQuery(<SettingsPage />)

    await openTab('System Health')

    await waitFor(() => {
      expect(screen.getByText('All')).toBeInTheDocument()
      expect(screen.getByText('No jobs found.')).toBeInTheDocument()
    })
  })

  it('tab switching shows System Health content inside settings', async () => {
    setupMocks()
    mockGetJobHealth.mockResolvedValue({
      discovery: {
        status: 'ok',
        running: false,
        lastSuccessAt: null,
        lastProblem: null,
        nextRunAt: null,
      },
      playlists: {
        status: 'warning',
        running: false,
        lastSuccessAt: null,
        lastProblem: { at: '2026-10-16T00:00:00Z', error: 'Plex timed out' },
        recentRuns: 10,
        recentFailures: 1,
      },
      librarySync: { status: 'ok', running: false, lastSuccessAt: null, lastProblem: null },
      sources: [
        { name: 'ai', ok: true, error: null, role: 'candidates', artists: 12 },
        {
          name: 'plex',
          ok: false,
          error: 'No listening history returned',
          role: 'history',
          artists: null,
        },
      ],
    })
    renderWithQuery(<SettingsPage />)

    await openTab('System Health')

    await waitFor(() => {
      expect(screen.getByText('2 things need attention')).toBeInTheDocument()
      expect(screen.getByText('1 of 10 refreshes failed in the last day')).toBeInTheDocument()
      expect(screen.getByText('Plex timed out')).toBeInTheDocument()
      expect(screen.getByText('Plex listening history')).toBeInTheDocument()
      expect(screen.getByText('Suggested 12 artists')).toBeInTheDocument()
      expect(screen.getByText('No listening history returned')).toBeInTheDocument()
    })
  })

  it('Test Connection button calls testService for Lidarr', async () => {
    setupMocks()
    mockTestService.mockResolvedValue({ success: true, message: 'OK' })
    renderWithQuery(<SettingsPage />)

    await waitFor(() => {
      expect(screen.getAllByText('Lidarr').length).toBeGreaterThan(0)
    })
    // Lidarr card starts collapsed -- expand it before its buttons render
    fireEvent.click(screen.getByLabelText('Expand Lidarr'))

    // Find the Lidarr section's Test Connection button (first one)
    const testButtons = screen.getAllByText('Test Connection')
    // biome-ignore lint/style/noNonNullAssertion: checked above
    fireEvent.click(testButtons[0]!)

    await waitFor(() => {
      expect(mockTestService).toHaveBeenCalledWith(
        'lidarr',
        expect.objectContaining({
          url: 'http://localhost:8686',
        }),
      )
    })
  })

  it('Save button calls updateSettings for Lidarr', async () => {
    setupMocks()
    mockUpdateSettings.mockResolvedValue(undefined as unknown as Record<string, unknown>)
    renderWithQuery(<SettingsPage />)

    await waitFor(() => {
      expect(screen.getAllByText('Lidarr').length).toBeGreaterThan(0)
    })
    // Lidarr card starts collapsed -- expand it before its buttons render
    fireEvent.click(screen.getByLabelText('Expand Lidarr'))

    // Find the Lidarr section's Save button (first one)
    const saveButtons = screen.getAllByText('Save')
    // biome-ignore lint/style/noNonNullAssertion: checked above
    fireEvent.click(saveButtons[0]!)

    await waitFor(() => {
      expect(mockUpdateSettings).toHaveBeenCalledWith(
        expect.objectContaining({ lidarrUrl: 'http://localhost:8686' }),
      )
    })
  })

  it('adds a notification channel, then tests and saves it', async () => {
    setupMocks()
    mockUpdateSettings.mockResolvedValue(undefined as unknown as Record<string, unknown>)
    mockTestNotificationChannel.mockResolvedValue(undefined)
    renderWithQuery(<SettingsPage />)

    // Notifications card starts collapsed -- expand it before its body renders
    fireEvent.click(await screen.findByLabelText('Expand Notifications'))

    const addButton = await screen.findByText('Add channel')
    const card = addButton.closest('.rounded-lg') as HTMLElement
    expect(card).toBeTruthy()

    // No type-specific fields until a channel is added.
    expect(within(card).queryByLabelText('Webhook URL')).toBeNull()

    fireEvent.click(addButton)

    // Default type is webhook, so its URL field appears.
    const urlInput = await within(card).findByLabelText('Webhook URL')
    fireEvent.change(urlInput, { target: { value: 'https://example.com/hook' } })

    // Enabled toggle round-trips.
    const enabledToggle = within(card).getByRole('switch', { name: 'Enabled' })
    expect(enabledToggle).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(enabledToggle)
    expect(enabledToggle).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(enabledToggle)

    // Test button hits the per-channel test endpoint with the edited channel.
    fireEvent.click(within(card).getByText('Test'))
    await waitFor(() => {
      expect(mockTestNotificationChannel).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'webhook', url: 'https://example.com/hook' }),
      )
    })

    // Save posts a channels array inside preferences.
    fireEvent.click(within(card).getByText('Save'))
    await waitFor(() => {
      expect(mockUpdateSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          preferences: expect.objectContaining({
            channels: expect.arrayContaining([
              expect.objectContaining({ type: 'webhook', url: 'https://example.com/hook' }),
            ]),
          }),
        }),
      )
    })
  })

  it('round-trips an untouched channel secret as masked, sends plaintext when changed', async () => {
    setupMocks({
      ...mockSettings,
      preferences: {
        ...mockSettings.preferences,
        channels: [
          {
            id: 'tg1',
            type: 'telegram',
            enabled: true,
            events: ['batch_complete'],
            botToken: '***',
            chatId: '123',
          },
        ],
      },
    })
    mockUpdateSettings.mockResolvedValue(undefined as unknown as Record<string, unknown>)
    renderWithQuery(<SettingsPage />)

    // Notifications card starts collapsed -- expand it before its body renders
    fireEvent.click(await screen.findByLabelText('Expand Notifications'))

    const addButton = await screen.findByText('Add channel')
    const card = addButton.closest('.rounded-lg') as HTMLElement

    // The masked secret shows an empty input with a keep placeholder.
    const botInput = within(card).getByLabelText('Bot token') as HTMLInputElement
    expect(botInput.value).toBe('')
    expect(botInput.placeholder).toBe('Leave blank to keep the saved value')

    // Saving without touching it keeps the stored value ('***', restored server-side).
    fireEvent.click(within(card).getByText('Save'))
    await waitFor(() => {
      expect(mockUpdateSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          preferences: expect.objectContaining({
            channels: expect.arrayContaining([
              expect.objectContaining({ id: 'tg1', botToken: '***' }),
            ]),
          }),
        }),
      )
    })

    // Typing a new secret sends the plaintext, never appended to '***'.
    mockUpdateSettings.mockClear()
    fireEvent.change(botInput, { target: { value: 'new-token' } })
    fireEvent.click(within(card).getByText('Save'))
    await waitFor(() => {
      expect(mockUpdateSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          preferences: expect.objectContaining({
            channels: expect.arrayContaining([
              expect.objectContaining({ id: 'tg1', botToken: 'new-token' }),
            ]),
          }),
        }),
      )
    })
  })

  it('hides the notification channels card from non-admins', async () => {
    setupMocks()
    mockGetCurrentUser.mockResolvedValue({
      id: 2,
      username: 'viewer',
      isAdmin: false,
      preferredLocale: 'en',
    })
    renderWithQuery(<SettingsPage />)

    // Non-admins get read-only Lidarr/AI cards and no notifications card at all.
    await waitFor(() => {
      expect(screen.queryByLabelText('Expand Notifications')).toBeNull()
      expect(screen.queryByLabelText('Expand Lidarr')).not.toBeNull()
    })
    fireEvent.click(screen.getByLabelText('Expand Lidarr'))
    expect(screen.getByText('Only admins can modify global settings.')).toBeInTheDocument()
    expect(screen.queryByLabelText('URL')).toBeNull()
    expect(screen.queryByText('Add channel')).toBeNull()
  })

  it('snaps stale global Lidarr default profile ids before saving', async () => {
    setupMocks()
    mockGetLidarrProfiles.mockResolvedValue([{ id: 3, name: 'Stefan' }])
    mockGetLidarrMetadataProfiles.mockResolvedValue([{ id: 4, name: 'Standard' }])
    mockGetLidarrRootFolders.mockResolvedValue([{ id: 10, path: '/music' }])
    mockUpdateSettings.mockResolvedValue(undefined as unknown as Record<string, unknown>)

    renderWithQuery(<SettingsPage />)

    await waitFor(() => {
      expect(screen.getAllByText('Lidarr').length).toBeGreaterThan(0)
    })
    // Lidarr card starts collapsed -- expand it before its fields render
    fireEvent.click(screen.getByLabelText('Expand Lidarr'))

    await waitFor(() => {
      expect(screen.getByDisplayValue('Stefan')).toBeInTheDocument()
      expect(screen.getByDisplayValue('/music')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByTestId('lidarr-save'))

    await waitFor(() => {
      expect(mockUpdateSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          preferences: expect.objectContaining({
            qualityProfileId: 3,
            metadataProfileId: 4,
            rootFolderId: 10,
          }),
        }),
      )
    })
  })

  it('shows error state when settings fail to load', async () => {
    mockGetSettings.mockRejectedValue(new Error('Network error'))
    renderWithQuery(<SettingsPage />)

    await waitFor(() => {
      expect(screen.getByText(/Something went wrong/i)).toBeInTheDocument()
    })
    expect(screen.getByText(/Network error/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Try again/i })).toBeInTheDocument()
  })
})
