// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/web/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/web/lib/api')>()
  return {
    ...actual,
    getArtistTopTracks: vi.fn().mockResolvedValue([]),
    getLibraryAlbumCoverage: vi.fn(),
  }
})

import { type Recommendation, RecommendationCard } from '@/web/components/recommendation-card'
import { getArtistTopTracks, getLibraryAlbumCoverage } from '@/web/lib/api'
import { PreviewContext } from '@/web/lib/preview-context'

// ---------------------------------------------------------------------------
// Preview context stub
// ---------------------------------------------------------------------------

const noopPreview = {
  play: vi.fn(),
  stop: vi.fn(),
  hasPreview: () => false,
  currentMbid: null,
  playing: false,
  globalPlayId: 0,
  volume: 1,
  setVolume: vi.fn(),
  audition: {
    active: false,
    index: 0,
    count: 0,
    current: null,
    start: vi.fn(),
    next: vi.fn(),
    previous: vi.fn(),
    stop: vi.fn(),
  },
}

function withPreview(ui: ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <PreviewContext.Provider value={noopPreview}>{ui}</PreviewContext.Provider>
    </QueryClientProvider>,
  )
}

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const makeRec = (overrides: Partial<Recommendation> = {}): Recommendation => ({
  id: 1,
  kind: 'artist',
  score: 0.82,
  status: 'pending',
  aiReasoning: 'Great match for your indie taste.',
  sources: { musicbrainz: 0.9, ai: 0.7 },
  lidarrError: null,
  recommendedReleaseGroupId: null,
  recommendedReleaseGroupTitle: null,
  artist: {
    id: 10,
    name: 'Radiohead',
    mbid: 'mbid-001',
    disambiguation: null,
    genres: ['rock', 'alternative', 'art rock', 'electronic', 'experimental'],
    tags: null,
    imageUrl: null,
    streamingUrls: { spotify: 'https://open.spotify.com/artist/abc123' },
  },
  ...overrides,
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RecommendationCard', () => {
  const onApprove = vi.fn()
  const onReject = vi.fn()
  const onClick = vi.fn()
  const mockGetLibraryAlbumCoverage = vi.mocked(getLibraryAlbumCoverage)
  const mockGetArtistTopTracks = vi.mocked(getArtistTopTracks)

  beforeEach(() => {
    vi.clearAllMocks()
    mockGetLibraryAlbumCoverage.mockResolvedValue({
      artistMbid: 'mbid-001',
      ownedCount: 3,
      totalCount: 8,
      owned: [{ albumMbid: 'owned-a', title: 'Owned A', releaseYear: 2001 }],
      missing: [{ albumMbid: 'missing-b', title: 'Missing B', releaseYear: 2004 }],
    })
    mockGetArtistTopTracks.mockResolvedValue({ tracks: [] })
  })

  it('renders artist name and a why-this trigger instead of a raw score', () => {
    withPreview(
      <RecommendationCard recommendation={makeRec()} onApprove={onApprove} onReject={onReject} />,
    )
    expect(screen.getByText('Radiohead')).toBeInTheDocument()
    expect(screen.getByText('Why this?')).toBeInTheDocument()
    expect(screen.queryByText('82%')).not.toBeInTheDocument()
  })

  it('renders the album as the primary unit for kind=album', () => {
    withPreview(
      <RecommendationCard
        recommendation={makeRec({ kind: 'album', recommendedReleaseGroupTitle: 'Kid A' })}
        onApprove={onApprove}
        onReject={onReject}
      />,
    )
    expect(screen.getByRole('heading', { name: 'Kid A' })).toBeInTheDocument()
    expect(screen.queryByText('Album')).not.toBeInTheDocument()
  })

  it('renders genre pills', () => {
    const genres = [
      'rock',
      'alternative',
      'art rock',
      'electronic',
      'experimental',
      'post-rock',
      'ambient',
      'idm',
    ]
    const base = makeRec()
    withPreview(
      <RecommendationCard
        recommendation={{ ...base, artist: { ...base.artist, genres } }}
        onApprove={onApprove}
        onReject={onReject}
      />,
    )
    // Default compact: max 6 genres shown
    for (const genre of genres.slice(0, 6)) {
      expect(screen.getByText(genre)).toBeInTheDocument()
    }
    expect(screen.queryByText('ambient')).not.toBeInTheDocument()
    // The remaining 2 are collapsed
    expect(screen.getByText('+2')).toBeInTheDocument()
  })

  it('approve button calls onApprove with correct id', () => {
    withPreview(
      <RecommendationCard
        recommendation={makeRec({ id: 42 })}
        onApprove={onApprove}
        onReject={onReject}
      />,
    )
    fireEvent.click(screen.getByText('Approve'))
    expect(onApprove).toHaveBeenCalledWith(42)
  })

  it('reject button calls onReject with correct id', () => {
    withPreview(
      <RecommendationCard
        recommendation={makeRec({ id: 7 })}
        onApprove={onApprove}
        onReject={onReject}
      />,
    )
    fireEvent.click(screen.getByText('Reject'))
    expect(onReject).toHaveBeenCalledWith(7)
  })

  it('click handler calls onClick with correct id', () => {
    withPreview(
      <RecommendationCard
        recommendation={makeRec({ id: 5 })}
        onApprove={onApprove}
        onReject={onReject}
        onClick={onClick}
      />,
    )
    // Click on the card itself (the artist name text)
    fireEvent.click(screen.getByText('Radiohead'))
    expect(onClick).toHaveBeenCalledWith(5)
  })

  it('why-this popup shows AI reasoning and ranked sources, no raw scores', () => {
    withPreview(
      <RecommendationCard
        recommendation={makeRec()}
        onApprove={onApprove}
        onReject={onReject}
        expanded
      />,
    )
    // expanded renders both the header and hero-banner triggers -- either
    // opens the same popup.
    // biome-ignore lint/style/noNonNullAssertion: expanded card always has at least one
    fireEvent.click(screen.getAllByText('Why this?')[0]!)
    expect(screen.getByText('Great match for your indie taste.')).toBeInTheDocument()
    expect(screen.getByText('Matched from')).toBeInTheDocument()
    expect(screen.getByText('MB')).toBeInTheDocument()
    expect(screen.queryByText('90%')).not.toBeInTheDocument()
  })

  it('expanded state shows more genre pills', () => {
    withPreview(
      <RecommendationCard
        recommendation={makeRec()}
        onApprove={onApprove}
        onReject={onReject}
        expanded
      />,
    )
    // Expanded: max 8, we have 5 genres so all should show
    expect(screen.getByText('electronic')).toBeInTheDocument()
    expect(screen.getByText('experimental')).toBeInTheDocument()
    expect(screen.queryByText('+2')).not.toBeInTheDocument()
  })

  it('selected state applies border highlight', () => {
    const { container } = withPreview(
      <RecommendationCard
        recommendation={makeRec()}
        onApprove={onApprove}
        onReject={onReject}
        isSelected
      />,
    )
    const wrapper = container.firstElementChild as HTMLElement
    const card = wrapper.querySelector('[data-testid="rec-card-button"]') as HTMLElement
    expect(card.className).toContain('border-accent')
  })

  it('handles missing optional fields gracefully', () => {
    const rec = makeRec({
      aiReasoning: null,
      sources: null,
      artist: {
        id: 10,
        name: 'Unknown Artist',
        mbid: 'mbid-002',
        disambiguation: null,
        genres: null,
        tags: null,
        imageUrl: null,
        streamingUrls: null,
      },
    })
    withPreview(
      <RecommendationCard
        recommendation={rec}
        onApprove={onApprove}
        onReject={onReject}
        expanded
      />,
    )
    expect(screen.getAllByText('Unknown Artist').length).toBeGreaterThan(0)
    // No AI reasoning section
    expect(screen.queryByText('Why this artist')).not.toBeInTheDocument()
    // No source scores section
    expect(screen.queryByText('Source Scores')).not.toBeInTheDocument()
  })

  it('shows Restore button for rejected recs instead of Approve/Reject', () => {
    withPreview(
      <RecommendationCard
        recommendation={makeRec({ status: 'rejected' })}
        onApprove={onApprove}
        onReject={onReject}
      />,
    )
    expect(screen.getByText('Rejected')).toBeInTheDocument()
    expect(screen.getByText('Restore')).toBeInTheDocument()
    expect(screen.queryByText('Approve')).not.toBeInTheDocument()
  })

  it('shows Add Failed status with error message', () => {
    withPreview(
      <RecommendationCard
        recommendation={makeRec({ status: 'add_failed', lidarrError: 'Artist not found in MB' })}
        onApprove={onApprove}
        onReject={onReject}
      />,
    )
    expect(screen.getByText('Add Failed')).toBeInTheDocument()
    expect(screen.getByText('Artist not found in MB')).toBeInTheDocument()
  })

  it('shows failed target action errors when Lidarr succeeded but another target failed', () => {
    withPreview(
      <RecommendationCard
        recommendation={makeRec({
          status: 'added_to_lidarr',
          targetActions: {
            'lidarr-1': { status: 'added' },
            'lidarr-2': { status: 'failed', error: 'lidarr add failed' },
          },
        })}
        onApprove={onApprove}
        onReject={onReject}
      />,
    )

    expect(screen.getByText('Added to Lidarr')).toBeInTheDocument()
    expect(screen.getByText('lidarr add failed')).toBeInTheDocument()
  })

  it('hides playlist-only targets from the approve dropdown', () => {
    withPreview(
      <RecommendationCard
        recommendation={makeRec()}
        onApprove={onApprove}
        onReject={onReject}
        targets={[
          { id: 1, type: 'lidarr', name: 'Main Lidarr' },
          { id: 2, type: 'spotify-playlist', name: 'Spotify Mixes' },
        ]}
        onApproveToTarget={vi.fn()}
      />,
    )

    expect(screen.queryByRole('button', { name: '' })).not.toBeInTheDocument()
    expect(screen.getByText('Approve')).toBeInTheDocument()
    expect(screen.queryByText('Add to Spotify playlist')).not.toBeInTheDocument()
  })

  // The ownership/coverage line was deliberately dropped from the Discover
  // card (8760c406) -- it lives on the artist discography and requests pages.
  it('does not show or fetch library album coverage', async () => {
    withPreview(
      <RecommendationCard recommendation={makeRec()} onApprove={onApprove} onReject={onReject} />,
    )

    expect(await screen.findByText('Approve')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /You own/ })).not.toBeInTheDocument()
    expect(mockGetLibraryAlbumCoverage).not.toHaveBeenCalled()
  })

  it('plays top tracks through the cookie-authenticated proxy without a token query', async () => {
    const previewUrl = 'https://cdn.example.test/preview.mp3?signature=abc'
    mockGetArtistTopTracks.mockResolvedValue({
      tracks: [{ name: 'Everything in Its Right Place', previewUrl, durationMs: 251_000 }],
    })
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => 'legacy-session-token'),
      removeItem: vi.fn(),
      setItem: vi.fn(),
    })
    const play = vi.fn().mockResolvedValue(undefined)
    const pause = vi.fn()
    const MockAudio = vi.fn(function (this: HTMLAudioElement, _src?: string) {
      this.play = play
      this.pause = pause
      this.volume = 1
    })
    vi.stubGlobal('Audio', MockAudio)

    withPreview(
      <RecommendationCard
        recommendation={makeRec()}
        onApprove={onApprove}
        onReject={onReject}
        expanded
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Play preview' }))

    expect(MockAudio).toHaveBeenCalledWith(
      `/api/v1/preview/audio?url=${encodeURIComponent(previewUrl)}`,
    )
    expect(String(MockAudio.mock.calls[0]?.[0])).not.toContain('token=')
    expect(play).toHaveBeenCalledTimes(1)
  })
})
