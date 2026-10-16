// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

function renderWithQuery(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

vi.mock('@/web/lib/api', () => ({
  getAnalyticsBatches: vi.fn().mockResolvedValue([]),
  getAnalyticsGenres: vi.fn().mockResolvedValue([]),
  getAnalyticsOverview: vi.fn().mockResolvedValue({
    totalRecs: 0,
    approvalRate: 0,
    avgScore: 0,
    totalBatches: 0,
  }),
  getApprovalTrend: vi.fn().mockResolvedValue([]),
  getUserPreferences: vi.fn().mockResolvedValue({ dismissedHints: [] }),
}))

import { getAnalyticsBatches, getApprovalTrend } from '@/web/lib/api'
import { AnalyticsPage } from '@/web/pages/analytics'

describe('AnalyticsPage', () => {
  beforeEach(() => {
    vi.mocked(getAnalyticsBatches).mockResolvedValue([])
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

  it('gives each discovery chart column the full chart height', async () => {
    vi.mocked(getAnalyticsBatches).mockResolvedValueOnce([
      {
        id: 1,
        createdAt: '2026-07-13T12:00:00.000Z',
        status: 'completed',
        stats: {},
        total: 10,
        approved: 4,
        rejected: 3,
        pending: 3,
      },
    ])

    renderWithQuery(<AnalyticsPage />)

    const column = await screen.findByTitle(/10 recs \(4 approved\)/)
    expect(column).toHaveClass('h-full')
    expect(column.querySelectorAll('[style*="height"]')).toHaveLength(2)
  })

  it('plots the running approval rate, not each batch on its own', async () => {
    vi.mocked(getApprovalTrend).mockResolvedValueOnce([
      { batchId: 1, createdAt: '2026-07-13T12:00:00.000Z', approvalRate: 1, approved: 1, acted: 1 },
      { batchId: 2, createdAt: '2026-07-20T12:00:00.000Z', approvalRate: 0, approved: 0, acted: 3 },
    ])

    renderWithQuery(<AnalyticsPage />)

    // Batch 2 alone is 0%, but 1 of 4 decisions so far were approvals.
    const dot = await screen.findByTitle(/0 of 3 approved · 25% overall/)
    expect(dot).toHaveStyle({ top: '75%' })
  })
})
