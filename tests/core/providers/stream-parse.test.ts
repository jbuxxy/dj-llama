// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { completeArrayObjects, RecommendationStreamParser } from '@/core/providers/stream-parse'

const rec = (name: string) => ({
  artistName: name,
  reasoning: `Because ${name} [has brackets] and "quotes" {and braces}`,
  confidence: 0.8,
  genres: ['ambient', 'drone'],
})

describe('RecommendationStreamParser', () => {
  it('emits each recommendation once, as soon as its object closes', () => {
    const full = JSON.stringify({ recommendations: [rec('Grouper'), rec('Stars of the Lid')] })
    const seen: string[] = []
    const parser = new RecommendationStreamParser((r) => seen.push(r.artistName))
    const firstEnd = full.indexOf('},{') // end of the first object
    // Feed in small chunks; the first card must appear before the second is written.
    for (let i = 0; i < full.length; i += 7) {
      parser.push(full.slice(i, i + 7))
      if (i + 7 > firstEnd && i + 7 < full.indexOf('Stars')) expect(seen).toEqual(['Grouper'])
    }
    expect(seen).toEqual(['Grouper', 'Stars of the Lid'])
  })

  it('handles a bare array, code fences and <think> blocks', () => {
    const seen: string[] = []
    const parser = new RecommendationStreamParser((r) => seen.push(r.artistName))
    parser.push('<think>maybe [{"artistName":"Wrong"}] ...')
    parser.push('</think>\n```json\n[')
    parser.push(`${JSON.stringify(rec('Tim Hecker'))}]\n\`\`\``)
    expect(seen).toEqual(['Tim Hecker'])
  })

  it('drops invalid entries without shifting later ones', () => {
    const objects = completeArrayObjects(`[{"bad":1},${JSON.stringify(rec('Eno'))}`)
    expect(objects).toHaveLength(2)
    const seen: string[] = []
    const parser = new RecommendationStreamParser((r) => seen.push(r.artistName))
    parser.push(`[{"bad":1},${JSON.stringify(rec('Eno'))}]`)
    expect(seen).toEqual(['Eno'])
  })
})
