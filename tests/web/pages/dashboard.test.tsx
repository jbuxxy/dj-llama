// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

function renderWithQuery(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return {
    ...render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>),
    client,
  }
}

// ---------------------------------------------------------------------------
// Mock dependencies
// ---------------------------------------------------------------------------

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}))

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    promise: vi.fn(),
  },
}))

vi.mock('@/web/components/pipeline-progress', () => ({
  PipelineProgress: ({ onComplete }: { onComplete?: () => void }) => (
    <button type="button" data-testid="complete-pipeline" onClick={onComplete}>
      Complete pipeline
    </button>
  ),
}))

vi.mock('@/web/lib/api', () => ({
  getRecommendations: vi.fn(),
  updateRecommendation: vi.fn(),
  approveRecommendation: vi.fn().mockResolvedValue({}),
  approveToTarget: vi.fn().mockResolvedValue({}),
  getPopularAlbums: vi.fn(),
  getPopularAlbumsAvailability: vi
    .fn()
    .mockResolvedValue({ available: true, spotify: true, lastfm: false }),
  deletePlaylistApi: vi.fn(),
  generatePlaylistApi: vi.fn(),
  listTargets: vi.fn().mockResolvedValue([]),
  getTopArtists: vi.fn(),
  getRecentTracks: vi.fn(),
  getDashboardTaste: vi.fn(),
  getDashboardGenreCoverage: vi.fn(),
  getDashboardActivity: vi.fn(),
  triggerPipeline: vi.fn(),
  rescanArtists: vi.fn().mockResolvedValue({ updated: 0, total: 0 }),
  moodDiscover: vi.fn(),
  quickDiscover: vi.fn(),
  getPipelineStatus: vi.fn(),
  getUserPreferences: vi.fn().mockResolvedValue({ dismissedHints: [] }),
  getAuthStatus: vi.fn().mockResolvedValue({ authenticated: true, isAdmin: false }),
  updatePlaylistApi: vi.fn(),
  updateUserPreferences: vi.fn().mockResolvedValue({}),
  getCurrentUser: vi.fn().mockResolvedValue({ id: 1, username: 'admin', isAdmin: false }),
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
}))

// Mock useSSE to avoid EventSource in jsdom
vi.mock('@/web/lib/hooks', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/web/lib/hooks')>()
  return {
    ...original,
    useSSE: vi.fn(() => ({ data: null, connected: false })),
  }
})

import { PlaylistCard } from '@/web/components/playlist-card'
import {
  approveRecommendation,
  getDashboardActivity,
  getDashboardGenreCoverage,
  getDashboardTaste,
  getPipelineStatus,
  getRecentTracks,
  getRecommendations,
  getTopArtists,
  listTargets,
} from '@/web/lib/api'
import { Dashboard } from '@/web/pages/dashboard'

const mockApproveRecommendation = vi.mocked(approveRecommendation)
const mockGetRecommendations = vi.mocked(getRecommendations)
const mockGetTopArtists = vi.mocked(getTopArtists)
const mockGetRecentTracks = vi.mocked(getRecentTracks)
const mockGetDashboardTaste = vi.mocked(getDashboardTaste)
const mockGetDashboardGenreCoverage = vi.mocked(getDashboardGenreCoverage)
const mockGetDashboardActivity = vi.mocked(getDashboardActivity)
const mockGetPipelineStatus = vi.mocked(getPipelineStatus)
const mockListTargets = vi.mocked(listTargets)

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const pendingRec = {
  id: 1,
  score: 0.85,
  status: 'pending',
  aiReasoning: 'Great post-rock vibes',
  artist: {
    id: 10,
    name: 'Sigur Ros',
    genres: ['post-rock', 'ambient'],
    imageUrl: null,
    streamingUrls: null,
  },
}

const approvedRec = {
  id: 2,
  score: 0.78,
  status: 'approved',
  artist: {
    id: 11,
    name: 'Slowdive',
    genres: ['shoegaze'],
    imageUrl: 'https://example.com/slowdive.jpg',
    streamingUrls: null,
  },
}

const addFailedRec = {
  id: 3,
  score: 0.72,
  status: 'add_failed',
  artist: {
    id: 12,
    name: 'Alcest',
    genres: ['blackgaze'],
    imageUrl: 'https://example.com/alcest.jpg',
    streamingUrls: null,
  },
}

function setupMocks() {
  mockGetRecommendations.mockImplementation((params) => {
    const p = params as Record<string, string> | undefined
    if (p?.status === 'pending') {
      return Promise.resolve({ items: [pendingRec], total: 1 })
    }
    if (p?.status?.includes('approved')) {
      return Promise.resolve({ items: [approvedRec], total: 1 })
    }
    return Promise.resolve({ items: [], total: 0 })
  })

  mockGetTopArtists.mockResolvedValue({
    tracks: [
      {
        artist: 'Bon Iver',
        track: '42 plays this month',
        source: 'plex',
        mbid: 'mbid-bon-iver',
      },
    ],
    total: 1,
    offset: 0,
    limit: 5,
    hasSource: true,
    source: 'plex',
  })

  mockGetRecentTracks.mockResolvedValue({
    tracks: [{ artist: 'Bon Iver', track: 'Holocene', source: 'plex' }],
    total: 1,
    offset: 0,
    limit: 10,
    hasSource: true,
    source: 'plex',
  })

  mockGetDashboardTaste.mockResolvedValue({
    genres: [
      { genre: 'post-rock', count: 10, percentage: 40 },
      { genre: 'shoegaze', count: 5, percentage: 20 },
    ],
  })
  mockGetDashboardGenreCoverage.mockResolvedValue({
    coveredArtists: 18,
    pendingArtists: 4,
    totalArtists: 25,
  })

  mockGetDashboardActivity.mockResolvedValue([
    {
      type: 'approved',
      timestamp: new Date().toISOString(),
      data: { artistName: 'Mogwai' },
    },
  ])

  mockGetPipelineStatus.mockResolvedValue({ running: false })
  mockListTargets.mockResolvedValue([])
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Dashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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
  })

  it("renders today's pick with artist name and a why-this trigger instead of a raw score", async () => {
    setupMocks()
    renderWithQuery(<Dashboard />)

    await waitFor(() => {
      expect(screen.getByText('Sigur Ros')).toBeInTheDocument()
      expect(screen.getByText('Why this?')).toBeInTheDocument()
    })
    expect(screen.queryByText('85')).not.toBeInTheDocument()
  })

  it("approves today's pick with popular albums from the approve menu", async () => {
    setupMocks()
    renderWithQuery(<Dashboard />)

    await screen.findByText('Sigur Ros')

    fireEvent.click(screen.getByLabelText('Monitoring options'))
    fireEvent.click(screen.getByText('Popular albums'))

    await waitFor(() => {
      expect(mockApproveRecommendation).toHaveBeenCalledWith(1, { monitorOption: 'popular' })
    })
  })

  it("renders the today's pick section title", async () => {
    setupMocks()
    renderWithQuery(<Dashboard />)

    expect(await screen.findByText("Today's Pick")).toBeInTheDocument()
  })

  it('renders listening history and recent plays', async () => {
    setupMocks()
    renderWithQuery(<Dashboard />)

    await waitFor(() => {
      expect(screen.getByText('42 plays this month')).toBeInTheDocument()
      expect(screen.getByText('Holocene')).toBeInTheDocument()
      expect(screen.getAllByText('Bon Iver').length).toBeGreaterThan(0)
    })
  })

  it('renders taste profile genres', async () => {
    setupMocks()
    renderWithQuery(<Dashboard />)

    await waitFor(() => {
      expect(screen.getByText('40%')).toBeInTheDocument()
      expect(screen.getByText('20%')).toBeInTheDocument()
    })
  })

  it('renders listening genre coverage and pending enrichment', async () => {
    setupMocks()
    renderWithQuery(<Dashboard />)

    expect(await screen.findByText('Genre data available: 18/25')).toBeInTheDocument()
    expect(screen.getByText('Pending genre data updates: 4')).toBeInTheDocument()
  })

  it('refreshes genre coverage when the pipeline completes', async () => {
    setupMocks()
    const { client } = renderWithQuery(<Dashboard />)
    const invalidate = vi.spyOn(client, 'invalidateQueries')

    fireEvent.click(screen.getByTestId('complete-pipeline'))

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['dashboard-genre-coverage'] })
  })

  it('renders activity feed entries', async () => {
    setupMocks()
    renderWithQuery(<Dashboard />)

    await waitFor(() => {
      expect(screen.getByText(/Approved Mogwai/)).toBeInTheDocument()
    })
  })

  it('shows empty state when no pending recommendations', async () => {
    setupMocks()
    mockGetRecommendations.mockResolvedValue({ items: [], total: 0 })
    renderWithQuery(<Dashboard />)

    await waitFor(() => {
      expect(screen.getByText(/No pending recommendations/i)).toBeInTheDocument()
    })
  })

  it('shows Run Scan button in empty state', async () => {
    setupMocks()
    mockGetRecommendations.mockResolvedValue({ items: [], total: 0 })
    renderWithQuery(<Dashboard />)

    await waitFor(() => {
      expect(screen.getByText('Run Scan')).toBeInTheDocument()
    })
  })

  it('formats the last-generated playlist date', () => {
    renderWithQuery(
      <PlaylistCard
        playlist={{
          id: 7,
          userId: 1,
          name: 'Weekend Mix',
          strategy: 'weekly_digest',
          schedule: '0 8 * * 1',
          enabled: true,
          targetIds: [],
          trackCount: 18,
          lastGeneratedAt: '2026-02-11T10:30:00.000Z',
          createdAt: '2026-01-01T00:00:00.000Z',
          config: { size: 25, trackSourcePriority: ['local', 'spotify', 'deezer'] },
          status: 'active',
          pushedToPlex: true,
          reviewExpiresAt: null,
          autoPushToPlex: false,
          description: null,
          coverUrl: null,
        }}
        onEdit={vi.fn()}
        onRefetch={vi.fn()}
      />,
    )

    expect(screen.getByText(/Feb\s*11/)).toBeInTheDocument()
  })

  it('renders playlist card metadata labels', () => {
    renderWithQuery(
      <PlaylistCard
        playlist={{
          id: 8,
          userId: 1,
          name: 'Night Shift',
          strategy: 'weekly_digest',
          schedule: '0 0 * * *',
          enabled: false,
          targetIds: [],
          trackCount: 12,
          lastGeneratedAt: null,
          createdAt: '2026-01-01T00:00:00.000Z',
          config: { size: 25, trackSourcePriority: ['local', 'spotify', 'deezer'] },
          status: 'active',
          pushedToPlex: true,
          reviewExpiresAt: null,
          autoPushToPlex: false,
          description: null,
          coverUrl: null,
        }}
        onEdit={vi.fn()}
        onRefetch={vi.fn()}
      />,
    )

    expect(screen.getByText('Schedule:')).toBeInTheDocument()
    expect(screen.getByText('Every day at 12:00 AM')).toBeInTheDocument()
    expect(screen.getByText('Never')).toBeInTheDocument()
    expect(screen.getByText('Disabled')).toBeInTheDocument()
  })

  it('shows add_failed recommendations in Recently Approved', async () => {
    setupMocks()
    mockGetRecommendations.mockImplementation((params) => {
      const p = params as Record<string, string> | undefined
      if (p?.status === 'pending') {
        return Promise.resolve({ items: [pendingRec], total: 1 })
      }
      if (p?.status === 'added_to_lidarr,add_failed,approved') {
        return Promise.resolve({ items: [addFailedRec], total: 1 })
      }
      return Promise.resolve({ items: [], total: 0 })
    })

    renderWithQuery(<Dashboard />)

    await waitFor(() => {
      expect(screen.getByText('Alcest')).toBeInTheDocument()
    })
  })
})
