import PQueue from 'p-queue'
import type { ServiceTestResult } from '@/core/types'
import { errMsg } from '@/core/validation'
import { createHttpClient } from './http'

export type LastFmSimilarArtist = { name: string; mbid?: string; match: number }
export type LastFmTrack = { artistName: string; trackName: string; mbid?: string; match: number }

type LfmResponse<T> = T & { error?: number; message?: string }
type LfmSimilarArtistsResponse = LfmResponse<{
  similarartists?: { artist?: Array<{ name: string; match: string; mbid?: string }> }
}>
type LfmTrack = { name: string; mbid?: string; match?: number | string; artist: { name: string } }
type LfmSimilarTracksResponse = LfmResponse<{ similartracks?: { track?: LfmTrack[] } }>
type LfmTopTracksResponse = LfmResponse<{ toptracks?: { track?: LfmTrack[] } }>

function toTrack(t: LfmTrack): LastFmTrack {
  return {
    artistName: t.artist.name,
    trackName: t.name,
    mbid: t.mbid || undefined,
    match: Number(t.match ?? 0) || 0,
  }
}

/**
 * Last.fm's similar-artists data. Only needs an API key -- no Last.fm account
 * or listening history is involved.
 */
export function createLastFmClient(apiKey: string, baseUrl = 'https://ws.audioscrobbler.com/2.0/') {
  const http = createHttpClient({ baseUrl, retries: 1, timeout: 10_000, publicIpOnly: true })
  // Last.fm asks clients to stay under 5 requests/second.
  const queue = new PQueue({ concurrency: 4, interval: 1000, intervalCap: 4 })

  async function call<T>(params: Record<string, string>): Promise<LfmResponse<T>> {
    const qs = new URLSearchParams({ ...params, api_key: apiKey, format: 'json' })
    const res = (await queue.add(() =>
      http.get<LfmResponse<T>>(`?${qs.toString()}`),
    )) as LfmResponse<T>
    if (res.error) throw new Error(`Last.fm error ${res.error}: ${res.message ?? 'unknown'}`)
    return res
  }

  async function getSimilarArtists(
    artist: string,
    mbid?: string,
    limit = 25,
  ): Promise<LastFmSimilarArtist[]> {
    const base = { method: 'artist.getsimilar', limit: String(limit), autocorrect: '1' }
    let res: LfmSimilarArtistsResponse
    try {
      res = await call(mbid ? { ...base, mbid } : { ...base, artist })
    } catch (err) {
      // Last.fm doesn't know every MBID; the name usually still resolves.
      if (!mbid) throw err
      res = await call({ ...base, artist })
    }
    return (res.similarartists?.artist ?? []).map((a) => ({
      name: a.name,
      mbid: a.mbid || undefined,
      match: Number.parseFloat(a.match) || 0,
    }))
  }

  /** Tracks Last.fm listeners play alongside this one, most similar first. */
  async function getSimilarTracks(
    artist: string,
    track: string,
    limit = 15,
  ): Promise<LastFmTrack[]> {
    const res = await call<LfmSimilarTracksResponse>({
      method: 'track.getsimilar',
      artist,
      track,
      limit: String(limit),
      autocorrect: '1',
    })
    return (res.similartracks?.track ?? []).map(toTrack)
  }

  /** An artist's most-played tracks on Last.fm. */
  async function getTopTracks(artist: string, mbid?: string, limit = 3): Promise<LastFmTrack[]> {
    const base = { method: 'artist.gettoptracks', limit: String(limit), autocorrect: '1' }
    let res: LfmTopTracksResponse
    try {
      res = await call(mbid ? { ...base, mbid } : { ...base, artist })
    } catch (err) {
      if (!mbid) throw err
      res = await call({ ...base, artist })
    }
    return (res.toptracks?.track ?? []).map(toTrack)
  }

  async function testConnection(): Promise<ServiceTestResult> {
    try {
      const similar = await getSimilarArtists('Radiohead', undefined, 5)
      return {
        success: true,
        message: `Last.fm key works (${similar.length} similar artists for a test lookup)`,
      }
    } catch (err: unknown) {
      return { success: false, message: errMsg(err) }
    }
  }

  return { getSimilarArtists, getSimilarTracks, getTopTracks, testConnection }
}
