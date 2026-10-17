// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { EnabledToggle } from '@/web/components/playlist-row-actions'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('@/web/lib/api', () => ({ updatePlaylistApi: vi.fn(async () => undefined) }))

const ADMIN_KEY = ['playlists', 'admin-imports'] as const

function setup(updateFn: (id: number, enabled: boolean) => Promise<unknown>) {
  const client = new QueryClient()
  client.setQueryData(ADMIN_KEY, [{ id: 7, enabled: false }])
  render(
    <QueryClientProvider client={client}>
      <EnabledToggle playlistId={7} enabled={false} updateFn={updateFn} queryKey={ADMIN_KEY} />
    </QueryClientProvider>,
  )
  return client
}

describe('EnabledToggle with a custom endpoint and cache', () => {
  it('calls the given update function and flips the row in the given cache', async () => {
    const updateFn = vi.fn(async () => undefined)
    const client = setup(updateFn)

    fireEvent.click(screen.getByRole('switch', { name: 'Enable playlist' }))

    await waitFor(() => expect(updateFn).toHaveBeenCalledWith(7, true))
    expect(client.getQueryData(ADMIN_KEY)).toEqual([{ id: 7, enabled: true }])
  })

  it('reverts the row when the update fails', async () => {
    const client = setup(vi.fn(async () => Promise.reject(new Error('nope'))))

    fireEvent.click(screen.getByRole('switch', { name: 'Enable playlist' }))

    await waitFor(() => expect(client.getQueryData(ADMIN_KEY)).toEqual([{ id: 7, enabled: false }]))
  })

  it("defaults to the owner's endpoint and the ['playlists'] cache", async () => {
    const { updatePlaylistApi } = vi.mocked(await import('@/web/lib/api'))
    const client = new QueryClient()
    client.setQueryData(['playlists'], [{ id: 3, enabled: true }])
    render(
      <QueryClientProvider client={client}>
        <EnabledToggle playlistId={3} enabled />
      </QueryClientProvider>,
    )

    fireEvent.click(screen.getByRole('switch', { name: 'Disable playlist' }))

    await waitFor(() => expect(updatePlaylistApi).toHaveBeenCalledWith(3, { enabled: false }))
    expect(client.getQueryData(['playlists'])).toEqual([{ id: 3, enabled: false }])
  })
})
