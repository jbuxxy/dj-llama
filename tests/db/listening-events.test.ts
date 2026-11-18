// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlexRecentTrack } from '@/core/clients/plex'
import { backfillPlexHistory } from '@/core/listening/history-backfill'
import type { Database } from '@/db'
import {
  getRecentPlays,
  getTrackSkipStats,
  pruneListeningEvents,
  recordListeningEvent,
} from '@/db/queries/listening-events'
import { users } from '@/db/schema'
import { makeTestDb } from '../helpers/test-db'

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 })

let db: Database
let close: () => Promise<void>
let userId: number

beforeEach(async () => {
  const t = await makeTestDb()
  db = t.db as unknown as Database
  close = t.close
  const [u] = await db
    .insert(users)
    .values({ username: 'listener', passwordHash: 'x' })
    .returning({ id: users.id })
  userId = u?.id as number
})

afterEach(async () => close())

const HOUR = 60 * 60 * 1000

function reader(tracks: PlexRecentTrack[]) {
  return {
    getRecentlyPlayed: vi.fn(async (limit: number, offset: number) => ({
      tracks: tracks.slice(offset, offset + limit),
    })),
  }
}

describe('listening events', () => {
  it('getRecentPlays returns completed plays only, newest first', async () => {
    const base = { userId, artistName: 'A', source: 'webhook' as const }
    await recordListeningEvent(db, {
      ...base,
      ratingKey: '1',
      trackName: 'old',
      completed: true,
      skipped: false,
      playedAt: new Date(Date.now() - 2 * HOUR),
    })
    await recordListeningEvent(db, {
      ...base,
      ratingKey: '2',
      trackName: 'skipped',
      completed: false,
      skipped: true,
      playedAt: new Date(Date.now() - HOUR),
    })
    await recordListeningEvent(db, {
      ...base,
      ratingKey: '3',
      trackName: 'new',
      completed: true,
      skipped: false,
      playedAt: new Date(),
    })
    expect((await getRecentPlays(db, userId)).map((p) => p.trackName)).toEqual(['new', 'old'])
    const stats = await getTrackSkipStats(db, userId, ['2', '3'], new Date(0))
    expect(stats.get('2')).toEqual({ plays: 1, skips: 1 })
    expect(stats.get('3')).toEqual({ plays: 1, skips: 0 })
  })

  it('backfills Plex history once, skipping plays the webhook already recorded', async () => {
    const now = Date.now()
    // The webhook saw track 10 start 4 minutes before Plex logged it finished.
    await recordListeningEvent(db, {
      userId,
      ratingKey: '10',
      artistName: 'A',
      trackName: 'Hooked',
      completed: true,
      skipped: false,
      source: 'webhook',
      playedAt: new Date(now - 4 * 60 * 1000),
    })
    const history: PlexRecentTrack[] = [
      { ratingKey: '10', artistName: 'A', trackName: 'Hooked', viewedAt: now },
      { ratingKey: '11', artistName: 'B', trackName: 'Only in history', viewedAt: now - HOUR },
    ]
    expect(await backfillPlexHistory(db, userId, reader(history))).toBe(1)
    // A second run inserts nothing new.
    expect(await backfillPlexHistory(db, userId, reader(history))).toBe(0)
    const plays = await getRecentPlays(db, userId)
    expect(plays.map((p) => p.trackName).sort()).toEqual(['Hooked', 'Only in history'])
  })

  it('prunes by age', async () => {
    await recordListeningEvent(db, {
      userId,
      ratingKey: '1',
      artistName: 'A',
      trackName: 'ancient',
      completed: true,
      skipped: false,
      source: 'history',
      playedAt: new Date('2020-01-01'),
    })
    expect(await pruneListeningEvents(db, new Date('2021-01-01'))).toBe(1)
  })
})
