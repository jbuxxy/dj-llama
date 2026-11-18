import { describe, expect, it } from 'vitest'
import {
  EmbeddingIndex,
  embeddingKey,
  embeddingModelFor,
  embeddingText,
  hashText,
  normalize,
} from '@/core/embeddings'
import { project } from '@/core/embeddings/service'

const entry = (key: string, name = key) => ({ key, name, mbid: null })

describe('embedding index', () => {
  const index = new EmbeddingIndex(
    'm',
    [entry('a'), entry('b'), entry('c')],
    [normalize([1, 0, 0]), normalize([0.9, 0.1, 0]), normalize([0, 0, 1])],
  )

  it('returns nearest neighbors by cosine, best first', () => {
    const hits = index.nearest(normalize([1, 0, 0]), 2)
    expect(hits.map((h) => h.key)).toEqual(['a', 'b'])
    expect(hits[0]?.score).toBeCloseTo(1)
  })

  it('applies the filter and finds the best match within a key set', () => {
    expect(index.nearest(normalize([1, 0, 0]), 1, (e) => e.key !== 'a')[0]?.key).toBe('b')
    expect(index.maxSimilarity(normalize([0, 0, 1]), new Set(['a', 'c']))).toBeCloseTo(1)
    expect(index.maxSimilarity(normalize([0, 0, 1]), new Set(['missing']))).toBeNull()
  })

  it('ignores queries of the wrong dimension', () => {
    expect(index.nearest([1, 0], 3)).toEqual([])
  })
})

describe('embedding text and keys', () => {
  const source = {
    name: 'Grouper',
    mbid: '11111111-1111-1111-1111-111111111111',
    genres: ['Ambient', 'ambient', 'Drone'],
    tags: ['drone', 'dream pop'],
    description: 'Liz Harris,  a   Portland musician.',
  }

  it('keys by MBID when known, else normalized name', () => {
    expect(embeddingKey(source)).toBe(`mbid:${source.mbid}`)
    expect(embeddingKey({ mbid: null, name: 'The Cure' })).toBe('name:cure')
  })

  it('dedupes genres, drops tags that repeat a genre, and squashes whitespace', () => {
    expect(embeddingText(source)).toBe(
      'Music artist: Grouper. Genres: ambient, drone. Tags: dream pop. Liz Harris, a Portland musician.',
    )
  })

  it('hash changes with model or text', () => {
    expect(hashText('m1', 'x')).not.toBe(hashText('m2', 'x'))
    expect(hashText('m1', 'x')).toBe(hashText('m1', 'x'))
  })

  it('knows which providers embed', () => {
    expect(embeddingModelFor('gemini')).toBe('gemini-embedding-001')
    expect(embeddingModelFor('anthropic')).toBeNull()
    expect(embeddingModelFor(null)).toBeNull()
  })
})

describe('project', () => {
  const cluster = (cx: number, n: number) =>
    Array.from({ length: n }, (_, i) =>
      normalize([cx + Math.sin(i) * 0.01, 1 - cx, Math.cos(i) * 0.01, 0.1]),
    )

  it('is deterministic and keeps clusters apart', () => {
    const vectors = [...cluster(0, 12), ...cluster(1, 12)]
    const a = project(vectors)
    const b = project(vectors)
    expect(a).toEqual(b)
    for (const [x, y] of a) {
      expect(x).toBeGreaterThanOrEqual(0)
      expect(y).toBeLessThanOrEqual(1)
    }
    const mean = (pts: Array<[number, number]>) => [
      pts.reduce((s, p) => s + p[0], 0) / pts.length,
      pts.reduce((s, p) => s + p[1], 0) / pts.length,
    ]
    const [ax, ay] = mean(a.slice(0, 12))
    const [bx, by] = mean(a.slice(12))
    expect(
      Math.hypot((ax as number) - (bx as number), (ay as number) - (by as number)),
    ).toBeGreaterThan(0.3)
  })

  it('falls back to PCA for a handful of points', () => {
    const pts = project([normalize([1, 0]), normalize([0, 1]), normalize([1, 1])])
    expect(pts).toHaveLength(3)
  })
})
