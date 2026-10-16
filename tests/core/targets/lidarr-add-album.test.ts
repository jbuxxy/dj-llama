// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/core/clients/lidarr', () => ({
  createLidarrClient: vi.fn(),
}))

const { createLidarrClient } = await import('@/core/clients/lidarr')
const { createLidarrTarget } = await import('@/core/targets/lidarr')

function mockLidarrClient() {
  const client = {
    getArtists: vi.fn().mockResolvedValue([]),
    addArtist: vi.fn().mockResolvedValue({ id: 42, artistName: 'Artist' }),
    getAlbums: vi.fn().mockResolvedValue([]),
    addAlbumByMbid: vi.fn().mockResolvedValue(null),
    setAlbumsMonitored: vi.fn().mockResolvedValue([]),
    setArtistsMonitored: vi.fn().mockResolvedValue([]),
    triggerCommand: vi.fn().mockResolvedValue({}),
    getCommands: vi.fn().mockResolvedValue([]),
    testConnection: vi.fn().mockResolvedValue({ success: true, message: 'ok' }),
    getRootFolders: vi.fn().mockResolvedValue([{ id: 1, path: '/music' }]),
  }
  vi.mocked(createLidarrClient).mockReturnValue(client as never)
  return client
}

describe('createLidarrTarget().addAlbum', () => {
  it('capabilities includes addAlbum', () => {
    mockLidarrClient()
    const target = createLidarrTarget(1, { url: 'http://lidarr:8686', apiKey: 'abc' })
    expect(target.capabilities).toContain('addAlbum')
  })

  it('adds absent artist unmonitored, monitors only the target album and searches it', async () => {
    const client = mockLidarrClient()
    client.getArtists.mockResolvedValue([])
    client.addArtist.mockResolvedValue({ id: 42 })
    client.getAlbums.mockResolvedValue([
      { id: 7, foreignAlbumId: 'rg-1', monitored: false, title: 'One' },
    ])

    const target = createLidarrTarget(1, {
      url: 'http://lidarr:8686',
      apiKey: 'abc',
    })

    const result = await target.addAlbum?.(
      { artistMbid: 'a1', artistName: 'Artist', releaseGroupMbid: 'rg-1' },
      { qualityProfileId: 1, metadataProfileId: 1, rootFolderId: 1 },
    )

    expect(result?.success).toBe(true)
    expect(result?.targetType).toBe('lidarr')
    expect(result?.targetId).toBe(1)
    expect(result?.externalId).toBe(7)

    expect(client.addArtist).toHaveBeenCalledWith('a1', 'Artist', 1, 1, 1, {
      monitorOption: 'none',
    })
    expect(client.getAlbums).toHaveBeenCalledWith(42)
    expect(client.setAlbumsMonitored).toHaveBeenCalledWith([7], true)
    expect(client.triggerCommand).toHaveBeenCalledWith('AlbumSearch', { albumIds: [7] })
  })

  it('reuses already-tracked artist without re-adding (gap-fill safe)', async () => {
    const client = mockLidarrClient()
    client.getArtists.mockResolvedValue([{ id: 99, foreignArtistId: 'a1' }])
    client.getAlbums.mockResolvedValue([
      { id: 7, foreignAlbumId: 'rg-1', monitored: false, title: 'One' },
    ])

    const target = createLidarrTarget(1, {
      url: 'http://lidarr:8686',
      apiKey: 'abc',
    })

    const result = await target.addAlbum?.(
      { artistMbid: 'a1', artistName: 'Artist', releaseGroupMbid: 'rg-1' },
      { qualityProfileId: 1, metadataProfileId: 1, rootFolderId: 1 },
    )

    expect(result?.success).toBe(true)
    expect(client.addArtist).not.toHaveBeenCalled()
    expect(client.getAlbums).toHaveBeenCalledWith(99)
    expect(client.setArtistsMonitored).toHaveBeenCalledWith([99], true)
    expect(client.setAlbumsMonitored).toHaveBeenCalledWith([7], true)
    expect(client.triggerCommand).toHaveBeenCalledWith('AlbumSearch', { albumIds: [7] })
  })

  // Regression: confirmed live against a real Lidarr instance -- an artist
  // already in the library but sitting unmonitored (e.g. from a bulk library
  // scan) had one of its albums correctly monitored+searched by djllama, but
  // Lidarr's own Wanted/Missing search and RSS sync both skip albums under
  // an unmonitored artist regardless of the album's own flag, so it was
  // never actually grabbed. The artist itself must be (re-)monitored too.
  it('remonitors an already-tracked artist that is currently unmonitored', async () => {
    const client = mockLidarrClient()
    client.getArtists.mockResolvedValue([{ id: 99, foreignArtistId: 'a1', monitored: false }])
    client.getAlbums.mockResolvedValue([
      { id: 7, foreignAlbumId: 'rg-1', monitored: false, title: 'One' },
    ])

    const target = createLidarrTarget(1, {
      url: 'http://lidarr:8686',
      apiKey: 'abc',
    })

    const result = await target.addAlbum?.(
      { artistMbid: 'a1', artistName: 'Artist', releaseGroupMbid: 'rg-1' },
      { qualityProfileId: 1, metadataProfileId: 1, rootFolderId: 1 },
    )

    expect(result?.success).toBe(true)
    expect(client.setArtistsMonitored).toHaveBeenCalledWith([99], true)
  })

  it('does not fail the album add if remonitoring the artist errors', async () => {
    const client = mockLidarrClient()
    client.getArtists.mockResolvedValue([{ id: 99, foreignArtistId: 'a1', monitored: false }])
    client.setArtistsMonitored.mockRejectedValue(new Error('lidarr down'))
    client.getAlbums.mockResolvedValue([
      { id: 7, foreignAlbumId: 'rg-1', monitored: false, title: 'One' },
    ])

    const target = createLidarrTarget(1, {
      url: 'http://lidarr:8686',
      apiKey: 'abc',
    })

    const result = await target.addAlbum?.(
      { artistMbid: 'a1', artistName: 'Artist', releaseGroupMbid: 'rg-1' },
      { qualityProfileId: 1, metadataProfileId: 1, rootFolderId: 1 },
    )

    expect(result?.success).toBe(true)
    expect(client.setAlbumsMonitored).toHaveBeenCalledWith([7], true)
  })

  // Regression: djllama re-requesting an album Lidarr already fully has (e.g.
  // a stale recommendation, or the user re-adding it) must not trigger a
  // duplicate search -- Lidarr matches a specific release per album, so a
  // second grab of a different release fails to import and can knock the
  // existing file's monitored/wanted status around. Monitoring is still set
  // (harmless, keeps future upgrades tracked); only the search is skipped.
  it('skips AlbumSearch when the album already has every track on disk', async () => {
    const client = mockLidarrClient()
    client.getArtists.mockResolvedValue([{ id: 99, foreignArtistId: 'a1' }])
    client.getAlbums.mockResolvedValue([
      {
        id: 7,
        foreignAlbumId: 'rg-1',
        monitored: false,
        title: 'One',
        statistics: { trackCount: 12, trackFileCount: 12, percentOfTracks: 100 },
      },
    ])

    const target = createLidarrTarget(1, {
      url: 'http://lidarr:8686',
      apiKey: 'abc',
    })

    const result = await target.addAlbum?.(
      { artistMbid: 'a1', artistName: 'Artist', releaseGroupMbid: 'rg-1' },
      { qualityProfileId: 1, metadataProfileId: 1, rootFolderId: 1 },
    )

    expect(result?.success).toBe(true)
    expect(result?.externalId).toBe(7)
    expect(client.setAlbumsMonitored).toHaveBeenCalledWith([7], true)
    expect(client.triggerCommand).not.toHaveBeenCalled()
  })

  it('still searches when the album is only partially downloaded', async () => {
    const client = mockLidarrClient()
    client.getArtists.mockResolvedValue([{ id: 99, foreignArtistId: 'a1' }])
    client.getAlbums.mockResolvedValue([
      {
        id: 7,
        foreignAlbumId: 'rg-1',
        monitored: false,
        title: 'One',
        statistics: { trackCount: 12, trackFileCount: 5, percentOfTracks: 42 },
      },
    ])

    const target = createLidarrTarget(1, {
      url: 'http://lidarr:8686',
      apiKey: 'abc',
    })

    const result = await target.addAlbum?.(
      { artistMbid: 'a1', artistName: 'Artist', releaseGroupMbid: 'rg-1' },
      { qualityProfileId: 1, metadataProfileId: 1, rootFolderId: 1 },
    )

    expect(result?.success).toBe(true)
    expect(client.triggerCommand).toHaveBeenCalledWith('AlbumSearch', { albumIds: [7] })
  })

  it('returns failure when the album is not found in Lidarr', async () => {
    vi.useFakeTimers()
    try {
      const client = mockLidarrClient()
      client.getArtists.mockResolvedValue([{ id: 99, foreignArtistId: 'a1' }])
      client.getAlbums.mockResolvedValue([])

      const target = createLidarrTarget(1, {
        url: 'http://lidarr:8686',
        apiKey: 'abc',
      })

      const pending = target.addAlbum?.(
        { artistMbid: 'a1', artistName: 'Artist', releaseGroupMbid: 'rg-1' },
        { qualityProfileId: 1, metadataProfileId: 1, rootFolderId: 1 },
      )
      await vi.runAllTimersAsync()
      const result = await pending

      expect(result?.success).toBe(false)
      expect(result?.error).toBeTruthy()
      expect(client.setAlbumsMonitored).not.toHaveBeenCalled()
      expect(client.triggerCommand).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('returns success:false with "album not found in Lidarr" when the release group is absent after add', async () => {
    vi.useFakeTimers()
    try {
      const client = mockLidarrClient()
      client.getArtists.mockResolvedValue([])
      client.addArtist.mockResolvedValue({ id: 42 })
      // Lidarr has the artist but never surfaces this release group
      client.getAlbums.mockResolvedValue([
        { id: 7, foreignAlbumId: 'some-other-rg', monitored: false, title: 'Other' },
      ])

      const target = createLidarrTarget(1, {
        url: 'http://lidarr:8686',
        apiKey: 'abc',
      })

      const pending = target.addAlbum?.(
        { artistMbid: 'a1', artistName: 'Artist', releaseGroupMbid: 'rg-missing' },
        { qualityProfileId: 1, metadataProfileId: 1, rootFolderId: 1 },
      )
      await vi.runAllTimersAsync()
      const result = await pending

      expect(result?.success).toBe(false)
      expect(result?.error).toBe('album not found in Lidarr')
      expect(client.setAlbumsMonitored).not.toHaveBeenCalled()
      expect(client.triggerCommand).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  // Regression: confirmed live (2026-08) -- Lidarr can know about a
  // release-group for an already-tracked artist (resolvable via an exact
  // "lidarr:<mbid>" lookup) without ever backfilling it into that artist's
  // synced getAlbums() list on its own, even after a refresh. addAlbumByMbid
  // (client-level) closes that gap by posting the lookup payload straight
  // back to Lidarr; addAlbum must fall back to it before giving up.
  it('adds the album via exact-MBID lookup when it never appears in the synced list', async () => {
    vi.useFakeTimers()
    try {
      const client = mockLidarrClient()
      client.getArtists.mockResolvedValue([{ id: 99, foreignArtistId: 'a1' }])
      client.getAlbums.mockResolvedValue([])
      client.addAlbumByMbid.mockResolvedValue({
        id: 7,
        foreignAlbumId: 'rg-1',
        monitored: true,
        title: 'One',
      })

      const target = createLidarrTarget(1, {
        url: 'http://lidarr:8686',
        apiKey: 'abc',
      })

      const pending = target.addAlbum?.(
        { artistMbid: 'a1', artistName: 'Artist', releaseGroupMbid: 'rg-1' },
        { qualityProfileId: 1, metadataProfileId: 1, rootFolderId: 1 },
      )
      await vi.runAllTimersAsync()
      const result = await pending

      expect(result?.success).toBe(true)
      expect(result?.externalId).toBe(7)
      expect(client.addAlbumByMbid).toHaveBeenCalledWith('rg-1')
      expect(client.setAlbumsMonitored).toHaveBeenCalledWith([7], true)
      expect(client.triggerCommand).toHaveBeenCalledWith('AlbumSearch', { albumIds: [7] })
    } finally {
      vi.useRealTimers()
    }
  })

  it('still fails when addAlbumByMbid also cannot find the album', async () => {
    vi.useFakeTimers()
    try {
      const client = mockLidarrClient()
      client.getArtists.mockResolvedValue([{ id: 99, foreignArtistId: 'a1' }])
      client.getAlbums.mockResolvedValue([])
      client.addAlbumByMbid.mockResolvedValue(null)

      const target = createLidarrTarget(1, {
        url: 'http://lidarr:8686',
        apiKey: 'abc',
      })

      const pending = target.addAlbum?.(
        { artistMbid: 'a1', artistName: 'Artist', releaseGroupMbid: 'rg-1' },
        { qualityProfileId: 1, metadataProfileId: 1, rootFolderId: 1 },
      )
      await vi.runAllTimersAsync()
      const result = await pending

      expect(result?.success).toBe(false)
      expect(result?.error).toBe('album not found in Lidarr')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not fail the album add if addAlbumByMbid itself errors', async () => {
    vi.useFakeTimers()
    try {
      const client = mockLidarrClient()
      client.getArtists.mockResolvedValue([{ id: 99, foreignArtistId: 'a1' }])
      client.getAlbums.mockResolvedValue([])
      client.addAlbumByMbid.mockRejectedValue(new Error('lidarr down'))

      const target = createLidarrTarget(1, {
        url: 'http://lidarr:8686',
        apiKey: 'abc',
      })

      const pending = target.addAlbum?.(
        { artistMbid: 'a1', artistName: 'Artist', releaseGroupMbid: 'rg-1' },
        { qualityProfileId: 1, metadataProfileId: 1, rootFolderId: 1 },
      )
      await vi.runAllTimersAsync()
      const result = await pending

      expect(result?.success).toBe(false)
      expect(result?.error).toBe('album not found in Lidarr')
    } finally {
      vi.useRealTimers()
    }
  })

  // Regression: Lidarr populates a just-added artist's album list
  // asynchronously; addAlbum must poll like addArtist does instead of failing
  // on the first empty getAlbums response.
  it('polls until the album appears after adding a new artist', async () => {
    vi.useFakeTimers()
    try {
      const client = mockLidarrClient()
      client.getArtists.mockResolvedValue([])
      client.addArtist.mockResolvedValue({ id: 42 })
      client.getAlbums
        .mockResolvedValueOnce([])
        .mockResolvedValue([{ id: 7, foreignAlbumId: 'rg-1', monitored: false, title: 'One' }])

      const target = createLidarrTarget(1, {
        url: 'http://lidarr:8686',
        apiKey: 'abc',
      })

      const pending = target.addAlbum?.(
        { artistMbid: 'a1', artistName: 'Artist', releaseGroupMbid: 'rg-1' },
        { qualityProfileId: 1, metadataProfileId: 1, rootFolderId: 1 },
      )
      await vi.runAllTimersAsync()
      const result = await pending

      expect(result?.success).toBe(true)
      expect(result?.externalId).toBe(7)
      expect(client.getAlbums).toHaveBeenCalledTimes(2)
      expect(client.setAlbumsMonitored).toHaveBeenCalledWith([7], true)
      expect(client.triggerCommand).toHaveBeenCalledWith('AlbumSearch', { albumIds: [7] })
    } finally {
      vi.useRealTimers()
    }
  })

  // Regression: an already-tracked artist's album list can still be mid-refresh
  // (e.g. a recent Lidarr metadata refresh cycle), so addAlbum must poll here
  // too instead of failing on the first empty getAlbums response.
  it('polls until the album appears for an already-tracked artist', async () => {
    vi.useFakeTimers()
    try {
      const client = mockLidarrClient()
      client.getArtists.mockResolvedValue([{ id: 99, foreignArtistId: 'a1' }])
      client.getAlbums
        .mockResolvedValueOnce([])
        .mockResolvedValue([{ id: 7, foreignAlbumId: 'rg-1', monitored: false, title: 'One' }])

      const target = createLidarrTarget(1, {
        url: 'http://lidarr:8686',
        apiKey: 'abc',
      })

      const pending = target.addAlbum?.(
        { artistMbid: 'a1', artistName: 'Artist', releaseGroupMbid: 'rg-1' },
        { qualityProfileId: 1, metadataProfileId: 1, rootFolderId: 1 },
      )
      await vi.runAllTimersAsync()
      const result = await pending

      expect(result?.success).toBe(true)
      expect(result?.externalId).toBe(7)
      expect(client.getAlbums).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives up and fails for an already-tracked artist when the album never appears', async () => {
    vi.useFakeTimers()
    try {
      const client = mockLidarrClient()
      client.getArtists.mockResolvedValue([{ id: 99, foreignArtistId: 'a1' }])
      client.getAlbums.mockResolvedValue([])

      const target = createLidarrTarget(1, {
        url: 'http://lidarr:8686',
        apiKey: 'abc',
      })

      const pending = target.addAlbum?.(
        { artistMbid: 'a1', artistName: 'Artist', releaseGroupMbid: 'rg-1' },
        { qualityProfileId: 1, metadataProfileId: 1, rootFolderId: 1 },
      )
      await vi.runAllTimersAsync()
      const result = await pending

      expect(result?.success).toBe(false)
      expect(client.getAlbums.mock.calls.length).toBeGreaterThan(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
