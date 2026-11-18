// DJ-style track order: harmonically compatible neighbors (Camelot wheel),
// tempo steps a DJ could beatmatch (half/double time counts), and an energy
// arc -- ease in, peak around two thirds through, come down at the end --
// while keeping one artist from playing back to back.
//
// Plex's analysis adds smoother joins: no big loudness jumps between
// neighbors, no long fade-out straight into a slow build, and -- once Plex's
// sonic analysis has reached the tracks -- neighbors that sound alike.
//
// Beam search over the tracks that have analyzed features; tracks without
// features stay exactly where the shuffle put them, so a partly analyzed
// playlist is still a good shuffle plus a sequenced backbone.

export type SequenceFeatures = {
  bpm: number | null
  camelot: string | null
  energy: number | null
  /** Integrated loudness, LUFS (Plex). */
  loudness?: number | null
  /** Seconds until the track reaches its normal level (Plex). */
  introSec?: number | null
  /** Seconds of fade at the end (Plex). */
  outroSec?: number | null
}

export type SequenceOptions<T = unknown> = {
  /** Position of the energy peak, 0..1. */
  peakAt?: number
  beamWidth?: number
  /**
   * Sonic distance between two tracks, 0 = alike; undefined when unknown or
   * not alike. When given, alike neighbors are preferred.
   */
  sonicDistance?: (a: T, b: T) => number | undefined
  /** Distance treated as "not alike at all" (normalizes sonicDistance). */
  sonicMaxDistance?: number
}

const KEY_WEIGHT = 1
const BPM_WEIGHT = 1
const ENERGY_WEIGHT = 1.5
const SAME_ARTIST_PENALTY = 1.2
const LOUDNESS_WEIGHT = 0.6
const SONIC_WEIGHT = 1
const SAG_PENALTY = 0.3
// Loudness steps under this many LU go unnoticed.
const LOUDNESS_SLACK = 3
// A fade-out this long into an intro this long sags in the middle.
const LONG_RAMP_SEC = 5
const MIN_SEQUENCED = 3

type Parsed = { n: number; mode: 'A' | 'B' }

function parseCamelot(code: string | null): Parsed | null {
  const m = code?.match(/^(\d{1,2})([AB])$/)
  if (!m) return null
  const n = Number(m[1])
  return n >= 1 && n <= 12 ? { n, mode: m[2] as 'A' | 'B' } : null
}

/** 0 = mixes cleanly (same key, ±1 on the wheel, relative major/minor), up to 2 = clash. */
export function camelotDistance(a: string | null, b: string | null): number {
  const x = parseCamelot(a)
  const y = parseCamelot(b)
  if (!x || !y) return 0.6
  const step = Math.min((x.n - y.n + 12) % 12, (y.n - x.n + 12) % 12)
  if (x.mode === y.mode) return step <= 1 ? 0 : step === 2 ? 1 : 2
  return step === 0 ? 0 : step === 1 ? 1 : 2
}

/** Tempo gap in octaves, treating half- and double-time as the same tempo. */
export function bpmDistance(a: number | null, b: number | null): number {
  if (!a || !b) return 0.3
  return Math.min(...[1, 2, 0.5].map((r) => Math.abs(Math.log2((b * r) / a))))
}

/** Target energy (0..1 of the playlist's own range) at position t in 0..1. */
export function energyArc(t: number, peakAt = 0.65): number {
  if (t <= peakAt) return 0.25 + 0.75 * Math.sin(((t / peakAt) * Math.PI) / 2)
  return 1 - 0.45 * ((t - peakAt) / (1 - peakAt))
}

export function sequenceTracks<T extends { artistName: string }>(
  tracks: T[],
  featuresOf: (track: T) => SequenceFeatures | null | undefined,
  opts: SequenceOptions<T> = {},
): T[] {
  const featured: Array<{ track: T; f: SequenceFeatures; slot: number }> = []
  tracks.forEach((track, slot) => {
    const f = featuresOf(track)
    if (f && (f.bpm != null || f.camelot != null || f.energy != null || f.loudness != null))
      featured.push({ track, f, slot })
  })
  if (featured.length < MIN_SEQUENCED) return tracks

  const n = featured.length
  const energies = featured.map((x) => x.f.energy).filter((e): e is number => e != null)
  const lo = energies.length ? Math.min(...energies) : 0
  const hi = energies.length ? Math.max(...energies) : 1
  const span = hi - lo || 1
  const target = (pos: number) => lo + span * energyArc(n === 1 ? 0 : pos / (n - 1), opts.peakAt)

  const placeCost = (i: number, pos: number) => {
    const e = featured[i]?.f.energy
    return e == null ? 0.3 : (Math.abs(e - target(pos)) / span) * ENERGY_WEIGHT
  }
  const sonicMax = opts.sonicMaxDistance ?? 0.6
  const sonicOf = opts.sonicDistance
  const stepCost = (a: number, b: number, pos: number) => {
    const xa = featured[a] as (typeof featured)[number]
    const xb = featured[b] as (typeof featured)[number]
    const fa = xa.f
    const fb = xb.f
    const sameArtist = xa.track.artistName.toLowerCase() === xb.track.artistName.toLowerCase()
    let cost =
      KEY_WEIGHT * camelotDistance(fa.camelot, fb.camelot) +
      BPM_WEIGHT * bpmDistance(fa.bpm, fb.bpm) * 8 +
      placeCost(b, pos) +
      (sameArtist ? SAME_ARTIST_PENALTY : 0)
    if (fa.loudness != null && fb.loudness != null)
      cost +=
        (LOUDNESS_WEIGHT * Math.max(0, Math.abs(fa.loudness - fb.loudness) - LOUDNESS_SLACK)) / 6
    if ((fa.outroSec ?? 0) >= LONG_RAMP_SEC && (fb.introSec ?? 0) >= LONG_RAMP_SEC)
      cost += SAG_PENALTY
    if (sonicOf) {
      const d = sonicOf(xa.track, xb.track)
      cost += SONIC_WEIGHT * (d == null ? 1 : Math.min(1, d / sonicMax))
    }
    return cost
  }

  type Beam = { order: number[]; used: Set<number>; cost: number }
  const width = opts.beamWidth ?? 5
  let beams: Beam[] = featured
    .map((_, i) => ({ order: [i], used: new Set([i]), cost: placeCost(i, 0) }))
    .sort((a, b) => a.cost - b.cost)
    .slice(0, width)
  for (let pos = 1; pos < n; pos++) {
    const next: Beam[] = []
    for (const beam of beams) {
      const last = beam.order[beam.order.length - 1] as number
      // Keep only each beam's few best continuations: bounds the work to
      // width × width per step regardless of playlist length.
      const options: Array<{ i: number; c: number }> = []
      for (let i = 0; i < n; i++)
        if (!beam.used.has(i)) options.push({ i, c: stepCost(last, i, pos) })
      options.sort((a, b) => a.c - b.c)
      for (const { i, c } of options.slice(0, width)) {
        const used = new Set(beam.used)
        used.add(i)
        next.push({ order: [...beam.order, i], used, cost: beam.cost + c })
      }
    }
    beams = next.sort((a, b) => a.cost - b.cost).slice(0, width)
  }
  const best = beams[0]?.order ?? featured.map((_, i) => i)

  // Sequenced tracks fill the slots the featured tracks held, in order;
  // unanalyzed tracks never move.
  const slots = featured.map((x) => x.slot)
  const out = [...tracks]
  best.forEach((i, k) => {
    out[slots[k] as number] = (featured[i] as (typeof featured)[number]).track
  })
  return out
}
