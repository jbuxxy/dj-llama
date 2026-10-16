// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { exportToM3u } from '@/core/targets/export-m3u'
import type { ExportableRecommendation } from '@/core/targets/types'

const SAMPLE: ExportableRecommendation[] = [
  {
    artistName: 'Radiohead',
    artistMbid: 'mbid-rh',
    genres: ['rock'],
    score: 0.92,
    status: 'approved',
    createdAt: '2026-03-20T00:00:00Z',
    streamingUrls: { spotify: 'https://open.spotify.com/artist/abc' },
  },
  {
    artistName: 'Bjork',
    artistMbid: 'mbid-bj',
    genres: ['electronic'],
    score: 0.85,
    status: 'approved',
    createdAt: '2026-03-20T01:00:00Z',
    streamingUrls: {},
  },
]

describe('exportToM3u()', () => {
  it('starts with #EXTM3U header', () => {
    const result = exportToM3u(SAMPLE)
    expect(result.startsWith('#EXTM3U')).toBe(true)
  })

  it('includes EXTINF lines with artist names', () => {
    const result = exportToM3u(SAMPLE)
    expect(result).toContain('#EXTINF:-1,Radiohead')
    expect(result).toContain('#EXTINF:-1,Bjork')
  })

  it('uses spotify URL when available', () => {
    const result = exportToM3u(SAMPLE)
    expect(result).toContain('https://open.spotify.com/artist/abc')
  })

  it('uses musicbrainz URL as fallback', () => {
    const result = exportToM3u(SAMPLE)
    expect(result).toContain('https://musicbrainz.org/artist/mbid-bj')
  })

  it('returns only header for empty input', () => {
    const result = exportToM3u([])
    expect(result.trim()).toBe('#EXTM3U')
  })
})
