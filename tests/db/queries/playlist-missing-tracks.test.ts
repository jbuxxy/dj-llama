// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { Database } from '@/db'
import { reconcilePlaylistMissingTracks } from '@/db/queries/playlist-missing-tracks'

function makeDb(existing: Array<Record<string, unknown>> = []) {
  const inserted: Array<Record<string, unknown>> = []
  const tx = {
    select: () => ({ from: () => ({ where: () => Promise.resolve(existing) }) }),
    delete: () => ({ where: vi.fn().mockResolvedValue(undefined) }),
    update: () => ({ set: () => ({ where: vi.fn().mockResolvedValue(undefined) }) }),
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        inserted.push(row)
        return Promise.resolve()
      },
    }),
  }
  const db = {
    transaction: (fn: (t: typeof tx) => Promise<void>) => fn(tx),
  } as unknown as Database
  return { db, inserted }
}

describe('reconcilePlaylistMissingTracks', () => {
  it('inserts one row per artist/track even when the run lists it twice', async () => {
    // e.g. "Kiss" and "Kiss - Live" both reduce to "Kiss" before matching.
    const { db, inserted } = makeDb()

    await reconcilePlaylistMissingTracks(db, 1, [
      { artistName: 'Prince', trackName: 'Kiss' },
      { artistName: 'Prince', trackName: 'Kiss', albumTitle: 'Live' },
      { artistName: 'prince', trackName: 'KISS' },
      { artistName: 'Prince', trackName: 'Purple Rain' },
    ])

    expect(inserted.map((r) => r.trackName)).toEqual(['Kiss', 'Purple Rain'])
  })
})
