// @vitest-environment node
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { extractDeezerPlaylistId, fetchDeezerPlaylistTracks } from '@/core/clients/deezer-playlist'

let server: http.Server
let baseUrl: string

const PLAYLIST_ID = '1234567890'

const fixtureResponse = {
  data: [
    {
      id: 1,
      title: 'Song A',
      artist: { id: 10, name: 'Artist Alpha' },
      album: { id: 100, title: 'Album Alpha' },
    },
    {
      id: 2,
      title: 'Song B',
      artist: { id: 20, name: 'Artist Beta' },
      album: { id: 200, title: 'Album Beta' },
    },
  ],
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url?.includes(`/playlist/${PLAYLIST_ID}/tracks`)) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(fixtureResponse))
      return
    }
    if (req.url?.includes(`/playlist/${PLAYLIST_ID}`)) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ title: 'My Deezer Mix' }))
      return
    }
    res.writeHead(404)
    res.end('{"error":"not found"}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${addr.port}`
})

afterAll(() => {
  server.close()
})

describe('extractDeezerPlaylistId', () => {
  it('extracts playlist ID from a full Deezer URL', () => {
    expect(extractDeezerPlaylistId(`https://www.deezer.com/en/playlist/${PLAYLIST_ID}`)).toBe(
      PLAYLIST_ID,
    )
  })

  it('extracts playlist ID from a deezer:// URI', () => {
    expect(extractDeezerPlaylistId(`deezer://playlist/${PLAYLIST_ID}`)).toBe(PLAYLIST_ID)
  })

  it('passes through a bare ID unchanged', () => {
    expect(extractDeezerPlaylistId(PLAYLIST_ID)).toBe(PLAYLIST_ID)
  })
})

describe('fetchDeezerPlaylistTracks', () => {
  it('needs no token -- fetches without any auth dependency', async () => {
    const { tracks } = await fetchDeezerPlaylistTracks(PLAYLIST_ID, baseUrl)
    expect(tracks).toHaveLength(2)
    expect(tracks[0]).toEqual({
      artistName: 'Artist Alpha',
      trackName: 'Song A',
      albumTitle: 'Album Alpha',
    })
  })

  it('also resolves the playlist title from the separate info endpoint', async () => {
    const { name } = await fetchDeezerPlaylistTracks(PLAYLIST_ID, baseUrl)
    expect(name).toBe('My Deezer Mix')
  })

  it('falls back to a null name if the info lookup fails, without failing the whole fetch', async () => {
    const infoFailServer = http.createServer((req, res) => {
      if (req.url?.includes(`/playlist/${PLAYLIST_ID}/tracks`)) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(fixtureResponse))
        return
      }
      res.writeHead(404)
      res.end('{"error":"not found"}')
    })
    await new Promise<void>((r) => infoFailServer.listen(0, '127.0.0.1', r))
    const addr = infoFailServer.address() as AddressInfo
    const infoFailBase = `http://127.0.0.1:${addr.port}`

    const { name, tracks } = await fetchDeezerPlaylistTracks(PLAYLIST_ID, infoFailBase)
    expect(name).toBeNull()
    expect(tracks).toHaveLength(2)

    infoFailServer.close()
  })

  it('handles empty tracks gracefully', async () => {
    const emptyServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: [] }))
    })
    await new Promise<void>((r) => emptyServer.listen(0, '127.0.0.1', r))
    const emptyAddr = emptyServer.address() as AddressInfo
    const emptyBase = `http://127.0.0.1:${emptyAddr.port}`

    const { tracks } = await fetchDeezerPlaylistTracks('anyid', emptyBase)
    expect(tracks).toHaveLength(0)

    emptyServer.close()
  })

  it('throws on non-200 response', async () => {
    const errServer = http.createServer((_req, res) => {
      res.writeHead(404)
      res.end('{"error":"not found"}')
    })
    await new Promise<void>((r) => errServer.listen(0, '127.0.0.1', r))
    const errAddr = errServer.address() as AddressInfo
    const errBase = `http://127.0.0.1:${errAddr.port}`

    await expect(fetchDeezerPlaylistTracks('anyid', errBase)).rejects.toThrow('404')

    errServer.close()
  })

  it('throws when Deezer returns a public error payload (e.g. private playlist)', async () => {
    const errServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'no data' } }))
    })
    await new Promise<void>((r) => errServer.listen(0, '127.0.0.1', r))
    const errAddr = errServer.address() as AddressInfo
    const errBase = `http://127.0.0.1:${errAddr.port}`

    await expect(fetchDeezerPlaylistTracks('anyid', errBase)).rejects.toThrow('no data')

    errServer.close()
  })
})
