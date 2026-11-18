import { describe, expect, it } from 'vitest'
import {
  blendWeights,
  effectiveWeights,
  fitWeights,
  MIN_SAMPLES,
  type TrainingSample,
} from '@/core/listening/learn-weights'
import { classifyOutcome, matchPlays, toTrainingSamples } from '@/core/listening/outcomes'
import { localTrackWeight } from '@/core/playlists/track-resolver'
import type { PlayForOutcome } from '@/db/queries/outcomes'
import { DEFAULT_PREFERENCES } from '@/db/schema'

const DAY = 24 * 60 * 60 * 1000
const confirmed = new Date('2026-10-01T00:00:00Z')
const at = (days: number) => new Date(confirmed.getTime() + days * DAY)
const play = (days: number, extra: Partial<PlayForOutcome> = {}): PlayForOutcome => ({
  artistName: 'Grouper',
  albumName: 'Ruins',
  completed: true,
  skipped: false,
  playedAt: at(days),
  ...extra,
})

describe('classifyOutcome', () => {
  it('labels a keeper as soon as plays span enough days, even mid-window', () => {
    const plays = [play(1), play(1.1), play(1.2), play(3), play(3.1)]
    expect(classifyOutcome(plays, confirmed, at(4))).toMatchObject({ outcome: 'keeper', plays: 5 })
  })

  it('five plays in a single day are not a keeper yet', () => {
    const plays = [0, 0.01, 0.02, 0.03, 0.04].map((d) => play(1 + d))
    expect(classifyOutcome(plays, confirmed, at(4))).toBeNull()
    expect(classifyOutcome(plays, confirmed, at(31))?.outcome).toBe('tried')
  })

  it('waits for the window to close before calling it unplayed', () => {
    expect(classifyOutcome([], confirmed, at(10))).toBeNull()
    expect(classifyOutcome([], confirmed, at(31))).toMatchObject({ outcome: 'unplayed', plays: 0 })
  })

  it('ignores plays before confirmation or after the window, and counts skips', () => {
    const plays = [play(-5), play(40), play(2, { completed: false, skipped: true }), play(2.5)]
    expect(classifyOutcome(plays, confirmed, at(31))).toMatchObject({
      outcome: 'tried',
      plays: 1,
      skipRate: 0.5,
    })
  })
})

describe('matchPlays', () => {
  const plays = [
    play(1, { artistName: 'The Grouper' }),
    play(1, { albumName: 'Dragging a Dead Deer Up a Hill (Remastered)' }),
    play(1, { artistName: 'Someone Else' }),
  ]
  it('matches artist recs by normalized name', () => {
    const c = {
      id: 1,
      kind: 'artist',
      artistName: 'Grouper',
      albumTitle: null,
      confirmedAt: confirmed,
    }
    expect(matchPlays(c, plays)).toHaveLength(2)
  })
  it('matches album recs by album too', () => {
    const c = {
      id: 1,
      kind: 'album',
      artistName: 'Grouper',
      albumTitle: 'Dragging a Dead Deer Up a Hill',
      confirmedAt: confirmed,
    }
    expect(matchPlays(c, plays)).toHaveLength(1)
  })
})

describe('fitWeights', () => {
  it('needs enough samples', () => {
    expect(fitWeights([])).toBeNull()
  })

  it('puts the weight on the component that predicts keepers', () => {
    // Keepers are exactly the high-similarity picks; consensus is noise.
    let seed = 7
    const rand = () => {
      seed = (seed * 16807) % 2147483647
      return seed / 2147483647
    }
    const samples: TrainingSample[] = Array.from({ length: 200 }, () => {
      const similarity = rand()
      return {
        components: { similarity, consensus: rand(), genreOverlap: 0.5 },
        target: similarity > 0.5 ? 1 : 0,
      }
    })
    const w = fitWeights(samples)
    expect(w).not.toBeNull()
    if (!w) return
    const total = Object.values(w).reduce((a, v) => a + v, 0)
    expect(total).toBeCloseTo(1, 2)
    expect(Object.values(w).every((v) => v >= 0)).toBe(true)
    // A constant column can soak up some of the intercept; the predictive one still dominates.
    expect(w.similarity).toBeGreaterThan(0.6)
    expect(w.similarity).toBeGreaterThan(w.consensus * 5)
  })

  it('blends toward manual weights with few samples and stays normalized', () => {
    const manual = DEFAULT_PREFERENCES.scoringWeights
    const learned = {
      ...manual,
      consensus: 0,
      similarity: 1,
      genreOverlap: 0,
      aiConfidence: 0,
      feedbackBoost: 0,
      popularity: 0,
    }
    const few = blendWeights(manual, learned, MIN_SAMPLES)
    const many = blendWeights(manual, learned, 5000)
    expect(few.similarity).toBeLessThan(many.similarity)
    expect(Object.values(many).reduce((a, v) => a + v, 0)).toBeCloseTo(1, 2)
  })

  it('effectiveWeights only applies learned weights when opted in', () => {
    const prefs = { scoringWeights: DEFAULT_PREFERENCES.scoringWeights }
    const learned = { weights: { ...prefs.scoringWeights, similarity: 1 }, samples: 100 }
    expect(effectiveWeights(prefs, learned)).toBe(prefs.scoringWeights)
    expect(effectiveWeights({ ...prefs, autoTuneWeights: true }, null)).toBe(prefs.scoringWeights)
    expect(effectiveWeights({ ...prefs, autoTuneWeights: true }, learned)).not.toBe(
      prefs.scoringWeights,
    )
  })
})

describe('toTrainingSamples', () => {
  it('maps outcomes and rejections to targets', () => {
    const s = toTrainingSamples([
      { sources: { similarity: 0.9 }, outcome: 'keeper', status: 'added_to_lidarr' },
      { sources: { similarity: 0.5 }, outcome: 'tried', status: 'added_to_lidarr' },
      { sources: { similarity: 0.1 }, outcome: null, status: 'rejected' },
      { sources: null, outcome: 'keeper', status: 'added_to_lidarr' },
    ])
    expect(s.map((x) => x.target)).toEqual([1, 0.5, 0])
  })
})

describe('skip penalty', () => {
  it('down-weights a track skipped more than half the time', () => {
    const base = { name: 't', artist: 'a', path: '/x', viewCount: 5 }
    expect(localTrackWeight({ ...base, skipRate: 0.8 })).toBeCloseTo(localTrackWeight(base) * 0.3)
    expect(localTrackWeight({ ...base, skipRate: 0.2 })).toBe(localTrackWeight(base))
  })
})
