import { describe, expect, it } from 'vitest'
import { generateSeasonalTracks } from '@/core/playlists/seasonal-generator'
import { getSeasonalPreset } from '@/core/playlists/seasonal-presets'
import type { LocalTrack } from '@/core/playlists/types'

function preset(key: string) {
  const found = getSeasonalPreset(key)
  if (!found) throw new Error(`missing preset ${key}`)
  return found
}

const halloween = preset('halloween')
const christmas = preset('christmas')

function track(artist: string, name: string, extra: Partial<LocalTrack> = {}): LocalTrack {
  return { artist, name, path: `/music/${artist}/(2000) Album/${name}.mp3`, ...extra }
}

function libraryDeps(library: LocalTrack[]) {
  return {
    getArtistTracks: async (artist: string) =>
      library.filter((t) => t.artist.toLowerCase() === artist.toLowerCase()),
    searchByTitle: async (q: string) =>
      library.filter((t) => t.name.toLowerCase().includes(q.toLowerCase())),
    getLibraryArtistKeys: async () =>
      new Set(library.map((t) => t.artist.toLowerCase().replace(/^the /, ''))),
    fetchOnlineSongs: async () => [],
  }
}

describe('generateSeasonalTracks', () => {
  it('finds built-in classics by owned artists and seasonal titles, skipping ordinary songs', async () => {
    const library = [
      track('Michael Jackson', 'Thriller'),
      track('Michael Jackson', 'Billie Jean'),
      track('Noah Kahan', 'Halloween'),
      track('Sublime', 'Wrong Way'),
    ]
    const { tracks } = await generateSeasonalTracks(libraryDeps(library), {
      preset: halloween,
      size: 25,
    })
    const names = tracks.map((t) => t.trackName).sort()
    expect(names).toEqual(['Halloween', 'Thriller'])
  })

  it('matches title keywords as whole words only', async () => {
    const library = [
      track('Lana Del Rey', 'Hollywood'),
      track('Mariah Carey', 'All I Want for Christmas Is You'),
    ]
    const { tracks } = await generateSeasonalTracks(libraryDeps(library), {
      preset: christmas,
      size: 25,
    })
    expect(tracks.map((t) => t.trackName)).toEqual(['All I Want for Christmas Is You'])
  })

  it('never re-adds removed songs and always keeps added ones', async () => {
    const library = [track('Michael Jackson', 'Thriller'), track('Ray Parker Jr.', 'Ghostbusters')]
    const { tracks, candidates } = await generateSeasonalTracks(libraryDeps(library), {
      preset: halloween,
      size: 25,
      excluded: [{ artistName: 'Michael Jackson', trackName: 'Thriller' }],
      pinned: [{ artistName: 'Sublime', trackName: 'Wrong Way', localPath: '/x.mp3' }],
    })
    const names = tracks.map((t) => t.trackName).sort()
    expect(names).toEqual(['Ghostbusters', 'Wrong Way'])
    expect(candidates.some((c) => c.trackName === 'Thriller')).toBe(false)
  })

  it('caps songs per artist and keeps the rest as replacement candidates', async () => {
    const library = ['Ghost', 'Ghost Town', 'Ghosts', 'Haunted'].map((n) => track('Band', n))
    const { tracks, candidates } = await generateSeasonalTracks(libraryDeps(library), {
      preset: halloween,
      size: 25,
    })
    expect(tracks).toHaveLength(2)
    expect(candidates).toHaveLength(2)
  })

  it('skips live and karaoke versions', async () => {
    const library = [
      { ...track('Michael Jackson', 'Thriller'), path: '/music/MJ/Live in Bucharest/Thriller.mp3' },
      track('Someone', 'Monster Mash (Karaoke)'),
    ]
    const { tracks } = await generateSeasonalTracks(libraryDeps(library), {
      preset: halloween,
      size: 25,
    })
    expect(tracks).toHaveLength(0)
  })

  it('limits genre-only filler to a share of the playlist', async () => {
    const library = Array.from({ length: 20 }, (_, i) => track(`Goth ${i}`, `Song ${i}`))
    const deps = {
      ...libraryDeps(library),
      getTasteArtists: async () =>
        library.map((t) => ({ name: t.artist, score: 1, genres: ['darkwave'] })),
    }
    const { tracks } = await generateSeasonalTracks(deps, { preset: halloween, size: 20 })
    expect(tracks).toHaveLength(8)
  })
})
