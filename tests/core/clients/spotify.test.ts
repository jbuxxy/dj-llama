// @vitest-environment node

import { describe, expect, it } from 'vitest'
import {
  type BridgeRunner,
  findExactArtistByName,
  getPlaylistTracks,
  getPopularAlbumsForArtist,
  SpotifyNotFoundError,
  searchTracks,
} from '@/core/clients/spotify'

function stdoutRunner(payload: unknown): BridgeRunner {
  return async () => ({ stdout: JSON.stringify(payload), stderr: '', exitCode: 0 })
}

function errorRunner(message: string, exitCode: number): BridgeRunner {
  return async () => ({ stdout: '', stderr: JSON.stringify({ error: message }), exitCode })
}

describe('searchTracks', () => {
  it('maps bridge track results, treating playCount as the popularity proxy', async () => {
    const runner = stdoutRunner({
      tracks: [
        { name: 'Creep', artists: ['Radiohead'], uri: 'spotify:track:1', playCount: 500 },
        { name: 'Unknown Count', artists: ['Someone'], uri: 'spotify:track:2', playCount: null },
      ],
      artists: [],
    })

    const results = await searchTracks('creep', 10, runner)

    expect(results).toEqual([
      { name: 'Creep', artists: ['Radiohead'], uri: 'spotify:track:1', popularity: 500 },
      { name: 'Unknown Count', artists: ['Someone'], uri: 'spotify:track:2', popularity: 0 },
    ])
  })

  it('propagates a not-found error as SpotifyNotFoundError', async () => {
    const runner = errorRunner('Spotify embed page reports the entity is unavailable.', 2)
    await expect(searchTracks('nothing', 10, runner)).rejects.toBeInstanceOf(SpotifyNotFoundError)
  })

  it('propagates a generic bridge failure as a plain Error', async () => {
    const runner = errorRunner('token exchange failed', 1)
    await expect(searchTracks('anything', 10, runner)).rejects.toThrow('token exchange failed')
  })
})

describe('findExactArtistByName', () => {
  it('returns the single case-insensitive exact match', async () => {
    const runner = stdoutRunner({
      tracks: [],
      artists: [
        { name: 'Portishead Experience', id: 'wrong' },
        { name: 'portishead', id: 'right' },
      ],
    })

    await expect(findExactArtistByName('Portishead', runner)).resolves.toEqual({
      name: 'portishead',
      id: 'right',
    })
  })

  it('returns null when there is no exact match', async () => {
    const runner = stdoutRunner({
      tracks: [],
      artists: [{ name: 'Portishead Experience', id: 'wrong' }],
    })

    await expect(findExactArtistByName('Portishead', runner)).resolves.toBeNull()
  })

  it('returns null when multiple exact matches tie', async () => {
    const runner = stdoutRunner({
      tracks: [],
      artists: [
        { name: 'Portishead', id: 'a' },
        { name: 'portishead', id: 'b' },
      ],
    })

    await expect(findExactArtistByName('Portishead', runner)).resolves.toBeNull()
  })
})

describe('getPopularAlbumsForArtist', () => {
  it('maps discography entries with popularity always 0 (no ranking signal available)', async () => {
    const runner = stdoutRunner({
      releases: [
        { id: 'album-1', title: 'Love & Fear' },
        { id: 'album-2', title: 'The Sum' },
      ],
    })

    await expect(getPopularAlbumsForArtist('artist-1', 3, runner)).resolves.toEqual([
      { id: 'album-1', title: 'Love & Fear', popularity: 0 },
      { id: 'album-2', title: 'The Sum', popularity: 0 },
    ])
  })
})

describe('getPlaylistTracks', () => {
  it('maps playlist track entries and cover art, defaulting missing fields to undefined', async () => {
    const runner = stdoutRunner({
      name: 'Today’s Top Hits',
      imageUrl: 'https://i.scdn.co/image/playlist',
      tracks: [
        {
          artistName: 'Radiohead',
          trackName: 'Creep',
          albumTitle: 'Pablo Honey',
          coverUrl: 'https://i.scdn.co/image/pablo-honey',
        },
        { artistName: 'Portishead', trackName: 'Glory Box', albumTitle: null, coverUrl: null },
      ],
    })

    await expect(getPlaylistTracks('pl-1', 500, runner)).resolves.toEqual({
      name: 'Today’s Top Hits',
      imageUrl: 'https://i.scdn.co/image/playlist',
      tracks: [
        {
          artistName: 'Radiohead',
          trackName: 'Creep',
          albumTitle: 'Pablo Honey',
          coverUrl: 'https://i.scdn.co/image/pablo-honey',
        },
        {
          artistName: 'Portishead',
          trackName: 'Glory Box',
          albumTitle: undefined,
          coverUrl: undefined,
        },
      ],
    })
  })

  it('propagates a not-found error as SpotifyNotFoundError', async () => {
    const runner = errorRunner('Spotify embed page reports the entity is unavailable.', 2)
    await expect(getPlaylistTracks('missing-playlist', 500, runner)).rejects.toBeInstanceOf(
      SpotifyNotFoundError,
    )
  })
})
