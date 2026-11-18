// Fills listening_events from Plex's own play history, so users who never set
// up the Plex webhook (or plays from while DJ Llama was down) still count
// toward taste signals and recommendation outcomes. History only has
// completed plays -- skips are webhook-only.

import type { PlexRecentTrack } from '@/core/clients/plex'
import type { Database } from '@/db'
import {
  getLatestPlayedAt,
  getPlaysInWindow,
  type ListeningEventInput,
  recordListeningEvents,
} from '@/db/queries/listening-events'

export type HistoryReader = {
  getRecentlyPlayed(limit: number, offset: number): Promise<{ tracks: PlexRecentTrack[] }>
}

const PAGE_SIZE = 200
// First run per user: how far back to go. Later runs stop at the newest
// history-sourced play (not the newest webhook play -- a user who just set up
// the webhook still has older history to pull in).
const FIRST_RUN_MAX_PLAYS = 2000
// A webhook row's playedAt is when the play started (by our clock); Plex's
// viewedAt is when it finished. Same track within this window = same play.
const SAME_PLAY_WINDOW_MS = 15 * 60 * 1000

export async function backfillPlexHistory(
  db: Database,
  userId: number,
  reader: HistoryReader,
): Promise<number> {
  const latest = await getLatestPlayedAt(db, userId, 'history')
  const fresh: PlexRecentTrack[] = []
  for (let offset = 0; offset < FIRST_RUN_MAX_PLAYS; offset += PAGE_SIZE) {
    const { tracks } = await reader.getRecentlyPlayed(PAGE_SIZE, offset)
    let reachedKnown = false
    for (const t of tracks) {
      if (latest && t.viewedAt <= latest.getTime()) {
        reachedKnown = true
        break
      }
      fresh.push(t)
    }
    if (reachedKnown || tracks.length < PAGE_SIZE) break
  }
  if (fresh.length === 0) return 0

  const times = fresh.map((t) => t.viewedAt)
  const existing = await getPlaysInWindow(
    db,
    userId,
    new Date(Math.min(...times) - SAME_PLAY_WINDOW_MS),
    new Date(Math.max(...times) + SAME_PLAY_WINDOW_MS),
  )
  const rows: ListeningEventInput[] = fresh
    .filter(
      (t) =>
        !existing.some(
          (e) =>
            e.ratingKey === (t.ratingKey ?? null) &&
            Math.abs(e.playedAt.getTime() - t.viewedAt) <= SAME_PLAY_WINDOW_MS,
        ),
    )
    .map((t) => ({
      userId,
      ratingKey: t.ratingKey ?? null,
      artistName: t.artistName,
      trackName: t.trackName,
      albumName: t.albumTitle ?? null,
      durationMs: t.durationMs ?? null,
      listenedMs: t.durationMs ?? null,
      completed: true,
      skipped: false,
      source: 'history' as const,
      playedAt: new Date(t.viewedAt),
    }))
  return recordListeningEvents(db, rows)
}
