// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, within } from '@testing-library/react'
import type { ReactElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

function renderWithQuery(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}))

vi.mock('@/web/lib/api', () => ({
  createUserApi: vi.fn(),
  deleteUserApi: vi.fn(),
  getCurrentUser: vi.fn().mockResolvedValue({
    id: 1,
    username: 'admin',
    isAdmin: true,
  }),
  getUserPreferences: vi.fn().mockResolvedValue({ dismissedHints: [] }),
  listUsers: vi.fn().mockResolvedValue([]),
  updateUserAdmin: vi.fn(),
  syncPlexUsers: vi.fn(),
}))

import { listUsers } from '@/web/lib/api'
import { UserManagementPage } from '@/web/pages/user-management'

function user(overrides: Record<string, unknown>) {
  return {
    id: 0,
    username: 'x',
    isAdmin: false,
    isOwner: false,
    autoApproveRequests: false,
    email: null,
    authProvider: 'plex',
    hasMusicAccess: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    hasSignedIn: false,
    lastSignInAt: null,
    ...overrides,
  }
}

describe('UserManagementPage', () => {
  beforeEach(() => {
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

  it('renders the page title', async () => {
    renderWithQuery(<UserManagementPage />)

    expect(await screen.findByText('User Management')).toBeInTheDocument()
  })

  it('groups people by whether they use DJ Llama, owner first', async () => {
    vi.mocked(listUsers).mockResolvedValueOnce([
      user({ id: 3, username: 'neverlogged' }),
      user({ id: 4, username: 'nomusic', hasMusicAccess: false }),
      user({ id: 2, username: 'trusted', hasSignedIn: true, autoApproveRequests: true }),
      user({ id: 1, username: 'admin', isAdmin: true, isOwner: true, hasSignedIn: true }),
    ])
    renderWithQuery(<UserManagementPage />)

    const active = await screen.findByRole('region', { name: 'Using DJ Llama' })
    const names = within(active)
      .getAllByRole('listitem')
      .map((li) => li.querySelector('span')?.textContent)
    expect(names).toEqual(['admin', 'trusted'])
    expect(within(active).getByText('Owner')).toBeInTheDocument()
    expect(within(active).getByText('Trusted')).toBeInTheDocument()

    const invited = screen.getByRole('region', { name: "Haven't signed in yet" })
    expect(within(invited).getByText('neverlogged')).toBeInTheDocument()
    const noAccess = screen.getByRole('region', { name: 'No Music access' })
    expect(within(noAccess).getByText('nomusic')).toBeInTheDocument()
  })

  it('keeps actions in a menu and blocks removing yourself', async () => {
    vi.mocked(listUsers).mockResolvedValueOnce([
      user({ id: 1, username: 'admin', isAdmin: true, isOwner: true, hasSignedIn: true }),
    ])
    renderWithQuery(<UserManagementPage />)

    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument()
    fireEvent.click(await screen.findByRole('button', { name: 'Actions for admin' }))
    expect(screen.getByRole('menuitem', { name: /Remove user/ })).toBeDisabled()
    expect(screen.getByRole('menuitem', { name: /Remove admin/ })).toBeDisabled()
  })
})
