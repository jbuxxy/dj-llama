// Runs audio analysis for tracks that need it, a couple at a time, and hands
// back whatever features are known. Playlist generation calls ensureFeatures
// with a time budget: tracks analyzed in time get DJ ordering, the rest keep
// their shuffled slots and are picked up by the nightly crawl.

import PQueue from 'p-queue'
import type { Database } from '@/db'
import {
  getTrackFeatures,
  type StoredTrackFeatures,
  saveTrackFeatures,
} from '@/db/queries/track-features'
import { decodeExcerpt } from './decode'
import { analyzeSamples } from './features'

export type AnalyzableTrack = { ratingKey: string; partKey: string; durationMs?: number | null }
export type PlexConnection = { plexUrl: string; token: string }

// One track at a time. Measured against a real Plex server: two overlapping
// file reads already draw 503s and connection resets, one at a time is clean.
const queue = new PQueue({ concurrency: 1 })
const inFlight = new Map<string, Promise<void>>()

// Plex drops connections when several reads overlap, which surfaces as an
// ffmpeg I/O error or a truncated (too short) excerpt -- worth a retry.
const ATTEMPTS = 3
const RETRY_DELAYS_MS = [2_000, 6_000]

async function analyzeOne(
  db: Database,
  track: AnalyzableTrack,
  plex: PlexConnection,
  retryDelaysMs: number[] = RETRY_DELAYS_MS,
): Promise<void> {
  let lastErr: unknown
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    try {
      const samples = await decodeExcerpt({ ...plex, partKey: track.partKey }, track.durationMs)
      const features = analyzeSamples(samples)
      await saveTrackFeatures(db, { ...track, features })
      return
    } catch (err) {
      lastErr = err
      const delay = retryDelaysMs[attempt]
      if (delay == null) break
      await new Promise((r) => setTimeout(r, delay))
    }
  }
  await saveTrackFeatures(db, {
    ...track,
    error: (lastErr instanceof Error ? lastErr.message : String(lastErr)).slice(0, 300),
  })
}

function schedule(db: Database, track: AnalyzableTrack, plex: PlexConnection, priority: number) {
  const existing = inFlight.get(track.ratingKey)
  if (existing) return existing
  const p = queue
    .add(() => analyzeOne(db, track, plex), { priority })
    .then(() => undefined)
    .finally(() => inFlight.delete(track.ratingKey))
  inFlight.set(track.ratingKey, p)
  return p
}

// A failed track is retried after this long (or as soon as its file changes).
const ERROR_RETRY_MS = 7 * 24 * 60 * 60 * 1000

export function needsAnalysis(
  track: AnalyzableTrack,
  stored: StoredTrackFeatures | undefined,
  now = Date.now(),
): boolean {
  if (!stored || stored.partKey !== track.partKey) return true
  return stored.error != null && now - stored.analyzedAt.getTime() > ERROR_RETRY_MS
}

/**
 * Features for these tracks, analyzing the missing ones first -- waits at
 * most `budgetMs`, then returns whatever is known (analysis that didn't
 * finish keeps going in the background and is stored for next time).
 */
export async function ensureFeatures(
  db: Database,
  tracks: AnalyzableTrack[],
  plex: PlexConnection,
  opts: { budgetMs?: number; max?: number } = {},
): Promise<Map<string, StoredTrackFeatures>> {
  const keys = tracks.map((t) => t.ratingKey)
  const stored = await getTrackFeatures(db, keys)
  const missing = tracks
    .filter((t) => needsAnalysis(t, stored.get(t.ratingKey)))
    .slice(0, opts.max ?? 30)
  if (missing.length > 0) {
    const work = Promise.all(missing.map((t) => schedule(db, t, plex, 1)))
    await Promise.race([work, new Promise((r) => setTimeout(r, opts.budgetMs ?? 20_000))])
    return getTrackFeatures(db, keys)
  }
  return stored
}

/** Background crawl: analyzes what's missing at low priority. Resolves when done. */
export async function analyzeInBackground(
  db: Database,
  tracks: AnalyzableTrack[],
  plex: PlexConnection,
): Promise<number> {
  const stored = await getTrackFeatures(
    db,
    tracks.map((t) => t.ratingKey),
  )
  const missing = tracks.filter((t) => needsAnalysis(t, stored.get(t.ratingKey)))
  await Promise.all(missing.map((t) => schedule(db, t, plex, 0)))
  return missing.length
}
