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

// Two ffmpeg processes at once: decoding is cheap, but this shares the box
// with Plex and everything else.
const queue = new PQueue({ concurrency: 2 })
const inFlight = new Map<string, Promise<void>>()

async function analyzeOne(
  db: Database,
  track: AnalyzableTrack,
  plex: PlexConnection,
): Promise<void> {
  try {
    const samples = await decodeExcerpt({ ...plex, partKey: track.partKey }, track.durationMs)
    const features = analyzeSamples(samples)
    await saveTrackFeatures(db, { ...track, features })
  } catch (err) {
    await saveTrackFeatures(db, {
      ...track,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
    })
  }
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

function needsAnalysis(track: AnalyzableTrack, stored: StoredTrackFeatures | undefined): boolean {
  // Re-analyze when Plex points at a different file; failures aren't retried
  // until the file changes.
  return !stored || stored.partKey !== track.partKey
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
