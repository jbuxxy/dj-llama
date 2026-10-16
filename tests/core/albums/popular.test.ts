import { describe, expect, it } from 'vitest'
import { selectPopularReleaseGroups } from '@/core/albums/popular'

describe('selectPopularReleaseGroups', () => {
  it('maps Spotify album popularity to the top three MusicBrainz album release groups', () => {
    const selected = selectPopularReleaseGroups(
      [
        { title: 'Third', releaseDate: '2008-04-28', popularity: 82 },
        { title: 'Dummy', releaseDate: '1994-08-22', popularity: 78 },
        { title: 'Portishead', releaseDate: '1997-09-29', popularity: 75 },
        { title: 'A Single', releaseDate: '1997-01-01', popularity: 99 },
      ],
      [
        { id: 'rg-dummy', title: 'Dummy', type: 'Album', firstReleaseDate: '1994-08-22' },
        { id: 'rg-portishead', title: 'Portishead', type: 'Album', firstReleaseDate: '1997-09-29' },
        { id: 'rg-third', title: 'Third', type: 'Album', firstReleaseDate: '2008-04-28' },
        { id: 'rg-single', title: 'A Single', type: 'Single', firstReleaseDate: '1997-01-01' },
      ],
      3,
    )

    expect(selected.map((album) => album.id)).toEqual(['rg-third', 'rg-dummy', 'rg-portishead'])
  })

  it('skips ambiguous MusicBrainz title matches instead of choosing the wrong release group', () => {
    const selected = selectPopularReleaseGroups(
      [
        { title: 'Self Titled', releaseDate: '2020-01-01', popularity: 95 },
        { title: 'Clear Match', releaseDate: '2021-01-01', popularity: 80 },
      ],
      [
        { id: 'rg-a', title: 'Self Titled', type: 'Album', firstReleaseDate: '2019-01-01' },
        { id: 'rg-b', title: 'Self Titled', type: 'Album', firstReleaseDate: '2020-01-01' },
        { id: 'rg-clear', title: 'Clear Match', type: 'Album', firstReleaseDate: '2021-01-01' },
      ],
      3,
    )

    expect(selected.map((album) => album.id)).toEqual(['rg-clear'])
  })
})
