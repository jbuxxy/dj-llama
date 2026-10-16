// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { importExternalPlaylistToPlex } from '@/core/playlists/external-import'
import { createPlexPlaylistTarget } from '@/core/targets/plex-playlist'

vi.mock('@/core/targets/plex-playlist', () => ({
  createPlexPlaylistTarget: vi.fn(),
}))

const mockCreatePlaylist = vi.fn()

function makeTarget() {
  return {
    id: 1,
    name: 'plex',
    capabilities: ['createPlaylist'] as const,
    createPlaylist: mockCreatePlaylist,
  }
}

const reconcileMissingTracks = vi.fn().mockResolvedValue(undefined)
const missingTracksDb = { reconcileMissingTracks }

beforeEach(() => {
  vi.clearAllMocks()
  reconcileMissingTracks.mockResolvedValue(undefined)
  vi.mocked(createPlexPlaylistTarget).mockReturnValue(
    makeTarget() as unknown as ReturnType<typeof createPlexPlaylistTarget>,
  )
})

describe('importExternalPlaylistToPlex', () => {
  it('pushes every track to Plex and reports zero missing when everything matches', async () => {
    mockCreatePlaylist.mockResolvedValue({
      success: true,
      playlistId: 'plex-123',
      playlistName: 'My Mix',
      itemsAdded: 2,
      unmatchedItems: [],
    })

    const result = await importExternalPlaylistToPlex({
      name: 'My Mix',
      tracks: [
        { artistName: 'Radiohead', trackName: 'Creep', albumTitle: 'Pablo Honey' },
        { artistName: 'Portishead', trackName: 'Glory Box', albumTitle: 'Dummy' },
      ],
      plex: { url: 'http://plex.local', token: 'plex-token' },
      targetId: 7,
      playlistId: 12,
      pushToPlex: true,
      missingTracksDb,
    })

    expect(createPlexPlaylistTarget).toHaveBeenCalledWith(7, {
      url: 'http://plex.local',
      token: 'plex-token',
    })
    expect(mockCreatePlaylist).toHaveBeenCalledWith(
      'My Mix',
      [
        { artistName: 'Radiohead', artistMbid: '', trackName: 'Creep' },
        { artistName: 'Portishead', artistMbid: '', trackName: 'Glory Box' },
      ],
      { dryRun: false },
    )
    expect(result).toEqual({
      playlistId: 'plex-123',
      playlistName: 'My Mix',
      tracksTotal: 2,
      tracksMatched: 2,
      missingCount: 0,
    })
    expect(reconcileMissingTracks).toHaveBeenCalledWith(12, [])
  })

  it('passes dryRun through when pushToPlex is false', async () => {
    mockCreatePlaylist.mockResolvedValue({
      success: true,
      playlistId: 'plex-123',
      playlistName: 'My Mix',
      itemsAdded: 1,
      unmatchedItems: [],
    })

    await importExternalPlaylistToPlex({
      name: 'My Mix',
      tracks: [{ artistName: 'Radiohead', trackName: 'Creep' }],
      plex: { url: 'http://plex.local', token: 'plex-token' },
      targetId: 7,
      playlistId: 12,
      pushToPlex: false,
      missingTracksDb,
    })

    expect(mockCreatePlaylist).toHaveBeenCalledWith(
      'My Mix',
      [{ artistName: 'Radiohead', artistMbid: '', trackName: 'Creep' }],
      { dryRun: true },
    )
  })

  it('reconciles one missing entry per unique (artist, track) among unmatched tracks', async () => {
    mockCreatePlaylist.mockResolvedValue({
      success: true,
      playlistId: 'plex-123',
      playlistName: 'My Mix',
      itemsAdded: 1,
      unmatchedItems: [
        { artistName: 'Aphex Twin', trackName: 'Xtal' },
        { artistName: 'Boards of Canada', trackName: 'Roygbiv' },
      ],
    })

    const result = await importExternalPlaylistToPlex({
      name: 'My Mix',
      tracks: [
        { artistName: 'Aphex Twin', trackName: 'Xtal', albumTitle: 'Selected Ambient Works 85-92' },
        {
          artistName: 'Boards of Canada',
          trackName: 'Roygbiv',
          albumTitle: 'Music Has the Right to Children',
        },
        { artistName: 'Radiohead', trackName: 'Creep', albumTitle: 'Pablo Honey' },
      ],
      plex: { url: 'http://plex.local', token: 'plex-token' },
      targetId: 7,
      playlistId: 12,
      pushToPlex: true,
      missingTracksDb,
    })

    expect(reconcileMissingTracks).toHaveBeenCalledWith(12, [
      { artistName: 'Aphex Twin', trackName: 'Xtal', albumTitle: 'Selected Ambient Works 85-92' },
      {
        artistName: 'Boards of Canada',
        trackName: 'Roygbiv',
        albumTitle: 'Music Has the Right to Children',
      },
    ])
    expect(result).toEqual({
      playlistId: 'plex-123',
      playlistName: 'My Mix',
      tracksTotal: 3,
      tracksMatched: 1,
      missingCount: 2,
    })
  })

  it('throws when the Plex target reports failure', async () => {
    mockCreatePlaylist.mockResolvedValue({
      success: false,
      error: 'Plex is unreachable',
    })

    await expect(
      importExternalPlaylistToPlex({
        name: 'My Mix',
        tracks: [{ artistName: 'Radiohead', trackName: 'Creep' }],
        plex: { url: 'http://plex.local', token: 'plex-token' },
        targetId: 7,
        playlistId: 12,
        pushToPlex: true,
        missingTracksDb,
      }),
    ).rejects.toThrow('Plex is unreachable')
  })

  it('falls back to the original name when Plex omits playlistName', async () => {
    mockCreatePlaylist.mockResolvedValue({
      success: true,
      playlistId: 'plex-123',
      itemsAdded: 1,
      unmatchedItems: [],
    })

    const result = await importExternalPlaylistToPlex({
      name: 'My Mix',
      tracks: [{ artistName: 'Radiohead', trackName: 'Creep' }],
      plex: { url: 'http://plex.local', token: 'plex-token' },
      targetId: 7,
      playlistId: 12,
      pushToPlex: true,
      missingTracksDb,
    })

    expect(result.playlistName).toBe('My Mix')
  })
})
