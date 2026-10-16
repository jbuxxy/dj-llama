import { Shazam, s16LEToSamplesArray } from 'shazam-api'

export type ShazamIdentifyResult = {
  artist: string
  title: string
  album?: string
  /** International Standard Recording Code -- lets the caller resolve the
   * exact official recording via MusicBrainz's ISRC lookup instead of a
   * fuzzy title/artist search. Empty when Shazam has none on file. */
  isrc?: string
}

const EXPECTED_SAMPLE_RATE = 16_000

// shazam-api's own recognizeSong() derives {title, artist, album, year} from
// fullRecognizeSong()'s raw response but drops everything else, including
// the ISRC that lets MusicBrainz resolution skip fuzzy title search
// entirely (see core/clients/musicbrainz.ts's lookupRecordingsByIsrc). This
// calls fullRecognizeSong() directly and replicates that same extraction
// (track.sections.find(type === 'SONG') -> metadata by title) so the
// existing fields behave identically, plus keeps track.isrc.
type FullResult = NonNullable<Awaited<ReturnType<Shazam['fullRecognizeSong']>>>

function extractResult(full: FullResult): ShazamIdentifyResult | null {
  const track = full.track
  const songSection = track.sections.find((s) => s.type === 'SONG')
  const album = songSection?.metadata?.find((m) => m.title === 'Album')?.text
  if (!track.title || !track.subtitle) return null
  return {
    title: track.title,
    artist: track.subtitle,
    album: album || undefined,
    isrc: track.isrc || undefined,
  }
}

// shazam-api reverse-engineers Shazam's own app protocol (no official
// third-party API exists -- ShazamKit is Apple-platform-only), so this needs
// no API key/account at all. It wants raw 16kHz mono 16-bit PCM.
//
// Reads the sample rate out of the WAV header rather than assuming the
// client's TARGET_SAMPLE_RATE held (web/lib/wav-encode.ts) -- a prior
// version of this pipeline silently mismatched requested vs. rendered rate
// in a way that was hard to diagnose (looked like "no match" instead of a
// clear error), so this fails loudly instead of quietly feeding Shazam
// samples at the wrong speed.
export async function recognizeSong(wavBytes: Uint8Array): Promise<ShazamIdentifyResult | null> {
  if (wavBytes.length < 44) throw new Error('clip too small to contain a WAV header')
  const header = new DataView(wavBytes.buffer, wavBytes.byteOffset, 44)
  const sampleRate = header.getUint32(24, true)
  if (sampleRate !== EXPECTED_SAMPLE_RATE) {
    throw new Error(`expected a ${EXPECTED_SAMPLE_RATE}Hz clip, got ${sampleRate}Hz`)
  }

  const pcm = wavBytes.subarray(44)
  const samples = s16LEToSamplesArray(pcm)
  const shazam = new Shazam()
  const full = await shazam.fullRecognizeSong(samples)
  if (!full) return null
  return extractResult(full)
}
