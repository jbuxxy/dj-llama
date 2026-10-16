// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { exportToXspf } from '@/core/targets/export-xspf'
import type { ExportableRecommendation } from '@/core/targets/types'

const SAMPLE: ExportableRecommendation[] = [
  {
    artistName: 'Radiohead',
    artistMbid: 'a74b1b7f-71a5-4011-9441-d0b5e4122711',
    genres: ['alternative rock', 'art rock'],
    score: 0.92,
    status: 'approved',
    aiReasoning: 'Innovative electronic-influenced rock with complex arrangements',
    imageUrl: 'https://example.com/rh.jpg',
    streamingUrls: { spotify: 'https://open.spotify.com/artist/abc' },
    createdAt: '2026-03-20T00:00:00Z',
    suggestedAlbum: 'OK Computer',
  },
  {
    artistName: 'Bjork & Friends',
    artistMbid: 'mbid-bj',
    genres: ['electronic', 'experimental'],
    score: 0.85,
    status: 'pending',
    streamingUrls: {},
    createdAt: '2026-03-20T01:00:00Z',
  },
]

describe('exportToXspf()', () => {
  it('returns valid XML with XSPF namespace', () => {
    const result = exportToXspf(SAMPLE)
    expect(result).toContain('<?xml version="1.0" encoding="UTF-8"?>')
    expect(result).toContain('xmlns="http://xspf.org/ns/0/"')
  })

  it('includes playlist title', () => {
    const result = exportToXspf(SAMPLE, { title: 'DJ Llama Discoveries' })
    expect(result).toContain('<title>DJ Llama Discoveries</title>')
  })

  it('includes track entries for each recommendation', () => {
    const result = exportToXspf(SAMPLE)
    expect(result).toContain('<creator>Radiohead</creator>')
    expect(result).toContain('<creator>Bjork &amp; Friends</creator>')
  })

  it('escapes XML special characters', () => {
    const result = exportToXspf(SAMPLE)
    expect(result).toContain('Bjork &amp; Friends')
    expect(result).not.toContain('Bjork & Friends')
  })

  it('includes annotation with AI reasoning when available', () => {
    const result = exportToXspf(SAMPLE)
    expect(result).toContain('<annotation>Innovative electronic-influenced rock')
  })

  it('includes image URL when available', () => {
    const result = exportToXspf(SAMPLE)
    expect(result).toContain('<image>https://example.com/rh.jpg</image>')
  })

  it('uses streaming URL as location when available', () => {
    const result = exportToXspf(SAMPLE)
    expect(result).toContain('<location>https://open.spotify.com/artist/abc</location>')
  })

  it('falls back to MusicBrainz URL when no streaming URL', () => {
    const result = exportToXspf(SAMPLE)
    expect(result).toContain('<location>https://musicbrainz.org/artist/mbid-bj</location>')
  })

  it('returns valid XSPF for empty input', () => {
    const result = exportToXspf([])
    expect(result).toContain('<trackList/>')
  })

  it('includes suggested album as album element', () => {
    const result = exportToXspf(SAMPLE)
    expect(result).toContain('<album>OK Computer</album>')
  })
})
