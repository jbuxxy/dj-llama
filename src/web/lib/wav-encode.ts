// Shazam's recognition protocol (see core/clients/shazam.ts) wants raw 16kHz
// mono 16-bit PCM, and doesn't accept the webm/opus container MediaRecorder
// actually produces in Chrome/Edge. Converting client-side (rather than
// gambling on the server accepting a relabeled container) guarantees every
// browser uploads a format the recognizer can read.
const TARGET_SAMPLE_RATE = 16_000

export async function blobToWav(blob: Blob): Promise<Blob> {
  const arrayBuffer = await blob.arrayBuffer()
  const decodeCtx = new AudioContext()
  let decoded: AudioBuffer
  try {
    decoded = await decodeCtx.decodeAudioData(arrayBuffer)
  } finally {
    await decodeCtx.close()
  }

  const offlineCtx = new OfflineAudioContext(
    1,
    Math.ceil(decoded.duration * TARGET_SAMPLE_RATE),
    TARGET_SAMPLE_RATE,
  )
  const source = offlineCtx.createBufferSource()
  source.buffer = decoded
  source.connect(offlineCtx.destination)
  source.start(0)
  const resampled = await offlineCtx.startRendering()

  // Use the rendered buffer's *actual* sample rate/length, not the
  // requested TARGET_SAMPLE_RATE -- if the browser's OfflineAudioContext
  // ever renders at a different internal rate than asked (observed as
  // AudioTag rejecting real ~10s clips as "too short"), trusting the
  // request instead of the result silently writes a WAV header that
  // understates the clip's true duration.
  return encodeWav(normalize(resampled.getChannelData(0)), resampled.sampleRate)
}

// Phone mic capture of music playing across a room is quiet (confirmed:
// disabling the browser's auto-gain-control, needed to stop it mangling the
// signal, dropped captured peaks to under 1% of full scale) -- too faint to
// fingerprint reliably. Normalizing to near full-scale ourselves, after
// capture, gives consistent volume no matter how quiet the room/device
// combination makes the raw recording.
function normalize(samples: Float32Array): Float32Array {
  let peak = 0
  for (const s of samples) peak = Math.max(peak, Math.abs(s))
  if (peak === 0) return samples

  // No gain cap: a real recording (confirmed via direct testing) needed
  // ~100-400x to reach full scale, and an earlier 20x "safety" cap silently
  // left clips at ~14% of target amplitude -- still too quiet to recognize.
  const gain = 0.95 / peak
  const out = new Float32Array(samples.length)
  for (let i = 0; i < samples.length; i++) out[i] = (samples[i] ?? 0) * gain
  return out
}

function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const bytesPerSample = 2
  const buffer = new ArrayBuffer(44 + samples.length * bytesPerSample)
  const view = new DataView(buffer)

  writeString(view, 0, 'RIFF')
  view.setUint32(4, 36 + samples.length * bytesPerSample, true)
  writeString(view, 8, 'WAVE')
  writeString(view, 12, 'fmt ')
  view.setUint32(16, 16, true) // fmt chunk size
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * bytesPerSample, true) // byte rate
  view.setUint16(32, bytesPerSample, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  writeString(view, 36, 'data')
  view.setUint32(40, samples.length * bytesPerSample, true)

  let offset = 44
  for (const sample of samples) {
    const clamped = Math.max(-1, Math.min(1, sample))
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
    offset += bytesPerSample
  }

  return new Blob([buffer], { type: 'audio/wav' })
}

function writeString(view: DataView, offset: number, value: string) {
  for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i))
}
