import PQueue from 'p-queue'
import { createHttpClient } from './http'

export type ListenBrainzRecording = {
  recordingMbid: string
  artistMbid: string
  artistName: string
  listenCount: number
}

type RadioResponse = Record<
  string,
  Array<{
    recording_mbid: string
    similar_artist_mbid: string
    similar_artist_name: string
    total_listen_count: number
  }>
>

/**
 * ListenBrainz's public artist-radio data: well-known recordings by artists
 * similar to a seed artist. Keyed by MusicBrainz artist ID; no account needed.
 */
export function createListenBrainzClient(baseUrl = 'https://api.listenbrainz.org') {
  const http = createHttpClient({ baseUrl, retries: 1, timeout: 15_000, publicIpOnly: true })
  // A shared public service -- keep it gentle.
  const queue = new PQueue({ concurrency: 2, interval: 1000, intervalCap: 2 })

  async function getSimilarArtistRecordings(
    artistMbid: string,
    maxArtists = 10,
  ): Promise<ListenBrainzRecording[]> {
    const qs = new URLSearchParams({
      mode: 'easy',
      max_similar_artists: String(maxArtists),
      max_recordings_per_artist: '1',
      // Upper popularity band: recognisable tracks make better entry points
      // to an album than deep cuts.
      pop_begin: '70',
      pop_end: '100',
    })
    const res = (await queue.add(() =>
      http.get<RadioResponse>(`/1/lb-radio/artist/${artistMbid}?${qs.toString()}`),
    )) as RadioResponse
    return Object.values(res ?? {})
      .flat()
      .filter((r) => r.similar_artist_mbid !== artistMbid)
      .map((r) => ({
        recordingMbid: r.recording_mbid,
        artistMbid: r.similar_artist_mbid,
        artistName: r.similar_artist_name,
        listenCount: r.total_listen_count,
      }))
  }

  return { getSimilarArtistRecordings }
}
