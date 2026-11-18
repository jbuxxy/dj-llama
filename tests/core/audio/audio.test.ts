import { describe, expect, it } from 'vitest'
import { excerptStart, ffmpegArgs } from '@/core/audio/decode'
import { analyzeSamples, camelotFor, SAMPLE_RATE } from '@/core/audio/features'
import {
  bpmDistance,
  camelotDistance,
  energyArc,
  type SequenceFeatures,
  sequenceTracks,
} from '@/core/playlists/sequence'

function clicks(bpm: number, secs = 20): Float32Array {
  const n = SAMPLE_RATE * secs
  const s = new Float32Array(n)
  const period = (60 / bpm) * SAMPLE_RATE
  for (let b = 0; b * period < n; b++) {
    const start = Math.round(b * period)
    for (let i = 0; i < 400 && start + i < n; i++)
      s[start + i] = Math.sin(i * 0.9) * Math.exp(-i / 80) * 0.8
  }
  return s
}

function chord(freqs: number[], secs = 10, amp = 0.2): Float32Array {
  const n = SAMPLE_RATE * secs
  const s = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let v = 0
    for (const f of freqs) v += Math.sin((2 * Math.PI * f * i) / SAMPLE_RATE)
    s[i] = (v * amp) / freqs.length
  }
  return s
}

const C_MAJOR = [130.81, 261.63, 329.63, 392.0]
const A_MINOR = [110, 220, 261.63, 329.63]

describe('audio features', () => {
  it('finds the tempo of a click track to within 1 BPM', () => {
    expect(Math.abs(analyzeSamples(clicks(120)).bpm - 120)).toBeLessThanOrEqual(1)
    expect(Math.abs(analyzeSamples(clicks(128)).bpm - 128)).toBeLessThanOrEqual(1)
  })

  it('names the key on the Camelot wheel', () => {
    expect(analyzeSamples(chord(C_MAJOR)).camelot).toBe('8B')
    expect(analyzeSamples(chord(A_MINOR)).camelot).toBe('8A')
    expect(camelotFor(7, 'major')).toBe('9B') // G
    expect(camelotFor(4, 'minor')).toBe('9A') // Em
  })

  it('rates louder audio as more energetic', () => {
    const quiet = analyzeSamples(chord(C_MAJOR, 8, 0.05)).energy
    const mid = analyzeSamples(chord(C_MAJOR, 8, 0.3)).energy
    const loud = analyzeSamples(chord(C_MAJOR, 8, 0.9)).energy
    expect(quiet).toBeLessThan(mid)
    expect(mid).toBeLessThan(loud)
  })

  it('refuses an excerpt too short to analyze', () => {
    expect(() => analyzeSamples(new Float32Array(SAMPLE_RATE))).toThrow(/too short/)
  })
})

describe('decode', () => {
  it('never puts the Plex token in the ffmpeg command line', () => {
    const args = ffmpegArgs('http://127.0.0.1:4567/abcdef', 61.7)
    expect(args.join(' ')).not.toMatch(/token|X-Plex/i)
    expect(args).toContain('-ss')
    expect(args[args.indexOf('-ss') + 1]).toBe('61')
  })

  it('starts the excerpt past the intro but inside the track', () => {
    expect(excerptStart(200_000)).toBeCloseTo(60)
    expect(excerptStart(50_000)).toBeLessThanOrEqual(4)
    expect(excerptStart(null)).toBe(30)
  })
})

describe('sequenceTracks', () => {
  it('scores Camelot neighbors and tempo octaves as compatible', () => {
    expect(camelotDistance('8A', '8A')).toBe(0)
    expect(camelotDistance('8A', '9A')).toBe(0)
    expect(camelotDistance('12B', '1B')).toBe(0)
    expect(camelotDistance('8A', '8B')).toBe(0)
    expect(camelotDistance('8A', '3B')).toBe(2)
    expect(bpmDistance(87, 174)).toBeCloseTo(0)
    expect(bpmDistance(120, 126)).toBeGreaterThan(0)
  })

  it('peaks the energy arc around two thirds through', () => {
    expect(energyArc(0)).toBeLessThan(energyArc(0.65))
    expect(energyArc(1)).toBeLessThan(energyArc(0.65))
  })

  type T = { artistName: string; id: string; f: SequenceFeatures | null }
  const t = (id: string, camelot: string, energy: number, artist = id, bpm = 120): T => ({
    artistName: artist,
    id,
    f: { bpm, camelot, energy },
  })

  it('orders by key compatibility and energy, keeping unanalyzed tracks in place', () => {
    const tracks: T[] = [
      t('peak', '9A', 0.9),
      { artistName: 'x', id: 'unanalyzed', f: null },
      t('start', '8A', 0.2),
      t('clash', '3B', 0.5),
      t('mid', '8A', 0.6),
      t('end', '9A', 0.5),
    ]
    const out = sequenceTracks(tracks, (x) => x.f)
    expect(out[1]?.id).toBe('unanalyzed')
    expect(out).toHaveLength(tracks.length)
    expect(new Set(out.map((x) => x.id)).size).toBe(tracks.length)
    expect(out[0]?.id).toBe('start')
  })

  it('avoids back-to-back tracks by the same artist when it can', () => {
    const tracks: T[] = [
      t('a1', '8A', 0.5, 'A'),
      t('a2', '8A', 0.5, 'A'),
      t('b1', '8A', 0.5, 'B'),
      t('b2', '8A', 0.5, 'B'),
    ]
    const out = sequenceTracks(tracks, (x) => x.f)
    for (let i = 1; i < out.length; i++) expect(out[i]?.artistName).not.toBe(out[i - 1]?.artistName)
  })

  it('leaves a list alone when fewer than three tracks are analyzed', () => {
    const tracks: T[] = [
      t('a', '8A', 0.9),
      { artistName: 'b', id: 'b', f: null },
      t('c', '3B', 0.1),
    ]
    expect(sequenceTracks(tracks, (x) => x.f)).toEqual(tracks)
  })
})

describe('analysis retry policy', async () => {
  const { needsAnalysis } = await import('@/core/audio/analyzer')
  const track = { ratingKey: '1', partKey: '/library/parts/1/a.mp3' }
  const stored = (over: Partial<{ partKey: string; error: string | null; analyzedAt: Date }>) => ({
    ratingKey: '1',
    partKey: track.partKey,
    bpm: null,
    camelot: null,
    keyName: null,
    energy: null,
    error: null,
    analyzedAt: new Date(),
    ...over,
  })
  it('analyzes new tracks and replaced files, not fresh results', () => {
    expect(needsAnalysis(track, undefined)).toBe(true)
    expect(needsAnalysis(track, stored({ partKey: '/library/parts/2/b.mp3' }))).toBe(true)
    expect(needsAnalysis(track, stored({}))).toBe(false)
  })
  it('retries a failure only after a week', () => {
    const now = Date.now()
    expect(
      needsAnalysis(track, stored({ error: 'x', analyzedAt: new Date(now - 60_000) }), now),
    ).toBe(false)
    expect(
      needsAnalysis(track, stored({ error: 'x', analyzedAt: new Date(now - 8 * 86_400_000) }), now),
    ).toBe(true)
  })
  it('asks ffmpeg to reconnect on network errors', () => {
    expect(ffmpegArgs('http://127.0.0.1:1/x', 0)).toContain('-reconnect_on_network_error')
  })
})
