// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { exportToJson } from '@/core/targets/export-json'
import type { ExportableRecommendation } from '@/core/targets/types'

const SAMPLE: ExportableRecommendation[] = [
  {
    artistName: 'Radiohead',
    artistMbid: 'a74b1b7f-71a5-4011-9441-d0b5e4122711',
    genres: ['alternative rock', 'art rock'],
    score: 0.92,
    status: 'pending',
    aiReasoning: 'Innovative electronic-influenced rock',
    imageUrl: 'https://example.com/rh.jpg',
    streamingUrls: { spotify: 'https://open.spotify.com/artist/abc' },
    createdAt: '2026-03-20T00:00:00Z',
  },
]

describe('exportToJson()', () => {
  it('returns valid JSON string', () => {
    const result = exportToJson(SAMPLE)
    const parsed = JSON.parse(result)
    expect(parsed).toHaveLength(1)
    expect(parsed[0].artistName).toBe('Radiohead')
  })

  it('includes all fields', () => {
    const result = exportToJson(SAMPLE)
    const parsed = JSON.parse(result)
    expect(parsed[0]).toHaveProperty('genres')
    expect(parsed[0]).toHaveProperty('score')
    expect(parsed[0]).toHaveProperty('streamingUrls')
  })

  it('returns empty array for no recommendations', () => {
    const result = exportToJson([])
    expect(JSON.parse(result)).toEqual([])
  })
})
