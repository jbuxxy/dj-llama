// Plex's own music analysis as a second source for DJ ordering.
//
// What Plex exposes (checked against a real server, PMS 1.43):
//   - loudness / loudness range per track, for every track -> energy
//   - startRamp / endRamp: level vs. time over the first / last seconds
//     -> how long a track takes to come in and how long it fades out
//   - Gracenote mood tags ("Rousing", "Melancholy") -> energy hint
//   - sonic neighbors (/nearest) once Plex Pass sonic analysis has run ->
//     "these two sound alike", used as a transition cost
// Plex has no BPM or musical key, so our own analysis (features.ts) still
// supplies those. Plex's per-track voice flag is not used: it reads false
// on obviously vocal tracks.
//
// All of it is cheap metadata (no audio download), so it covers a whole
// playlist at generation time. Sonic neighbors appear on their own as
// Plex's analysis reaches tracks: unanalyzed tracks are re-checked daily.

import type { PlexClient, PlexTrackSonicInfo } from '@/core/clients/plex'
import type { Database } from '@/db'
import { getPlexSonic, type StoredPlexSonic, savePlexSonic } from '@/db/queries/plex-sonic'

type Ramp = Array<{ db: number; sec: number }>

export function parseRamp(raw: string | null | undefined): Ramp {
  if (!raw) return []
  return raw
    .split(';')
    .map((p) => p.trim().split(/\s+/).map(Number))
    .filter((p): p is [number, number] => p.length === 2 && p.every(Number.isFinite))
    .map(([db, sec]) => ({ db, sec }))
    .sort((a, b) => a.sec - b.sec)
}

// Levels in the ramps are relative to the track's own loudness; within 3 dB
// of it counts as "in".
const IN_DB = -3

/** Seconds from the start until the track reaches its normal level. */
export function introSeconds(raw: string | null | undefined): number | null {
  const ramp = parseRamp(raw)
  if (ramp.length === 0) return null
  return (ramp.find((p) => p.db >= IN_DB) ?? ramp[ramp.length - 1])?.sec ?? null
}

/** Seconds of fade before the end (the latest point still below normal level). */
export function outroSeconds(raw: string | null | undefined): number | null {
  const ramp = parseRamp(raw)
  if (ramp.length === 0) return null
  let fade = 0
  for (const p of ramp) if (p.db <= IN_DB) fade = Math.max(fade, p.sec)
  return fade
}

// Gracenote mood tags (the vocabulary Plex serves) -> energy lean, -1..1.
// Tags that say nothing about energy (Witty, Literate, Nostalgic) are absent.
const MOOD_ENERGY: Record<string, number> = {
  aggressive: 1,
  angry: 1,
  animated: 0.7,
  anthemic: 0.7,
  athletic: 1,
  belligerent: 1,
  boisterous: 1,
  bombastic: 0.8,
  bouncy: 0.7,
  brash: 0.8,
  celebratory: 0.8,
  confrontational: 0.8,
  driving: 1,
  ebullient: 0.8,
  ecstatic: 1,
  energetic: 1,
  euphoric: 0.9,
  exciting: 0.9,
  explosive: 1,
  exuberant: 0.9,
  feverish: 1,
  fierce: 1,
  fiery: 1,
  freewheeling: 0.5,
  fun: 0.5,
  giddy: 0.6,
  gleeful: 0.5,
  hostile: 0.9,
  hyper: 1,
  intense: 0.9,
  kinetic: 1,
  lively: 0.8,
  manic: 1,
  mighty: 0.6,
  motoric: 0.8,
  outraged: 0.9,
  powerful: 0.7,
  pulsing: 0.8,
  rambunctious: 1,
  raucous: 1,
  rebellious: 0.7,
  reckless: 0.8,
  rollicking: 0.8,
  rousing: 0.9,
  rowdy: 1,
  savage: 1,
  swaggering: 0.5,
  thrilling: 0.9,
  triumphant: 0.5,
  turbulent: 0.8,
  urgent: 0.8,
  visceral: 0.9,
  volatile: 0.8,
  cathartic: 0.5,
  defiant: 0.5,
  epic: 0.5,
  gutsy: 0.5,
  joyous: 0.5,
  playful: 0.3,
  sprightly: 0.5,
  striding: 0.3,
  tough: 0.5,
  uplifting: 0.3,
  airy: -0.5,
  atmospheric: -0.5,
  austere: -0.5,
  autumnal: -0.5,
  bleak: -0.5,
  brooding: -0.5,
  'calm/peaceful': -1,
  delicate: -1,
  dreamy: -0.8,
  ethereal: -0.8,
  funereal: -1,
  gentle: -1,
  'hymn-like': -0.5,
  intimate: -0.8,
  introspective: -0.5,
  languid: -1,
  'laid-back/mellow': -1,
  lazy: -1,
  lonely: -0.5,
  meditative: -1,
  melancholy: -0.7,
  pastoral: -0.8,
  plaintive: -0.5,
  reflective: -0.5,
  relaxed: -1,
  reserved: -0.5,
  restrained: -0.5,
  sad: -0.5,
  somber: -0.8,
  'soft/quiet': -1,
  soothing: -1,
  sparse: -0.5,
  spacey: -0.5,
  tender: -0.8,
  understated: -0.5,
  weary: -0.5,
  wistful: -0.5,
  wintry: -0.5,
  yearning: -0.3,
  reverent: -0.5,
  spiritual: -0.3,
  sentimental: -0.5,
  romantic: -0.3,
  smooth: -0.3,
  warm: -0.3,
  nocturnal: -0.3,
  hypnotic: -0.3,
}

/** Mean energy lean of the tags that carry one, -1..1; null when none do. */
export function moodLean(moods: string[]): number | null {
  const leans = moods.flatMap((m) => {
    const v = MOOD_ENERGY[m.toLowerCase()]
    return v == null ? [] : [v]
  })
  return leans.length ? leans.reduce((a, b) => a + b, 0) / leans.length : null
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x))

/**
 * 0..1 energy from Plex's data: integrated loudness (-20 LUFS quiet .. -6
 * LUFS slammed), nudged down by a wide loudness range (quiet passages), and
 * blended with the mood lean when there is one.
 */
export function plexEnergy(s: {
  loudness: number | null
  lra: number | null
  moods: string[]
}): number | null {
  const mood = moodLean(s.moods)
  if (s.loudness == null) return mood == null ? null : clamp01((mood + 1) / 2)
  let loud = clamp01((s.loudness + 20) / 14)
  if (s.lra != null) loud = clamp01(loud - Math.max(0, s.lra - 8) / 30)
  return mood == null ? loud : clamp01(0.55 * loud + 0.45 * ((mood + 1) / 2))
}

/** Our measured energy and Plex's, blended when both exist. */
export function combinedEnergy(
  audio: number | null | undefined,
  plex: number | null,
): number | null {
  if (audio != null && plex != null) return 0.6 * audio + 0.4 * plex
  return audio ?? plex
}

export function toStored(info: PlexTrackSonicInfo): Omit<StoredPlexSonic, 'fetchedAt'> {
  return {
    ratingKey: info.ratingKey,
    loudness: info.loudness,
    lra: info.lra,
    introSec: introSeconds(info.startRamp),
    outroSec: outroSeconds(info.endRamp),
    moods: info.moods.slice(0, 12),
    sonicAnalyzed: info.sonicAnalyzed,
  }
}

const DAY_MS = 24 * 60 * 60 * 1000
// Loudness and moods rarely change; a track Plex hasn't sonically analyzed
// yet is re-checked daily so neighbors switch on as the analysis progresses.
const ANALYZED_TTL_MS = 30 * DAY_MS
const PENDING_TTL_MS = DAY_MS

export function needsRefresh(row: StoredPlexSonic | undefined, now = Date.now()): boolean {
  if (!row) return true
  const age = now - row.fetchedAt.getTime()
  return age > (row.sonicAnalyzed ? ANALYZED_TTL_MS : PENDING_TTL_MS)
}

/** Plex analysis data for these tracks, fetching what's missing or stale. */
export async function refreshPlexSonic(
  db: Database,
  client: Pick<PlexClient, 'getTrackSonicInfo'>,
  ratingKeys: string[],
): Promise<Map<string, StoredPlexSonic>> {
  const keys = [...new Set(ratingKeys)]
  const stored = await getPlexSonic(db, keys)
  const stale = keys.filter((k) => needsRefresh(stored.get(k)))
  if (stale.length === 0) return stored
  try {
    const fresh = await client.getTrackSonicInfo(stale)
    await savePlexSonic(db, fresh.map(toStored))
  } catch (err) {
    // Stale data still orders a playlist fine; try again next time.
    console.warn('[plex-sonic] refresh failed:', err instanceof Error ? err.message : err)
    return stored
  }
  return getPlexSonic(db, keys)
}

// Neighbor lists per track, kept in memory: one /nearest call per track, and
// playlists regenerate at most daily. Empty answers (analysis still running)
// expire fast so neighbors show up soon after Plex finishes.
const NEIGHBOR_TTL_MS = 7 * DAY_MS
const EMPTY_TTL_MS = 6 * 60 * 60 * 1000
const NEIGHBOR_LIMIT = 250
// Plex's distances are roughly 0 (same) .. 1; Plexamp's "sonically similar"
// cuts at 0.25. Pairs beyond this are treated as unrelated.
export const SONIC_MAX_DISTANCE = 0.6
const neighborCache = new Map<string, { at: number; near: Map<string, number> }>()

export function clearSonicNeighborCache(): void {
  neighborCache.clear()
}

/**
 * Pairwise sonic distance between tracks of one playlist, from each
 * analyzed track's neighbor list. Pairs Plex doesn't list as neighbors
 * come back undefined (= not alike). Bounded by budgetMs.
 */
export async function sonicDistances(
  client: Pick<PlexClient, 'getSonicNeighbors'>,
  analyzedKeys: string[],
  opts: { budgetMs?: number; now?: number } = {},
): Promise<(a: string, b: string) => number | undefined> {
  const now = opts.now ?? Date.now()
  const todo = analyzedKeys.filter((k) => {
    const c = neighborCache.get(k)
    return !c || now - c.at > (c.near.size ? NEIGHBOR_TTL_MS : EMPTY_TTL_MS)
  })
  if (todo.length > 0) {
    const work = Promise.all(
      todo.map(async (k) => {
        try {
          const list = await client.getSonicNeighbors(k, {
            limit: NEIGHBOR_LIMIT,
            maxDistance: SONIC_MAX_DISTANCE,
          })
          neighborCache.set(k, {
            at: now,
            near: new Map(list.map((n) => [n.ratingKey, n.distance])),
          })
        } catch {
          // Leave uncached; the next playlist tries again.
        }
      }),
    )
    await Promise.race([work, new Promise((r) => setTimeout(r, opts.budgetMs ?? 10_000))])
  }
  return (a, b) => neighborCache.get(a)?.near.get(b) ?? neighborCache.get(b)?.near.get(a)
}

/** One track's sequencing inputs from both sources: our BPM/key, both energies, Plex's ramps. */
export function sequenceFeaturesFor(
  audio: { bpm: number | null; camelot: string | null; energy: number | null } | undefined,
  plex: StoredPlexSonic | undefined,
): {
  bpm: number | null
  camelot: string | null
  energy: number | null
  loudness: number | null
  introSec: number | null
  outroSec: number | null
} | null {
  if (!audio && !plex) return null
  return {
    bpm: audio?.bpm ?? null,
    camelot: audio?.camelot ?? null,
    energy: combinedEnergy(audio?.energy, plex ? plexEnergy(plex) : null),
    loudness: plex?.loudness ?? null,
    introSec: plex?.introSec ?? null,
    outroSec: plex?.outroSec ?? null,
  }
}
