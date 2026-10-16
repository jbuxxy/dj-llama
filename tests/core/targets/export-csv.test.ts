// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { exportToCsv } from '@/core/targets/export-csv'
import type { ExportableRecommendation } from '@/core/targets/types'

const SAMPLE: ExportableRecommendation[] = [
  {
    artistName: 'Radiohead',
    artistMbid: 'a74b1b7f-71a5-4011-9441-d0b5e4122711',
    genres: ['alternative rock', 'art rock'],
    score: 0.92,
    status: 'pending',
    createdAt: '2026-03-20T00:00:00Z',
    streamingUrls: {},
  },
  {
    artistName: 'Bjork, The Great',
    artistMbid: 'mbid-bj',
    genres: ['electronic'],
    score: 0.85,
    status: 'approved',
    createdAt: '2026-03-20T01:00:00Z',
    streamingUrls: {},
  },
]

describe('exportToCsv()', () => {
  it('starts with a header row', () => {
    const result = exportToCsv(SAMPLE)
    const lines = result.split('\n')
    expect(lines[0]).toBe('artist,mbid,genres,score,status,date')
  })

  it('includes all rows', () => {
    const result = exportToCsv(SAMPLE)
    const lines = result.trim().split('\n')
    expect(lines).toHaveLength(3) // header + 2 rows
  })

  it('escapes commas in artist names', () => {
    const result = exportToCsv(SAMPLE)
    expect(result).toContain('"Bjork, The Great"')
  })

  it('joins genres with semicolons', () => {
    const result = exportToCsv(SAMPLE)
    expect(result).toContain('alternative rock;art rock')
  })

  it('returns only header for empty input', () => {
    const result = exportToCsv([])
    expect(result.trim()).toBe('artist,mbid,genres,score,status,date')
  })
})
