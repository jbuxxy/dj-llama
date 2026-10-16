// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPlexPlaylistTarget, sweepPlaylistLiveTracks } from '@/core/targets/plex-playlist'

const CONFIG = {
  url: 'http://plex:32400/',
  token: 'plex-secret-token',
}

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body))
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createPlexPlaylistTarget', () => {
  it('returns connection metadata and sends the Plex token header', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      ok({
        MediaContainer: {
          friendlyName: 'Home Plex',
          version: '1.41.0',
          machineIdentifier: 'machine-1',
        },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await createPlexPlaylistTarget(4, CONFIG).testConnection()

    expect(result).toMatchObject({
      success: true,
      details: { machineIdentifier: 'machine-1', version: '1.41.0' },
    })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://plex:32400/')
    expect(new Headers(init.headers).get('X-Plex-Token')).toBe(CONFIG.token)
  })

  it('uses the exact search match when creating a playlist', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation((url: string | URL | Request, init?: RequestInit) => {
        const value = String(url)
        if (value.includes('/hubs/search')) {
          return Promise.resolve(
            ok({
              MediaContainer: {
                Hub: [
                  {
                    type: 'track',
                    Metadata: [
                      {
                        ratingKey: 'partial',
                        title: 'Creep (Live)',
                        grandparentTitle: 'Radiohead',
                        type: 'track',
                      },
                      {
                        ratingKey: 'exact',
                        title: 'Creep',
                        grandparentTitle: 'Radiohead',
                        type: 'track',
                      },
                    ],
                  },
                ],
              },
            }),
          )
        }
        if (value.includes('/playlists?') && init?.method === 'POST') {
          return Promise.resolve(
            ok({ MediaContainer: { Metadata: [{ ratingKey: 'playlist-1', title: 'Picks' }] } }),
          )
        }
        if (value.includes('/playlists?')) {
          // Pre-create existence check -- nothing to replace in this test.
          return Promise.resolve(ok({ MediaContainer: { Metadata: [] } }))
        }
        return Promise.resolve(ok({ MediaContainer: { machineIdentifier: 'machine-1' } }))
      })
    vi.stubGlobal('fetch', fetchMock)

    const result = await createPlexPlaylistTarget(4, CONFIG).createPlaylist?.('Picks', [
      { artistName: 'Radiohead', artistMbid: 'mbid-rh', trackName: 'Creep' },
    ])

    expect(result).toMatchObject({ success: true, playlistId: 'playlist-1', itemsAdded: 1 })
    const createUrl = String(
      fetchMock.mock.calls.find(
        ([url, init]) => String(url).includes('/playlists?') && init?.method === 'POST',
      )?.[0],
    )
    expect(decodeURIComponent(createUrl)).toContain('/metadata/exact')
    expect(decodeURIComponent(createUrl)).not.toContain('/metadata/partial')
  })

  it('joins multiple matched tracks into a single comma-separated uri param', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation((url: string | URL | Request, init?: RequestInit) => {
        const value = decodeURIComponent(String(url))
        if (value.includes('/hubs/search')) {
          const key = value.includes('Karma')
            ? 'rk-karma'
            : value.includes('Creep')
              ? 'rk-creep'
              : 'rk-other'
          return Promise.resolve(
            ok({
              MediaContainer: {
                Hub: [
                  {
                    type: 'track',
                    Metadata: [
                      { ratingKey: key, title: 'x', grandparentTitle: 'Radiohead', type: 'track' },
                    ],
                  },
                ],
              },
            }),
          )
        }
        if (value.includes('/playlists?') && init?.method === 'POST') {
          return Promise.resolve(
            ok({ MediaContainer: { Metadata: [{ ratingKey: 'playlist-1', title: 'Picks' }] } }),
          )
        }
        if (value.includes('/playlists?')) {
          return Promise.resolve(ok({ MediaContainer: { Metadata: [] } }))
        }
        return Promise.resolve(ok({ MediaContainer: { machineIdentifier: 'machine-1' } }))
      })
    vi.stubGlobal('fetch', fetchMock)

    const result = await createPlexPlaylistTarget(4, CONFIG).createPlaylist?.('Picks', [
      { artistName: 'Radiohead', artistMbid: 'mbid-rh', trackName: 'Creep' },
      { artistName: 'Radiohead', artistMbid: 'mbid-rh', trackName: 'Karma Police' },
    ])

    expect(result).toMatchObject({ success: true, itemsAdded: 2 })
    const createCalls = fetchMock.mock.calls.filter(
      ([url, init]) => String(url).includes('/playlists?') && init?.method === 'POST',
    )
    expect(createCalls).toHaveLength(1)
    const createUrl = decodeURIComponent(String(createCalls[0]?.[0]))
    // Exactly one `uri=` occurrence, containing both rating keys comma-joined --
    // repeating `uri=` per track silently collapses to a single track in Plex.
    expect(createUrl.match(/uri=/g)).toHaveLength(1)
    expect(createUrl).toContain('/metadata/rk-creep,rk-karma')
    expect(createUrl).not.toContain('rk-other')
  })

  it('matches an unambiguous title-only hit when the source tags a cover-band alias instead of the real artist', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation((url: string | URL | Request, init?: RequestInit) => {
        const value = decodeURIComponent(String(url))
        if (value.includes('/hubs/search')) {
          // Combined query (artist + track) finds nothing -- "Revline" isn't
          // a real artist. Title-only query finds the real recording, twice
          // (two albums), both credited to the same real artist.
          if (value.includes('Revline')) {
            return Promise.resolve(
              ok({ MediaContainer: { Hub: [{ type: 'track', Metadata: [] }] } }),
            )
          }
          return Promise.resolve(
            ok({
              MediaContainer: {
                Hub: [
                  {
                    type: 'track',
                    Metadata: [
                      {
                        ratingKey: 'rk1',
                        title: "Boot Scootin' Boogie",
                        grandparentTitle: 'Brooks & Dunn',
                        parentTitle: '#1s... And Then Some',
                        type: 'track',
                      },
                      {
                        ratingKey: 'rk2',
                        title: 'Boot Scootin’ Boogie',
                        grandparentTitle: 'Brooks & Dunn',
                        parentTitle: 'Brand New Man',
                        type: 'track',
                      },
                    ],
                  },
                ],
              },
            }),
          )
        }
        if (value.includes('/playlists?') && init?.method === 'POST') {
          return Promise.resolve(
            ok({ MediaContainer: { Metadata: [{ ratingKey: 'playlist-1', title: 'Picks' }] } }),
          )
        }
        if (value.includes('/playlists?')) {
          return Promise.resolve(ok({ MediaContainer: { Metadata: [] } }))
        }
        return Promise.resolve(ok({ MediaContainer: { machineIdentifier: 'machine-1' } }))
      })
    vi.stubGlobal('fetch', fetchMock)

    const result = await createPlexPlaylistTarget(4, CONFIG).createPlaylist?.('Picks', [
      { artistName: 'Revline', artistMbid: '', trackName: "Boot Scootin' Boogie" },
    ])

    expect(result).toMatchObject({ success: true, itemsAdded: 1, unmatchedItems: [] })
    const createUrl = decodeURIComponent(
      String(
        fetchMock.mock.calls.find(
          ([url, init]) => String(url).includes('/playlists?') && init?.method === 'POST',
        )?.[0],
      ),
    )
    expect(createUrl).toMatch(/\/metadata\/rk[12]/)
  })

  it('leaves a track unmatched when two different real artists share the exact title', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation((url: string | URL | Request, init?: RequestInit) => {
        const value = decodeURIComponent(String(url))
        if (value.includes('/hubs/search')) {
          // "+"-encoded spaces mean decodeURIComponent won't restore a plain
          // "JD & The Straight Chasers" substring -- "JD" alone is enough to
          // tell the combined (artist+track) query apart from the title-only one.
          if (value.includes('JD')) {
            return Promise.resolve(
              ok({ MediaContainer: { Hub: [{ type: 'track', Metadata: [] }] } }),
            )
          }
          return Promise.resolve(
            ok({
              MediaContainer: {
                Hub: [
                  {
                    type: 'track',
                    Metadata: [
                      {
                        ratingKey: 'ledoux',
                        title: 'Life Is A Highway',
                        grandparentTitle: 'Chris LeDoux',
                        type: 'track',
                      },
                      {
                        ratingKey: 'flatts',
                        title: 'Life Is a Highway',
                        grandparentTitle: 'Rascal Flatts',
                        type: 'track',
                      },
                    ],
                  },
                ],
              },
            }),
          )
        }
        if (value.includes('/playlists?') && init?.method === 'POST') {
          return Promise.resolve(
            ok({ MediaContainer: { Metadata: [{ ratingKey: 'playlist-1', title: 'Picks' }] } }),
          )
        }
        if (value.includes('/playlists?')) {
          return Promise.resolve(ok({ MediaContainer: { Metadata: [] } }))
        }
        return Promise.resolve(ok({ MediaContainer: { machineIdentifier: 'machine-1' } }))
      })
    vi.stubGlobal('fetch', fetchMock)

    const result = await createPlexPlaylistTarget(4, CONFIG).createPlaylist?.('Picks', [
      { artistName: 'JD & The Straight Chasers', artistMbid: '', trackName: 'Life Is A Highway' },
    ])

    expect(result).toMatchObject({
      success: true,
      itemsAdded: 0,
      unmatchedItems: [
        expect.objectContaining({ trackName: 'Life Is A Highway', reason: 'not_found' }),
      ],
    })
  })

  it('makes one playlist-create request and retains a redacted HTTP body', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string | URL | Request) => {
      if (String(url).includes('/playlists?')) {
        return Promise.resolve(new Response(`token=${CONFIG.token}`, { status: 500 }))
      }
      return Promise.resolve(ok({ MediaContainer: { machineIdentifier: 'machine-1' } }))
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await createPlexPlaylistTarget(4, CONFIG).createPlaylist?.('Picks', [])

    expect(result).toMatchObject({
      success: false,
      error: 'Plex API 500: token=[REDACTED]',
    })
    expect(result?.error).not.toContain(CONFIG.token)
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) => String(url).includes('/playlists?') && init?.method === 'POST',
      ),
    ).toHaveLength(1)
  })

  it('deletes an existing same-named playlist before creating the replacement', async () => {
    const deleteCalls: string[] = []
    const fetchMock = vi
      .fn()
      .mockImplementation((url: string | URL | Request, init?: RequestInit) => {
        const value = String(url)
        if (init?.method === 'DELETE') {
          deleteCalls.push(value)
          return Promise.resolve(ok({}))
        }
        if (value.includes('/playlists?') && init?.method === 'POST') {
          return Promise.resolve(
            ok({ MediaContainer: { Metadata: [{ ratingKey: 'playlist-new', title: 'Picks' }] } }),
          )
        }
        if (value.includes('/playlists?')) {
          return Promise.resolve(
            ok({ MediaContainer: { Metadata: [{ ratingKey: 'playlist-old', title: 'Picks' }] } }),
          )
        }
        return Promise.resolve(ok({ MediaContainer: { machineIdentifier: 'machine-1' } }))
      })
    vi.stubGlobal('fetch', fetchMock)

    const result = await createPlexPlaylistTarget(4, CONFIG).createPlaylist?.('Picks', [])

    expect(result).toMatchObject({ success: true, playlistId: 'playlist-new' })
    expect(deleteCalls).toEqual(['http://plex:32400/playlists/playlist-old'])
  })

  it('deletes every orphaned duplicate sharing the name, not just one', async () => {
    const deleteCalls: string[] = []
    const fetchMock = vi
      .fn()
      .mockImplementation((url: string | URL | Request, init?: RequestInit) => {
        const value = String(url)
        if (init?.method === 'DELETE') {
          deleteCalls.push(value)
          return Promise.resolve(ok({}))
        }
        if (value.includes('/playlists?') && init?.method === 'POST') {
          return Promise.resolve(
            ok({ MediaContainer: { Metadata: [{ ratingKey: 'playlist-new', title: 'Picks' }] } }),
          )
        }
        if (value.includes('/playlists?')) {
          return Promise.resolve(
            ok({
              MediaContainer: {
                Metadata: [
                  { ratingKey: 'playlist-old-1', title: 'Picks' },
                  { ratingKey: 'playlist-old-2', title: 'Picks' },
                  { ratingKey: 'playlist-other', title: 'Something Else' },
                ],
              },
            }),
          )
        }
        return Promise.resolve(ok({ MediaContainer: { machineIdentifier: 'machine-1' } }))
      })
    vi.stubGlobal('fetch', fetchMock)

    const result = await createPlexPlaylistTarget(4, CONFIG).createPlaylist?.('Picks', [])

    expect(result).toMatchObject({ success: true, playlistId: 'playlist-new' })
    expect(deleteCalls.sort()).toEqual(
      [
        'http://plex:32400/playlists/playlist-old-1',
        'http://plex:32400/playlists/playlist-old-2',
      ].sort(),
    )
  })

  it('returns a provider-shaped error for malformed JSON', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string | URL | Request) => {
      if (String(url).includes('/playlists?')) return Promise.resolve(new Response('not-json'))
      return Promise.resolve(ok({ MediaContainer: { machineIdentifier: 'machine-1' } }))
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await createPlexPlaylistTarget(4, CONFIG).createPlaylist?.('Picks', [])

    expect(result).toMatchObject({
      success: false,
      error: 'Plex API 200: Invalid JSON: not-json',
    })
  })

  it('returns timeout failures without exposing the token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new DOMException('request timed out', 'AbortError')),
    )

    const result = await createPlexPlaylistTarget(4, CONFIG).testConnection()

    expect(result).toMatchObject({ success: false, message: 'request timed out' })
    expect(result.message).not.toContain(CONFIG.token)
  })
})

describe('sweepPlaylistLiveTracks', () => {
  it('replaces a flagged live item in place and leaves the rest untouched', async () => {
    const requests: Array<{ url: string; method: string }> = []
    const fetchMock = vi
      .fn()
      .mockImplementation((url: string | URL | Request, init?: RequestInit) => {
        const value = String(url)
        requests.push({ url: value, method: init?.method ?? 'GET' })

        if (value.includes('/playlists?playlistType=audio')) {
          return Promise.resolve(
            ok({ MediaContainer: { Metadata: [{ ratingKey: 'pl-1', title: 'Summer Hits' }] } }),
          )
        }
        if (value.includes('/playlists/pl-1/items') && init?.method === 'PUT') {
          return Promise.resolve(ok({ MediaContainer: {} }))
        }
        if (value.includes('/playlists/pl-1/items/2655730') && init?.method === 'DELETE') {
          return Promise.resolve(ok({}))
        }
        if (value.includes('/playlists/pl-1/items')) {
          return Promise.resolve(
            ok({
              MediaContainer: {
                Metadata: [
                  {
                    ratingKey: 'rk-live',
                    title: 'Alone (live)',
                    grandparentTitle: 'Heart',
                    parentTitle: 'Playlist: The Very Best of Heart',
                    playlistItemID: 2655730,
                  },
                  {
                    ratingKey: 'rk-studio-untouched',
                    title: 'Cruel Summer',
                    grandparentTitle: 'Bananarama',
                    parentTitle: 'Bananarama',
                    playlistItemID: 2655731,
                  },
                ],
              },
            }),
          )
        }
        if (value.includes('/hubs/search')) {
          return Promise.resolve(
            ok({
              MediaContainer: {
                Hub: [
                  {
                    type: 'track',
                    Metadata: [
                      {
                        ratingKey: 'rk-studio-alone',
                        title: 'Alone',
                        grandparentTitle: 'Heart',
                        parentTitle: 'Bad Animals',
                        type: 'track',
                      },
                    ],
                  },
                ],
              },
            }),
          )
        }
        return Promise.resolve(ok({ MediaContainer: { machineIdentifier: 'machine-1' } }))
      })
    vi.stubGlobal('fetch', fetchMock)

    const result = await sweepPlaylistLiveTracks(CONFIG, 'Summer Hits')

    expect(result).toMatchObject({
      success: true,
      playlistFound: true,
      checked: 2,
      replaced: [{ artistName: 'Heart', trackName: 'Alone (live)' }],
      stillLive: [],
    })

    const putCall = requests.find((r) => r.method === 'PUT')
    expect(decodeURIComponent(putCall?.url ?? '')).toContain('/metadata/rk-studio-alone')
    const deleteCall = requests.find((r) => r.method === 'DELETE')
    expect(deleteCall?.url).toContain('/playlists/pl-1/items/2655730')
    // The already-studio track never went through a replace cycle.
    expect(requests.some((r) => r.method === 'DELETE' && r.url.includes('2655731'))).toBe(false)
  })

  it('reports a still-live track as a genuine gap when no studio version is found', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation((url: string | URL | Request, init?: RequestInit) => {
        const value = String(url)
        if (value.includes('/playlists?playlistType=audio')) {
          return Promise.resolve(
            ok({ MediaContainer: { Metadata: [{ ratingKey: 'pl-1', title: 'Summer Hits' }] } }),
          )
        }
        if (value.includes('/playlists/pl-1/items') && init?.method && init.method !== 'GET') {
          throw new Error(`unexpected mutating call: ${init.method} ${value}`)
        }
        if (value.includes('/playlists/pl-1/items')) {
          return Promise.resolve(
            ok({
              MediaContainer: {
                Metadata: [
                  {
                    ratingKey: 'rk-live',
                    title: 'Alone (live)',
                    grandparentTitle: 'Heart',
                    parentTitle: 'Playlist: The Very Best of Heart',
                    playlistItemID: 2655730,
                  },
                ],
              },
            }),
          )
        }
        if (value.includes('/hubs/search')) {
          // Only the same live recording comes back -- no studio version in
          // the library, so nothing to swap in.
          return Promise.resolve(
            ok({
              MediaContainer: {
                Hub: [
                  {
                    type: 'track',
                    Metadata: [
                      {
                        ratingKey: 'rk-live',
                        title: 'Alone (live)',
                        grandparentTitle: 'Heart',
                        parentTitle: 'Playlist: The Very Best of Heart',
                        type: 'track',
                      },
                    ],
                  },
                ],
              },
            }),
          )
        }
        return Promise.resolve(ok({ MediaContainer: { machineIdentifier: 'machine-1' } }))
      })
    vi.stubGlobal('fetch', fetchMock)

    const result = await sweepPlaylistLiveTracks(CONFIG, 'Summer Hits')

    expect(result).toMatchObject({
      success: true,
      playlistFound: true,
      checked: 1,
      replaced: [],
      stillLive: [{ artistName: 'Heart', trackName: 'Alone (live)' }],
    })
  })

  it('reports playlistFound: false when no Plex playlist matches the name', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok({ MediaContainer: { Metadata: [] } })))

    const result = await sweepPlaylistLiveTracks(CONFIG, 'Nonexistent')

    expect(result).toEqual({ success: true, playlistFound: false })
  })
})
