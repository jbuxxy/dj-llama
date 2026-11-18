// Tempo, key and energy from a mono PCM excerpt -- small, dependency-free
// DSP (the usual libraries for this, Essentia and aubio, are AGPL/GPL and
// this project is MIT). Accurate enough to order a playlist; not a mastering
// tool.
//
// - BPM: spectral-flux onset envelope -> autocorrelation, with a log-normal
//   tempo prior around 120 BPM to pick the right octave, refined with a comb
//   over the first beat multiples, folded into 70-180.
// - Key: chromagram -> Krumhansl-Schmuckler profile correlation over all 24
//   keys -> Camelot code (8B = C major, 8A = A minor).
// - Energy: 0..1 blend of loudness, brightness (spectral centroid) and onset
//   density.

export const SAMPLE_RATE = 22050

export type AudioFeatures = {
  bpm: number
  bpmConfidence: number
  /** Camelot wheel code, e.g. '8B'. */
  camelot: string
  keyName: string
  keyConfidence: number
  energy: number
}

// ── FFT ────────────────────────────────────────────────────────────────────

/** In-place radix-2 FFT; re/im length must be a power of two. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j] as number, re[i] as number]
      ;[im[i], im[j]] = [im[j] as number, im[i] as number]
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < len / 2; k++) {
        const a = i + k
        const b = a + len / 2
        const xr = (re[b] as number) * cr - (im[b] as number) * ci
        const xi = (re[b] as number) * ci + (im[b] as number) * cr
        re[b] = (re[a] as number) - xr
        im[b] = (im[a] as number) - xi
        re[a] = (re[a] as number) + xr
        im[a] = (im[a] as number) + xi
        const t = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = t
      }
    }
  }
}

function hann(n: number): Float64Array {
  const w = new Float64Array(n)
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))
  return w
}

/** Magnitude spectra (bins 0..n/2) for each frame. */
function stft(samples: Float32Array, size: number, hop: number): Float64Array[] {
  const win = hann(size)
  const frames: Float64Array[] = []
  const re = new Float64Array(size)
  const im = new Float64Array(size)
  for (let start = 0; start + size <= samples.length; start += hop) {
    for (let i = 0; i < size; i++) {
      re[i] = (samples[start + i] as number) * (win[i] as number)
      im[i] = 0
    }
    fft(re, im)
    const mag = new Float64Array(size / 2 + 1)
    for (let k = 0; k <= size / 2; k++) mag[k] = Math.hypot(re[k] as number, im[k] as number)
    frames.push(mag)
  }
  return frames
}

// ── Tempo ──────────────────────────────────────────────────────────────────

const ONSET_FRAME = 1024
const ONSET_HOP = 256

function onsetEnvelope(spectra: Float64Array[]): Float64Array {
  const env = new Float64Array(spectra.length)
  for (let t = 1; t < spectra.length; t++) {
    const cur = spectra[t] as Float64Array
    const prev = spectra[t - 1] as Float64Array
    let flux = 0
    for (let k = 1; k < cur.length; k++) {
      const d = Math.log1p(cur[k] as number) - Math.log1p(prev[k] as number)
      if (d > 0) flux += d
    }
    env[t] = flux
  }
  // Subtract a ~0.5s moving average, keep the positive part: peaks only.
  const w = Math.max(1, Math.round((0.5 * SAMPLE_RATE) / ONSET_HOP))
  const out = new Float64Array(env.length)
  let sum = 0
  for (let t = 0; t < env.length; t++) {
    sum += env[t] as number
    if (t >= w) sum -= env[t - w] as number
    const mean = sum / Math.min(t + 1, w)
    out[t] = Math.max(0, (env[t] as number) - mean)
  }
  return out
}

function autocorr(x: Float64Array, maxLag: number): Float64Array {
  const ac = new Float64Array(maxLag + 1)
  for (let lag = 0; lag <= maxLag; lag++) {
    let s = 0
    for (let i = 0; i + lag < x.length; i++) s += (x[i] as number) * (x[i + lag] as number)
    ac[lag] = s / (x.length - lag)
  }
  return ac
}

function interp(ac: Float64Array, lag: number): number {
  const i = Math.floor(lag)
  const f = lag - i
  if (i + 1 >= ac.length) return ac[ac.length - 1] ?? 0
  return (ac[i] as number) * (1 - f) + (ac[i + 1] as number) * f
}

export function estimateTempo(samples: Float32Array): { bpm: number; confidence: number } {
  const env = onsetEnvelope(stft(samples, ONSET_FRAME, ONSET_HOP))
  const frameRate = SAMPLE_RATE / ONSET_HOP
  const lagFor = (bpm: number) => (60 * frameRate) / bpm
  const maxLag = Math.ceil(lagFor(40) * 4)
  const ac = autocorr(env, Math.min(maxLag, env.length - 1))
  const zero = ac[0] || 1
  // Score each candidate tempo by the comb of its first four beat multiples,
  // weighted by a log-normal prior (center 120 BPM, ~1 octave wide).
  const score = (bpm: number) => {
    let s = 0
    for (let k = 1; k <= 4; k++) s += interp(ac, lagFor(bpm) * k) / k
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2)
    return s * prior
  }
  let best = 120
  let bestScore = -Infinity
  for (let bpm = 50; bpm <= 220; bpm += 0.5) {
    const s = score(bpm)
    if (s > bestScore) {
      bestScore = s
      best = bpm
    }
  }
  for (let bpm = best - 0.6; bpm <= best + 0.6; bpm += 0.05) {
    const s = score(bpm)
    if (s > bestScore) {
      bestScore = s
      best = bpm
    }
  }
  while (best < 70) best *= 2
  while (best > 180) best /= 2
  const confidence = Math.max(0, Math.min(1, interp(ac, lagFor(best)) / zero))
  return { bpm: Math.round(best * 10) / 10, confidence: Math.round(confidence * 100) / 100 }
}

// ── Key ────────────────────────────────────────────────────────────────────

const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]
const PITCH_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']

export function chromagram(samples: Float32Array): number[] {
  const size = 4096
  const spectra = stft(samples, size, size / 2)
  const chroma = new Array<number>(12).fill(0)
  const binHz = SAMPLE_RATE / size
  const pcOfBin: number[] = []
  for (let k = 0; k <= size / 2; k++) {
    const f = k * binHz
    pcOfBin.push(
      f < 55 || f > 2000 ? -1 : (((Math.round(12 * Math.log2(f / 440)) + 9) % 12) + 12) % 12,
    )
  }
  for (const mag of spectra) {
    for (let k = 0; k < mag.length; k++) {
      const pc = pcOfBin[k] as number
      if (pc >= 0) chroma[pc] = (chroma[pc] as number) + Math.sqrt(mag[k] as number)
    }
  }
  return chroma
}

function pearson(a: number[], b: number[]): number {
  const n = a.length
  const ma = a.reduce((s, v) => s + v, 0) / n
  const mb = b.reduce((s, v) => s + v, 0) / n
  let num = 0
  let da = 0
  let db = 0
  for (let i = 0; i < n; i++) {
    const x = (a[i] as number) - ma
    const y = (b[i] as number) - mb
    num += x * y
    da += x * x
    db += y * y
  }
  return da && db ? num / Math.sqrt(da * db) : 0
}

/** Camelot code for a tonic pitch class (C = 0) and mode. */
export function camelotFor(pc: number, mode: 'major' | 'minor'): string {
  const majorPc = mode === 'major' ? pc : (pc + 3) % 12
  const n = ((((majorPc * 7) % 12) + 7) % 12) + 1
  return `${n}${mode === 'major' ? 'B' : 'A'}`
}

export function estimateKey(samples: Float32Array): {
  camelot: string
  keyName: string
  confidence: number
} {
  const chroma = chromagram(samples)
  const scores: Array<{ pc: number; mode: 'major' | 'minor'; r: number }> = []
  for (let pc = 0; pc < 12; pc++) {
    const rotated = chroma.map((_, i) => chroma[(i + pc) % 12] as number)
    scores.push({ pc, mode: 'major', r: pearson(rotated, MAJOR) })
    scores.push({ pc, mode: 'minor', r: pearson(rotated, MINOR) })
  }
  scores.sort((a, b) => b.r - a.r)
  const best = scores[0] as (typeof scores)[number]
  const second = scores[1]?.r ?? 0
  return {
    camelot: camelotFor(best.pc, best.mode),
    keyName: `${PITCH_NAMES[best.pc]}${best.mode === 'minor' ? 'm' : ''}`,
    // Margin over the runner-up, scaled: relative major/minor are often close.
    confidence: Math.round(Math.max(0, Math.min(1, (best.r - second) * 5)) * 100) / 100,
  }
}

// ── Energy ─────────────────────────────────────────────────────────────────

export function estimateEnergy(samples: Float32Array): number {
  let sq = 0
  for (const s of samples) sq += s * s
  const rms = Math.sqrt(sq / Math.max(1, samples.length))
  const db = 20 * Math.log10(rms + 1e-9)
  const loud = Math.max(0, Math.min(1, (db + 40) / 34)) // -40 dBFS..-6 dBFS
  const spectra = stft(samples, ONSET_FRAME, ONSET_HOP * 4)
  let centroidSum = 0
  let weight = 0
  for (const mag of spectra) {
    let num = 0
    let den = 0
    for (let k = 1; k < mag.length; k++) {
      num += k * (mag[k] as number)
      den += mag[k] as number
    }
    if (den > 0) {
      centroidSum += (num / den) * den
      weight += den
    }
  }
  const centroidHz = weight > 0 ? (centroidSum / weight) * (SAMPLE_RATE / ONSET_FRAME) : 0
  const bright = Math.max(0, Math.min(1, centroidHz / 3500))
  const env = onsetEnvelope(stft(samples, ONSET_FRAME, ONSET_HOP))
  const density = Math.max(
    0,
    Math.min(1, env.reduce((a, v) => a + v, 0) / Math.max(1, env.length) / 8),
  )
  return Math.round((0.55 * loud + 0.25 * bright + 0.2 * density) * 100) / 100
}

export function analyzeSamples(samples: Float32Array): AudioFeatures {
  if (samples.length < SAMPLE_RATE * 5) throw new Error('Audio excerpt is too short to analyze')
  const tempo = estimateTempo(samples)
  const key = estimateKey(samples)
  return {
    bpm: tempo.bpm,
    bpmConfidence: tempo.confidence,
    camelot: key.camelot,
    keyName: key.keyName,
    keyConfidence: key.confidence,
    energy: estimateEnergy(samples),
  }
}
