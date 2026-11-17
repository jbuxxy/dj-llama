// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/web/lib/api', () => ({
  getPlaylist: vi.fn(),
  getPlaylistMissingTracks: vi.fn(),
  exportPlaylistApi: vi.fn(),
}))

vi.mock('@/web/components/hint', () => ({
  Hint: ({ children }: { children: ReactNode }) => <p>{children}</p>,
}))

vi.mock('@/web/components/playlist-row-actions', () => ({
  GenerateButton: () => <button type="button">Generate</button>,
  SweepLiveTracksButton: () => null,
}))

import { getPlaylist, getPlaylistMissingTracks } from '@/web/lib/api'
import { PlaylistDetailPage } from '@/web/pages/playlist-detail'

const mockGetPlaylist = vi.mocked(getPlaylist)
const mockGetMissing = vi.mocked(getPlaylistMissingTracks)

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MemoryRouter initialEntries={['/playlists/7']}>
      <QueryClientProvider client={client}>
        <Routes>
          <Route path="/playlists/:id" element={<PlaylistDetailPage />} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  )
}

const track = (position: number, artistName: string, trackName: string) => ({
  id: position + 1,
  playlistId: 7,
  artistName,
  trackName,
  mbid: null,
  spotifyUri: null,
  deezerId: null,
  localPath: null,
  position,
})

const playlist = (strategy: string) =>
  ({
    id: 7,
    name: 'Halloween Party',
    strategy,
    schedule: null,
    lastGeneratedAt: null,
    trackCount: 1,
    enabled: true,
    pushedToPlex: false,
  }) as never

describe('PlaylistDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('marks import tracks as in the library or missing', async () => {
    mockGetPlaylist.mockResolvedValue({
      playlist: playlist('import'),
      tracks: [
        track(0, 'Bobby Pickett', 'Monster Mash'),
        track(1, 'Ray Parker Jr.', 'Ghostbusters'),
      ],
    } as never)
    mockGetMissing.mockResolvedValue([
      {
        id: 1,
        playlistId: 7,
        artistName: 'ray parker jr.',
        trackName: 'ghostbusters',
        albumTitle: null,
        resolvedAlbumTitle: 'Ghostbusters (Original Soundtrack)',
        coverUrl: null,
        reason: 'not_found',
      },
    ] as never)

    renderPage()

    expect(await screen.findByText('2 total · 1 missing')).toBeTruthy()
    expect(screen.getByText('In library')).toBeTruthy()
    expect(screen.getByText('Missing')).toBeTruthy()
    expect(
      screen.getByText('Ray Parker Jr. · Requesting Ghostbusters (Original Soundtrack)'),
    ).toBeTruthy()
    expect(screen.getByText(/mirrors one from another service/)).toBeTruthy()
  })

  it('keeps source badges and skips the missing-tracks fetch for generated playlists', async () => {
    mockGetPlaylist.mockResolvedValue({
      playlist: playlist('daily_mix'),
      tracks: [{ ...track(0, 'Muse', 'Uprising'), localPath: '/music/muse/uprising.flac' }],
    } as never)

    renderPage()

    expect(await screen.findByText('1 total')).toBeTruthy()
    expect(screen.getByText('Local')).toBeTruthy()
    expect(mockGetMissing).not.toHaveBeenCalled()
  })
})
