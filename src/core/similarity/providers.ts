import { createLastFmClient } from '@/core/clients/lastfm'
import { createListenBrainzClient } from '@/core/clients/listenbrainz'

/** A track the listener likes or plays a lot, used to look up similar tracks. */
export type SeedTrack = { artistName: string; trackName: string; artistMbid?: string }

/** A similar track; its album is what ends up recommended. */
export type SimilarTrack = {
  artistName: string
  /** Empty when only the recording MBID is known (resolved via MusicBrainz). */
  trackName: string
  recordingMbid?: string
  similarityScore: number
}

export interface SimilarTrackProvider {
  id: 'listenbrainz' | 'lastfm'
  name: string
  /** ListenBrainz works from the seed's artist MBID; Last.fm from the track itself. */
  requiresArtistMbid: boolean
  getSimilarTracks(seed: SeedTrack): Promise<SimilarTrack[]>
}

const sameArtist = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

export function createListenBrainzProvider(
  client: Pick<
    ReturnType<typeof createListenBrainzClient>,
    'getSimilarArtistRecordings'
  > = createListenBrainzClient(),
): SimilarTrackProvider {
  return {
    id: 'listenbrainz',
    name: 'ListenBrainz',
    requiresArtistMbid: true,
    async getSimilarTracks(seed) {
      if (!seed.artistMbid) return []
      const recordings = await client.getSimilarArtistRecordings(seed.artistMbid)
      // Radio data has no similarity score; rank order is the closest signal.
      return recordings.map((r, i) => ({
        artistName: r.artistName,
        trackName: '',
        recordingMbid: r.recordingMbid,
        similarityScore: Math.max(0.4, 0.8 - i * 0.04),
      }))
    },
  }
}

export function createLastFmProvider(
  client: Pick<ReturnType<typeof createLastFmClient>, 'getSimilarTracks'>,
): SimilarTrackProvider {
  return {
    id: 'lastfm',
    name: 'Last.fm',
    requiresArtistMbid: false,
    async getSimilarTracks(seed) {
      const similar = await client.getSimilarTracks(seed.artistName, seed.trackName)
      return (
        similar
          // Same-artist tracks mostly point back at albums already owned; the
          // gap-fill branch covers an owned artist's missing albums.
          .filter((t) => !sameArtist(t.artistName, seed.artistName))
          .map((t) => ({
            artistName: t.artistName,
            trackName: t.trackName,
            recordingMbid: t.mbid,
            similarityScore: t.match,
          }))
      )
    },
  }
}

/** ListenBrainz always; Last.fm when an API key is configured. */
export function buildSimilarityProviders(lastfmApiKey: string | null | undefined) {
  const providers: SimilarTrackProvider[] = [createListenBrainzProvider()]
  if (lastfmApiKey) providers.push(createLastFmProvider(createLastFmClient(lastfmApiKey)))
  return providers
}
