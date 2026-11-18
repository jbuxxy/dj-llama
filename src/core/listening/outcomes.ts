// "Did it stick?" -- after a recommendation lands in the library, watch the
// user's plays for OUTCOME_WINDOW_DAYS and label it:
// - keeper:   KEEPER_PLAYS+ completed plays on KEEPER_DAYS+ distinct days
//             (decided as soon as it's reached, even mid-window)
// - tried:    at least one play by the end of the window
// - unplayed: nothing by the end of the window
// Plays join to recommendations by normalized artist name (plays carry no
// MBIDs); album recommendations count plays from that album only.

import { normalizeAlbumTitle, normalizeArtistName } from '@/core/library/normalize'
import type { Database } from '@/db'
import {
  getLearnedWeights,
  listOutcomeCandidates,
  listPlaysSince,
  listTrainingRows,
  type OutcomeCandidate,
  type OutcomeUpdate,
  type PlayForOutcome,
  setLearnedWeights,
  setOutcomes,
  type TrainingRow,
} from '@/db/queries/outcomes'
import type { RecommendationOutcome, ScoringWeights } from '@/db/schema'
import { fitWeights, type TrainingSample } from './learn-weights'

export const OUTCOME_WINDOW_DAYS = 30
export const KEEPER_PLAYS = 5
export const KEEPER_DAYS = 2
const DAY_MS = 24 * 60 * 60 * 1000

export function classifyOutcome(
  plays: PlayForOutcome[],
  confirmedAt: Date,
  now: Date,
): { outcome: RecommendationOutcome; plays: number; skipRate: number | null } | null {
  const end = confirmedAt.getTime() + OUTCOME_WINDOW_DAYS * DAY_MS
  const inWindow = plays.filter((p) => {
    const t = p.playedAt.getTime()
    return t >= confirmedAt.getTime() && t <= end
  })
  const completed = inWindow.filter((p) => p.completed)
  const days = new Set(completed.map((p) => Math.floor(p.playedAt.getTime() / DAY_MS)))
  const skipRate =
    inWindow.length > 0 ? inWindow.filter((p) => p.skipped).length / inWindow.length : null
  const summary = { plays: completed.length, skipRate }
  if (completed.length >= KEEPER_PLAYS && days.size >= KEEPER_DAYS)
    return { outcome: 'keeper', ...summary }
  if (now.getTime() < end) return null
  return { outcome: completed.length > 0 ? 'tried' : 'unplayed', ...summary }
}

export function matchPlays(candidate: OutcomeCandidate, plays: PlayForOutcome[]): PlayForOutcome[] {
  const artist = normalizeArtistName(candidate.artistName)
  const album =
    candidate.kind === 'album' && candidate.albumTitle
      ? normalizeAlbumTitle(candidate.albumTitle)
      : null
  return plays.filter(
    (p) =>
      normalizeArtistName(p.artistName) === artist &&
      (album == null || (p.albumName != null && normalizeAlbumTitle(p.albumName) === album)),
  )
}

export function toTrainingSamples(rows: TrainingRow[]): TrainingSample[] {
  return rows.flatMap((r) => {
    if (!r.sources) return []
    const target = r.outcome === 'keeper' ? 1 : r.outcome === 'tried' ? 0.5 : 0
    return [{ components: r.sources as Partial<Record<keyof ScoringWeights, number>>, target }]
  })
}

/** Labels this user's ready outcomes, then refits their learned weights. */
export async function updateUserOutcomes(
  db: Database,
  userId: number,
  now = new Date(),
): Promise<{ labeled: number; samples: number }> {
  const candidates = await listOutcomeCandidates(db, userId)
  let labeled = 0
  if (candidates.length > 0) {
    const since = new Date(Math.min(...candidates.map((c) => c.confirmedAt.getTime())))
    const plays = await listPlaysSince(db, userId, since)
    const updates: OutcomeUpdate[] = []
    for (const c of candidates) {
      const result = classifyOutcome(matchPlays(c, plays), c.confirmedAt, now)
      if (result) updates.push({ id: c.id, ...result })
    }
    await setOutcomes(db, userId, updates)
    labeled = updates.length
  }

  const samples = toTrainingSamples(await listTrainingRows(db, userId))
  const fitted = fitWeights(samples)
  if (fitted) {
    await setLearnedWeights(db, userId, {
      weights: fitted,
      samples: samples.length,
      fittedAt: now.toISOString(),
    })
  } else if (await getLearnedWeights(db, userId)) {
    await setLearnedWeights(db, userId, null)
  }
  return { labeled, samples: samples.length }
}
