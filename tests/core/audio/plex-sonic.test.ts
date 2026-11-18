import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  clearSonicNeighborCache,
  combinedEnergy,
  introSeconds,
  keyToCamelot,
  moodLean,
  needsRefresh,
  outroSeconds,
  parseRamp,
  plexEnergy,
  refreshPlexSonic,
  sequenceFeaturesFor,
  sonicDistances,
} from '@/core/audio/plex-sonic'
import type { PlexTrackSonicInfo } from '@/core/clients/plex'
import { type SequenceFeatures, sequenceTracks } from '@/core/playlists/sequence'
import { getPlexSonic } from '@/db/queries/plex-sonic'
import { makeTestDb } from '../../helpers/test-db'

vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 })

// Real ramps from a Plex server (PMS 1.43).
const START = '-51.00 0.00;-11.61 1.00;-6.04 1.10;-3.00 1.20;1.41 1.40;3.31 1.60;6.49 11.30;'
const END =
  '-51.00 0.10;-39.57 1.00;-28.53 1.30;-21.95 1.50;-18.62 1.60;-15.38 1.70;-11.52 1.80;-8.70 1.90;-4.79 2.10;-3.00 2.30;0.09 3.90;3.27 5.40;7.22 6.00;'

describe('Plex ramps', () => {
  it('parses level/time pairs', () => {
    expect(parseRamp(START)).toHaveLength(7)
    expect(parseRamp('')).toEqual([])
    expect(parseRamp('garbage;1 2 3;')).toEqual([])
  })
  it('measures intro and fade-out lengths', () => {
    expect(introSeconds(START)).toBeCloseTo(1.2)
    expect(outroSeconds(END)).toBeCloseTo(2.3)
    expect(introSeconds(null)).toBeNull()
    expect(introSeconds('-40 0;-20 8;-2 14;')).toBe(14)
  })
})

describe('Plex energy', () => {
  it('reads mood tags as an energy lean', () => {
    expect(moodLean(['Rousing', 'Energetic'])).toBeGreaterThan(0.8)
    expect(moodLean(['Calm/Peaceful', 'Melancholy'])).toBeLessThan(-0.5)
    expect(moodLean(['Witty', 'Literate'])).toBeNull()
  })
  it('rises with loudness and energetic moods', () => {
    const quiet = plexEnergy({ loudness: -18, lra: 12, moods: ['Soft/Quiet'] }) as number
    const loud = plexEnergy({ loudness: -7, lra: 5, moods: ['Aggressive'] }) as number
    const loudNoMood = plexEnergy({ loudness: -7, lra: 5, moods: [] }) as number
    expect(quiet).toBeLessThan(0.25)
    expect(loud).toBeGreaterThan(0.85)
    expect(loudNoMood).toBeGreaterThan(quiet)
    expect(plexEnergy({ loudness: null, lra: null, moods: [] })).toBeNull()
  })
  it('blends with our measured energy, falling back to whichever exists', () => {
    expect(combinedEnergy(1, 0)).toBeCloseTo(0.6)
    expect(combinedEnergy(null, 0.4)).toBe(0.4)
    expect(combinedEnergy(0.7, null)).toBe(0.7)
  })
  it('merges both sources into sequencing features', () => {
    const plex = {
      ratingKey: '1',
      loudness: -8,
      lra: 5,
      introSec: 1,
      outroSec: 4,
      moods: [],
      hasVocals: null,
      bpm: 128,
      camelot: '8A',
      sonicAnalyzed: false,
      fetchedAt: new Date(),
    }
    const f = sequenceFeaturesFor(undefined, plex)
    // Plex's tempo/key fill in when we haven't analyzed the track...
    expect(f?.bpm).toBe(128)
    // ...but our own measurement wins when both exist.
    const both = sequenceFeaturesFor({ bpm: 100, camelot: '1B', energy: 0.5 }, plex)
    expect(both?.bpm).toBe(100)
    expect(both?.camelot).toBe('1B')
    expect(f?.energy).toBeGreaterThan(0.5)
    expect(f?.outroSec).toBe(4)
    expect(sequenceFeaturesFor(undefined, undefined)).toBeNull()
  })
})

describe('refresh policy', () => {
  const row = (sonicAnalyzed: boolean, ageDays: number, now: number, complete = true) => ({
    ratingKey: '1',
    loudness: -8,
    lra: 5,
    introSec: null,
    outroSec: null,
    moods: [],
    hasVocals: complete ? true : null,
    bpm: complete ? 120 : null,
    camelot: complete ? '8A' : null,
    sonicAnalyzed,
    fetchedAt: new Date(now - ageDays * 86_400_000),
  })
  it('re-checks tracks Plex has not sonically analyzed yet daily, analyzed ones monthly', () => {
    const now = Date.now()
    expect(needsRefresh(undefined, now)).toBe(true)
    expect(needsRefresh(row(false, 0.5, now), now)).toBe(false)
    expect(needsRefresh(row(false, 2, now), now)).toBe(true)
    expect(needsRefresh(row(true, 10, now), now)).toBe(false)
    expect(needsRefresh(row(true, 31, now), now)).toBe(true)
  })
  it('re-checks analyzed tracks weekly while Plex lacks their tempo/key/voice data', () => {
    const now = Date.now()
    expect(needsRefresh(row(true, 3, now, false), now)).toBe(false)
    expect(needsRefresh(row(true, 8, now, false), now)).toBe(true)
  })
})

describe('refreshPlexSonic', () => {
  let ctx: Awaited<ReturnType<typeof makeTestDb>>
  beforeAll(async () => {
    ctx = await makeTestDb()
  })
  afterAll(async () => {
    await ctx?.close()
  })
  const info = (
    ratingKey: string,
    sonicAnalyzed: boolean,
    over: Partial<PlexTrackSonicInfo> = {},
  ): PlexTrackSonicInfo => ({
    ratingKey,
    loudness: -9,
    lra: 6,
    startRamp: START,
    endRamp: END,
    moods: ['Lively'],
    sonicAnalyzed,
    hasVoiceActivity: false,
    bpm: null,
    musicalKey: null,
    unknownFields: [],
    ...over,
  })

  it('stores Plex data and only fetches what is missing', async () => {
    const getTrackSonicInfo = vi.fn(async (keys: string[]) => keys.map((k) => info(k, k === 'a')))
    const first = await refreshPlexSonic(ctx.db as never, { getTrackSonicInfo }, ['a', 'b'])
    expect(first.get('a')?.sonicAnalyzed).toBe(true)
    expect(first.get('b')?.introSec).toBeCloseTo(1.2)
    expect(first.get('b')?.moods).toEqual(['Lively'])
    await refreshPlexSonic(ctx.db as never, { getTrackSonicInfo }, ['a', 'b', 'c'])
    expect(getTrackSonicInfo).toHaveBeenLastCalledWith(['c'])
  })

  it('keeps stored data when Plex is unreachable', async () => {
    const getTrackSonicInfo = vi.fn().mockRejectedValue(new Error('down'))
    const out = await refreshPlexSonic(ctx.db as never, { getTrackSonicInfo }, ['a', 'zz'])
    expect(out.get('a')).toBeDefined()
    expect((await getPlexSonic(ctx.db as never, ['zz'])).size).toBe(0)
  })

  it("ignores Plex's voice flag until Plex reports a vocal track, then uses it", async () => {
    const allFalse = vi.fn(async (keys: string[]) => keys.map((k) => info(k, true)))
    const before = await refreshPlexSonic(ctx.db as never, { getTrackSonicInfo: allFalse }, ['v1'])
    expect(before.get('v1')?.hasVocals).toBeNull()
    const live = vi.fn(async (keys: string[]) =>
      keys.map((k) => info(k, true, { hasVoiceActivity: k === 'v2' })),
    )
    const after = await refreshPlexSonic(ctx.db as never, { getTrackSonicInfo: live }, ['v2', 'v3'])
    expect(after.get('v2')?.hasVocals).toBe(true)
    expect(after.get('v3')?.hasVocals).toBe(false)
  })

  it('takes tempo and key from Plex when it provides them, and logs new fields', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const getTrackSonicInfo = vi.fn(async (keys: string[]) =>
      keys.map((k) =>
        info(k, true, { bpm: 124, musicalKey: 'F# minor', unknownFields: ['stream.newThing'] }),
      ),
    )
    const out = await refreshPlexSonic(ctx.db as never, { getTrackSonicInfo }, ['t1'])
    expect(out.get('t1')?.bpm).toBe(124)
    expect(out.get('t1')?.camelot).toBe('11A')
    expect(log.mock.calls.some((c) => String(c[0]).includes('stream.newThing'))).toBe(true)
    log.mockRestore()
  })
})

describe('keyToCamelot', () => {
  it('reads Camelot codes and key names', () => {
    expect(keyToCamelot('8A')).toBe('8A')
    expect(keyToCamelot('08b')).toBe('8B')
    expect(keyToCamelot('Am')).toBe('8A')
    expect(keyToCamelot('C')).toBe('8B')
    expect(keyToCamelot('C major')).toBe('8B')
    expect(keyToCamelot('F# minor')).toBe('11A')
    expect(keyToCamelot('Gbm')).toBe('11A')
    expect(keyToCamelot('Bbmin')).toBe('3A')
    expect(keyToCamelot('13A')).toBeNull()
    expect(keyToCamelot('H')).toBeNull()
    expect(keyToCamelot('C dorian')).toBeNull()
  })
})

describe('sonic neighbors', () => {
  it('looks up pair distances from either side and caches neighbor lists', async () => {
    clearSonicNeighborCache()
    const getSonicNeighbors = vi.fn(async (k: string) =>
      k === 'a' ? [{ ratingKey: 'b', distance: 0.1 }] : [],
    )
    const d = await sonicDistances({ getSonicNeighbors }, ['a', 'b', 'c'])
    expect(d('a', 'b')).toBe(0.1)
    expect(d('b', 'a')).toBe(0.1)
    expect(d('a', 'c')).toBeUndefined()
    await sonicDistances({ getSonicNeighbors }, ['a', 'b', 'c'])
    expect(getSonicNeighbors).toHaveBeenCalledTimes(3)
  })

  it('re-asks soon when Plex had no neighbors yet (analysis still running)', async () => {
    clearSonicNeighborCache()
    const now = Date.now()
    const getSonicNeighbors = vi.fn().mockResolvedValue([])
    await sonicDistances({ getSonicNeighbors }, ['a'], { now })
    await sonicDistances({ getSonicNeighbors }, ['a'], { now: now + 7 * 3600_000 })
    expect(getSonicNeighbors).toHaveBeenCalledTimes(2)
  })
})

describe('sequencing with Plex data', () => {
  type T = { artistName: string; id: string; f: SequenceFeatures }
  const t = (id: string, f: Partial<SequenceFeatures>): T => ({
    artistName: id,
    id,
    f: { bpm: null, camelot: null, energy: 0.5, ...f },
  })

  it('sequences tracks that only have Plex data', () => {
    const tracks = [
      t('loud', { energy: 0.9, loudness: -7 }),
      t('quiet', { energy: 0.2, loudness: -16 }),
      t('mid', { energy: 0.5, loudness: -11 }),
    ]
    const out = sequenceTracks(tracks, (x) => x.f)
    expect(out[0]?.id).toBe('quiet')
  })

  it('prefers sonically alike neighbors when Plex knows them', () => {
    const tracks = ['a', 'x', 'b', 'y'].map((id) => t(id, {}))
    const near: Record<string, number> = { 'a|b': 0.05, 'x|y': 0.05 }
    const out = sequenceTracks(tracks, (x) => x.f, {
      sonicDistance: (p, q) => near[`${p.id}|${q.id}`] ?? near[`${q.id}|${p.id}`],
    })
    const pos = (id: string) => out.findIndex((x) => x.id === id)
    expect(Math.abs(pos('a') - pos('b'))).toBe(1)
    expect(Math.abs(pos('x') - pos('y'))).toBe(1)
  })

  it('avoids big loudness jumps between neighbors', () => {
    const tracks = [
      t('l1', { loudness: -6 }),
      t('q1', { loudness: -20 }),
      t('l2', { loudness: -6 }),
      t('q2', { loudness: -20 }),
    ]
    const out = sequenceTracks(tracks, (x) => x.f)
    const jumps = out.slice(1).filter((x, i) => x.id[0] !== out[i]?.id[0]).length
    expect(jumps).toBe(1)
  })
})
