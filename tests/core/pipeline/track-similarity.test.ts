// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import {
  artistPicksToTracks,
  capSimilarTracks,
  type DiscoveredTrack,
  discoverSimilarTracks,
} from '@/core/pipeline/discover-tracks'
import { resolveTrackToAlbum } from '@/core/pipeline/resolve'
import {
  createLastFmProvider,
  createListenBrainzProvider,
  type SimilarTrackProvider,
} from '@/core/similarity/providers'
import type { TrackTasteProfile, TrackTasteSignal } from '@/core/types'

const signal = (artistName: string, trackName: string, weight = 1): TrackTasteSignal => ({
  artistName,
  trackName,
  weight,
  signalType: 'liked',
  source: 'plex',
})

const profile = (signals: TrackTasteSignal[]): TrackTasteProfile => ({
  signals,
  topArtists: [],
  topGenres: [],
  listeningPatterns: { totalListens: 0, recentTrend: 'stable' },
})

function provider(
  id: 'listenbrainz' | 'lastfm',
  requiresArtistMbid: boolean,
  impl: SimilarTrackProvider['getSimilarTracks'],
): SimilarTrackProvider {
  return { id, name: id, requiresArtistMbid, getSimilarTracks: vi.fn(impl) }
}

describe('discoverSimilarTracks with similar-track providers', () => {
  it('asks Last.fm per seed track and explains each pick by the seed it came from', async () => {
    const lfm = provider('lastfm', false, async () => [
      {
        artistName: 'Portishead',
        trackName: 'Glory Box',
        recordingMbid: 'rec-gb',
        similarityScore: 0.9,
      },
    ])
    const out = await discoverSimilarTracks(
      profile([signal('Massive Attack', 'Teardrop'), signal('Massive Attack', 'Angel')]),
      { similar: [lfm] },
    )
    expect(lfm.getSimilarTracks).toHaveBeenCalledTimes(2)
    expect(out[0]).toMatchObject({
      artistName: 'Portishead',
      trackName: 'Glory Box',
      recordingMbid: 'rec-gb',
      source: 'lastfm',
      aiReasoning: 'Similar to "Teardrop" by Massive Attack, which you liked.',
    })
  })

  it('asks ListenBrainz once per seed artist, using the MBID from the library', async () => {
    const lb = provider('listenbrainz', true, async () => [])
    await discoverSimilarTracks(
      profile([
        signal('Massive Attack', 'Teardrop'),
        signal('Massive Attack', 'Angel'),
        signal('Unknown Band', 'Song'),
      ]),
      { similar: [lb] },
      { libraryArtists: [{ name: 'Massive Attack', mbid: 'mbid-ma' }] },
    )
    expect(lb.getSimilarTracks).toHaveBeenCalledTimes(1)
    expect(lb.getSimilarTracks).toHaveBeenCalledWith({
      artistName: 'Massive Attack',
      trackName: 'Teardrop',
      artistMbid: 'mbid-ma',
    })
  })

  it('reports a failing provider with its error, not as empty', async () => {
    const lfm = provider('lastfm', false, async () => {
      throw new Error('Last.fm error 10: Invalid API key')
    })
    const events: string[] = []
    await discoverSimilarTracks(
      profile([signal('A', 'x')]),
      { similar: [lfm] },
      {
        onSourceFailure: (id, err) => events.push(`fail:${id}:${err}`),
        onSourceResults: (id, n) => events.push(`count:${id}:${n}`),
      },
    )
    expect(events).toEqual(['fail:lastfm:Last.fm error 10: Invalid API key', 'count:lastfm:0'])
  })

  it('weights candidates by how much the seed is liked', async () => {
    const lfm = provider('lastfm', false, async () => [
      { artistName: 'B', trackName: 'y', similarityScore: 1 },
    ])
    const [out] = await discoverSimilarTracks(profile([signal('A', 'x', 0.5)]), { similar: [lfm] })
    expect(out?.similarityScore).toBe(0.5)
  })
})

describe('capSimilarTracks', () => {
  const t = (name: string, score: number, source = 'lastfm', mbid?: string) =>
    ({
      artistName: 'X',
      trackName: name,
      recordingMbid: mbid,
      similarityScore: score,
      source,
    }) as DiscoveredTrack

  it('ranks tracks several seeds or providers agree on first, keeping every entry', () => {
    const kept = capSimilarTracks(
      [
        t('Shared', 0.5, 'lastfm', 'r1'),
        t('Shared', 0.5, 'listenbrainz', 'r1'),
        t('Solo', 0.8),
        t('Weak', 0.1),
      ],
      2,
    )
    expect(kept.map((k) => `${k.trackName}/${k.source}`)).toEqual([
      'Shared/lastfm',
      'Shared/listenbrainz',
      'Solo/lastfm',
    ])
  })
})

describe('similar-track providers', () => {
  it('Last.fm drops same-artist tracks', async () => {
    const lfm = createLastFmProvider({
      getSimilarTracks: vi.fn().mockResolvedValue([
        { artistName: 'Radiohead', trackName: 'No Surprises', match: 1 },
        { artistName: 'Muse', trackName: 'Unintended', mbid: 'rec-u', match: 0.6 },
      ]),
    })
    const out = await lfm.getSimilarTracks({ artistName: 'radiohead', trackName: 'Creep' })
    expect(out).toEqual([
      { artistName: 'Muse', trackName: 'Unintended', recordingMbid: 'rec-u', similarityScore: 0.6 },
    ])
  })

  it('ListenBrainz needs an artist MBID and ranks by order', async () => {
    const lb = createListenBrainzProvider({
      getSimilarArtistRecordings: vi.fn().mockResolvedValue([
        { recordingMbid: 'r1', artistMbid: 'a1', artistName: 'Pixies', listenCount: 10 },
        { recordingMbid: 'r2', artistMbid: 'a2', artistName: 'Weezer', listenCount: 5 },
      ]),
    })
    expect(await lb.getSimilarTracks({ artistName: 'X', trackName: 'y' })).toEqual([])
    const out = await lb.getSimilarTracks({ artistName: 'X', trackName: 'y', artistMbid: 'm' })
    expect(out.map((o) => [o.recordingMbid, o.trackName, o.similarityScore])).toEqual([
      ['r1', '', 0.8],
      ['r2', '', 0.76],
    ])
  })
})

function trackMb(overrides: Record<string, unknown> = {}) {
  return {
    lookupRecordingWithReleaseGroups: vi.fn().mockResolvedValue(null),
    searchRecording: vi.fn().mockResolvedValue(null),
    lookupArtist: vi
      .fn()
      .mockResolvedValue({ id: 'art-rh', name: 'Radiohead', tags: [], relations: [] }),
    extractStreamingUrls: vi.fn().mockReturnValue({}),
    ...overrides,
  }
}

describe('resolveTrackToAlbum', () => {
  it('does not title-search a recording-MBID-only candidate whose lookup failed', async () => {
    const mb = trackMb()
    const out = await resolveTrackToAlbum(
      {
        artistName: 'Radiohead',
        trackName: '',
        recordingMbid: 'rec-x',
        similarityScore: 0.7,
        source: 'listenbrainz',
      },
      mb,
    )
    expect(out).toBeNull()
    expect(mb.searchRecording).not.toHaveBeenCalled()
  })
})

describe('artistPicksToTracks', () => {
  const pick = (name: string, trackName?: string) => ({
    name,
    trackName,
    similarityScore: 0.8,
    aiReasoning: `why ${name}`,
    source: 'ai',
  })

  it("uses the AI's named starting track", async () => {
    const topTracks = vi.fn()
    const out = await artistPicksToTracks([pick('Grouper', 'Heavy Water')], topTracks)
    expect(out).toEqual([
      expect.objectContaining({
        artistName: 'Grouper',
        trackName: 'Heavy Water',
        aiReasoning: 'why Grouper',
      }),
    ])
    expect(topTracks).not.toHaveBeenCalled()
  })

  it("falls back to the artist's top Last.fm track", async () => {
    const out = await artistPicksToTracks([pick('Grouper')], async () => [
      { trackName: 'Alien Observer', mbid: 'rec-ao' },
    ])
    expect(out[0]).toMatchObject({ trackName: 'Alien Observer', recordingMbid: 'rec-ao' })
  })

  it('drops a pick with no way to name a track', async () => {
    expect(await artistPicksToTracks([pick('Grouper')], null)).toEqual([])
    expect(
      await artistPicksToTracks([pick('Grouper')], async () => {
        throw new Error('down')
      }),
    ).toEqual([])
  })
})
