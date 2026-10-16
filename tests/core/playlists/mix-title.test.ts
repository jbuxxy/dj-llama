import { describe, expect, it } from 'vitest'
import { generateMixTitle } from '@/core/playlists/mix-title'

describe('generateMixTitle', () => {
  it('appends a "- Mon YYYY" suffix matching the given date', () => {
    const title = generateMixTitle(new Date('2026-07-15T00:00:00Z'))
    expect(title).toMatch(/ - Jul 2026$/)
  })

  it('produces a non-empty phrase before the date suffix', () => {
    const title = generateMixTitle(new Date('2026-07-15T00:00:00Z'))
    const [phrase] = title.split(' - ')
    expect(phrase?.length).toBeGreaterThan(0)
  })

  it('varies the phrase across calls', () => {
    const titles = new Set(Array.from({ length: 20 }, () => generateMixTitle()))
    expect(titles.size).toBeGreaterThan(1)
  })
})
