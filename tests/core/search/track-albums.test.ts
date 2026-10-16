import { describe, expect, it, vi } from 'vitest'
import type { MBReleaseGroup } from '@/core/clients/musicbrainz'
import {
  isSameArtist,
  isSameSong,
  rankSongs,
  searchTrackAlbums,
  type TrackAlbumSearchClient,
} from '@/core/search/track-albums'

const MISSY = 'a0b8cb9e-7532-45fe-a74c-30e7c4009a39'

const rg = (
  id: string,
  title: string,
  type: string,
  firstReleaseDate?: string,
  secondaryTypes?: string[],
): MBReleaseGroup => ({ id, title, type, firstReleaseDate, secondaryTypes })

const recording = (
  title: string,
  releaseGroups: MBReleaseGroup[],
  recordingDisambiguation?: string,
) => ({
  recordingMbid: `rec-${title}-${releaseGroups[0]?.id ?? 'none'}`,
  recordingTitle: title,
  recordingDisambiguation,
  releaseGroups,
})

function makeClient(overrides: Partial<TrackAlbumSearchClient> = {}): TrackAlbumSearchClient {
  return {
    searchRecordingsFreeText: vi.fn(async () => []),
    getReleaseGroups: vi.fn(async () => []),
    searchArtistRecordingReleaseGroups: vi.fn(async () => ({ total: 0, recordings: [] })),
    ...overrides,
  }
}

describe('isSameSong', () => {
  it('ignores a trailing subtitle but not a different version', () => {
    expect(isSameSong('Mambo No.5 (A Little bit Of…)', 'Mambo No. 5')).toBe(true)
    expect(isSameSong('Get Ur Freak On', 'Get Ur Freak On')).toBe(true)
    expect(
      isSameSong("Get Ur Freak On (Superchumbo's Superfreakon Remix)", 'Get Ur Freak On'),
    ).toBe(false)
    expect(isSameSong('Wonderwall (Live)', 'Wonderwall')).toBe(false)
    expect(isSameSong('Mambo Mambo', 'Mambo No. 5')).toBe(false)
  })
})

describe('isSameSong word matching', () => {
  it('matches reordered titles sharing all their words', () => {
    expect(isSameSong('Day-O (The Banana Boat Song)', 'Banana Boat (Day-O)')).toBe(true)
  })

  it('does not match a title sharing only one distinct word', () => {
    expect(isSameSong('Mambo Mambo', 'Mambo No. 5')).toBe(false)
    expect(isSameSong('Main Titles', 'Wednesday Main Titles')).toBe(false)
    expect(isSameSong('Wednesday End Titles', 'Wednesday Main Titles')).toBe(false)
  })
})

describe('isSameArtist', () => {
  it('ignores punctuation and accepts a fuller billing', () => {
    expect(isSameArtist('Bobby “Boris” Pickett', 'Bobby "Boris" Pickett')).toBe(true)
    expect(
      isSameArtist('Bobby “Boris” Pickett and the Crypt‐Kickers', 'Bobby "Boris" Pickett'),
    ).toBe(true)
    expect(isSameArtist('allSTARS*', 'allSTARS')).toBe(true)
    expect(isSameArtist('Nirvana', 'The Flying Pickets')).toBe(false)
  })
})

describe('rankSongs', () => {
  it('prefers the song covering more of the query over a more frequent partial match', () => {
    const lou = { artistMbid: 'lou', artistName: 'Lou Bega' }
    const songs = rankSongs('Mambo No. 5 Lou Bega', [
      { ...lou, title: 'Mambo Mambo' },
      { ...lou, title: 'Mambo Mambo' },
      { ...lou, title: 'Mambo No 5' },
    ])
    expect(songs[0]?.title).toBe('Mambo No 5')
  })

  it('breaks ties by hit count, so a famous original beats covers listed first', () => {
    const songs = rankSongs('Smells Like Teen Spirit', [
      { title: 'Smells Like Teen Spirit', artistMbid: 'pickets', artistName: 'The Flying Pickets' },
      { title: 'Smells Like Teen Spirit', artistMbid: 'nirvana', artistName: 'Nirvana' },
      { title: 'Smells Like Teen Spirit', artistMbid: 'nirvana', artistName: 'Nirvana' },
      { title: 'Smells Like Teen Spirit', artistMbid: 'nirvana', artistName: 'Nirvana' },
    ])
    expect(songs.map((s) => s.artistName)).toEqual(['Nirvana', 'The Flying Pickets'])
  })

  it('searches a song by its bare title, not a subtitled first hit', () => {
    const songs = rankSongs('Kiss Me', [
      { title: 'Kiss Me (Japanese version)', artistMbid: 'sixpence', artistName: 'Sixpence' },
      { title: 'Kiss Me', artistMbid: 'sixpence', artistName: 'Sixpence' },
    ])
    expect(songs).toEqual([{ title: 'Kiss Me', artistMbid: 'sixpence', artistName: 'Sixpence' }])
  })
})

describe('searchTrackAlbums', () => {
  it('finds the studio album through the studio-only search, ahead of compilations and singles', async () => {
    const album = rg('album', 'Miss E …So Addictive', 'Album', '2001')
    const client = makeClient({
      searchRecordingsFreeText: vi.fn(async () => [
        {
          id: 'r1',
          title: 'Get Ur Freak On',
          score: 100,
          artistMbid: MISSY,
          artistName: 'Missy Elliott',
        },
      ]),
      getReleaseGroups: vi.fn(async () => [album, rg('other', 'Da Real World', 'Album', '1999')]),
      searchArtistRecordingReleaseGroups: vi.fn(async (_title, _artist, options) =>
        options?.releaseGroupIds
          ? {
              total: 1,
              recordings: [
                recording('Get Ur Freak On', [
                  album,
                  rg('single', 'Get Ur Freak On', 'Single', '2001'),
                  rg('comp', 'Respect M.E.', 'Album', '2006-09-04', ['Compilation']),
                ]),
              ],
            }
          : { total: 0, recordings: [] },
      ),
    })

    const results = await searchTrackAlbums(client, 'Missy Elliott Get Ur Freak On')

    expect(results.map((r) => r.albumTitle)).toEqual([
      'Miss E …So Addictive',
      'Respect M.E.',
      'Get Ur Freak On',
    ])
    expect(results[0]).toMatchObject({ trackName: 'Get Ur Freak On', artistName: 'Missy Elliott' })
    expect(client.searchArtistRecordingReleaseGroups).toHaveBeenCalledWith(
      'Get Ur Freak On',
      MISSY,
      { releaseGroupIds: ['album', 'other'] },
    )
    // Found on a studio album, so no general fallback search.
    expect(client.searchArtistRecordingReleaseGroups).toHaveBeenCalledTimes(1)
  })

  it('skips live and differently-titled copies before they can claim an album', async () => {
    const nevermind = rg('nevermind', 'Nevermind', 'Album', '1991')
    const inUtero = rg('in-utero', 'In Utero', 'Album', '1993')
    const client = makeClient({
      searchRecordingsFreeText: vi.fn(async () => [
        {
          id: 'r1',
          title: 'Smells Like Teen Spirit',
          score: 100,
          artistMbid: 'nirvana',
          artistName: 'Nirvana',
        },
      ]),
      getReleaseGroups: vi.fn(async () => [nevermind, inUtero]),
      searchArtistRecordingReleaseGroups: vi.fn(async () => ({
        total: 3,
        recordings: [
          recording('Smells Like Teen Spirit', [inUtero], 'live, 1993-12-13'),
          recording('Smells Like Teen Spirit (Butch Vig mix)', [nevermind]),
          recording('Smells Like Teen Spirit', [nevermind]),
        ],
      })),
    })

    const results = await searchTrackAlbums(client, 'Smells Like Teen Spirit')

    expect(results.map((r) => r.albumTitle)).toEqual(['Nevermind'])
    expect(results[0]?.recordingMbid).toBe('rec-Smells Like Teen Spirit-nevermind')
  })

  it('falls back to everywhere the song appears when no studio album has it', async () => {
    const client = makeClient({
      searchRecordingsFreeText: vi.fn(async () => [
        {
          id: 'r1',
          title: 'Danger Zone',
          score: 100,
          artistMbid: 'kenny',
          artistName: 'Kenny Loggins',
        },
      ]),
      getReleaseGroups: vi.fn(async () => [rg('footloose', 'Footloose', 'Album', '1984')]),
      searchArtistRecordingReleaseGroups: vi.fn(async (_title, _artist, options) =>
        options?.releaseGroupIds
          ? { total: 0, recordings: [] }
          : {
              total: 1,
              recordings: [
                recording('Danger Zone', [
                  rg('hits', 'The Essential Kenny Loggins', 'Album', '2002', ['Compilation']),
                ]),
              ],
            },
      ),
    })

    const results = await searchTrackAlbums(client, 'kenny loggins danger zone')

    expect(results.map((r) => r.albumTitle)).toEqual(['The Essential Kenny Loggins'])
    expect(client.searchArtistRecordingReleaseGroups).toHaveBeenCalledTimes(2)
  })

  it('propagates a MusicBrainz failure instead of reporting no matches', async () => {
    const client = makeClient({
      searchRecordingsFreeText: vi.fn(async () => {
        throw new Error('MusicBrainz 503')
      }),
    })

    await expect(searchTrackAlbums(client, 'Toxic')).rejects.toThrow('MusicBrainz 503')
  })
})
