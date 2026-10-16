// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

function renderWithQuery(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

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

vi.mock('@/web/lib/api', () => ({
  getRecommendations: vi.fn(async () => ({ items: [], total: 0 })),
  updateRecommendation: vi.fn(),
  approveRecommendation: vi.fn().mockResolvedValue({}),
  approveToTarget: vi.fn().mockResolvedValue({}),
  getPopularAlbumsAvailability: vi.fn().mockResolvedValue({ available: true, spotify: true }),
  listTargets: vi.fn().mockResolvedValue([]),
  getTopArtists: vi.fn(async () => ({
    tracks: [],
    total: 0,
    offset: 0,
    limit: 5,
    hasSource: false,
    source: null,
  })),
  getRecentTracks: vi.fn(async () => ({
    tracks: [],
    total: 0,
    offset: 0,
    limit: 10,
    hasSource: false,
    source: null,
  })),
  getDashboardTaste: vi.fn(async () => []),
  getDashboardGenreCoverage: vi.fn(async () => null),
  getDashboardActivity: vi.fn(async () => []),
  triggerPipeline: vi.fn(),
  rescanArtists: vi.fn().mockResolvedValue({ updated: 0, total: 0 }),
  moodDiscover: vi.fn(),
  quickDiscover: vi.fn(),
  getPipelineStatus: vi.fn(async () => ({ running: false })),
  getUserPreferences: vi.fn().mockResolvedValue({ dismissedHints: [] }),
  getAuthStatus: vi.fn().mockResolvedValue({ authenticated: true, isAdmin: false }),
  updateUserPreferences: vi.fn().mockResolvedValue({}),
  getCurrentUser: vi.fn().mockResolvedValue({ id: 1, username: 'user', isAdmin: false }),
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

vi.mock('@/web/lib/hooks', () => ({
  useSSE: vi.fn(() => ({ data: null, connected: false })),
}))

import { Dashboard } from '@/web/pages/dashboard'

describe('Dashboard listening empty state', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('prompts to connect Plex', async () => {
    renderWithQuery(<Dashboard />)

    // Both Artist History and Recently Played show the same prompt when
    // neither has a Plex connection.
    await waitFor(() => {
      expect(screen.getAllByText(/Connect Plex in Settings/i).length).toBeGreaterThan(0)
    })
  })
})
