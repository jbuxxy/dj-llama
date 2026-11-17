// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import type { ReactElement, ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let client: QueryClient

function createQueryWrapper() {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  if (pendingJob) client.setQueryData(ACTIVITY_KEY, [pendingJob])
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
}

function renderWithQuery(ui: ReactElement) {
  return render(ui, { wrapper: createQueryWrapper() })
}

vi.mock('@/web/lib/api', () => ({
  getPipelineStatus: vi.fn(),
}))

import { PipelineProgress } from '@/web/components/pipeline-progress'
import { ACTIVITY_KEY, type ActivityJob } from '@/web/lib/activity'
import { getPipelineStatus } from '@/web/lib/api'

const mockGetPipelineStatus = vi.mocked(getPipelineStatus)

// The card reads this user's pipeline job from the activity cache (fed by
// the realtime SSE channel in the app shell).
let pendingJob: ActivityJob | null = null
function seedJob(patch: Partial<ActivityJob> | null) {
  const now = new Date().toISOString()
  pendingJob = patch
    ? {
        id: 'job-1',
        kind: 'pipeline',
        label: 'Discovery scan',
        status: 'running',
        startedAt: now,
        updatedAt: now,
        ...patch,
      }
    : null
}

describe('PipelineProgress', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    pendingJob = null
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns null when pipeline is not running and no SSE data', async () => {
    mockGetPipelineStatus.mockResolvedValue({ running: false })
    seedJob(null)

    const { container } = renderWithQuery(<PipelineProgress />)

    await waitFor(() => {
      expect(container.firstChild).toBeNull()
    })
  })

  it('renders stage label and percentage when pipeline is running', async () => {
    mockGetPipelineStatus.mockResolvedValue({ running: true, stage: 'analyze' })
    seedJob(null)

    renderWithQuery(<PipelineProgress />)

    await waitFor(() => {
      expect(screen.getByText('Building taste profile')).toBeInTheDocument()
      // analyze is index 1 with no item-level current/total yet, so the bar
      // sits at this stage's start boundary (1/8 = 13%) rather than jumping
      // straight to its end value -- it only climbs from there once real
      // current/total progress arrives (see the SSE current/total test below).
      expect(screen.getByText('13%')).toBeInTheDocument()
    })
  })

  it('renders SSE progress data with current/total counts', async () => {
    mockGetPipelineStatus.mockResolvedValue({ running: true, stage: 'collect' })
    seedJob({ stage: 'resolve', current: 5, total: 20, message: 'Looking up artists...' })

    renderWithQuery(<PipelineProgress />)

    await waitFor(() => {
      expect(screen.getByText('Looking up metadata')).toBeInTheDocument()
      expect(screen.getByText('5/20')).toBeInTheDocument()
      expect(screen.getByText('Looking up artists...')).toBeInTheDocument()
    })
  })

  it('shows complete stage label', async () => {
    mockGetPipelineStatus.mockResolvedValue({ running: true, stage: 'store' })
    seedJob({ status: 'done', stage: 'complete', finishedAt: new Date().toISOString() })

    renderWithQuery(<PipelineProgress />)

    await waitFor(() => {
      expect(screen.getByText('Done')).toBeInTheDocument()
      expect(screen.getByText('100%')).toBeInTheDocument()
    })
  })

  it('shows queue position for a queued scan', async () => {
    mockGetPipelineStatus.mockResolvedValue({ running: true, stage: 'resolve' })
    seedJob({ status: 'queued', queuePosition: 2 })

    renderWithQuery(<PipelineProgress />)

    await waitFor(() => {
      expect(screen.getByText(/#2 in line/)).toBeInTheDocument()
    })
  })

  it('fires onComplete exactly once when stage reaches complete', async () => {
    const onComplete = vi.fn()
    mockGetPipelineStatus.mockResolvedValue({ running: true, stage: 'store' })
    seedJob({ status: 'done', stage: 'complete', finishedAt: new Date().toISOString() })

    const { rerender } = render(<PipelineProgress onComplete={onComplete} />, {
      wrapper: createQueryWrapper(),
    })

    // The component uses setTimeout(onComplete, 500) - advance timers
    await waitFor(() => {
      expect(screen.getByText('Done')).toBeInTheDocument()
    })
    vi.advanceTimersByTime(600)
    expect(onComplete).toHaveBeenCalledTimes(1)

    // Re-render should NOT fire again
    rerender(<PipelineProgress onComplete={onComplete} />)
    vi.advanceTimersByTime(600)
    expect(onComplete).toHaveBeenCalledTimes(1)
  })
})
