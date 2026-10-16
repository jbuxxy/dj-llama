// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createJobRecorder } from '@/core/jobs/recorder'
import type { Database } from '@/db'
import { getJobHealth } from '@/db/queries/jobs'
import { jobRuns } from '@/db/schema'
import { makeTestDb } from '../helpers/test-db'

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 })

let db: Database
let close: () => Promise<void>

beforeEach(async () => {
  const testDb = await makeTestDb()
  db = testDb.db as unknown as Database
  close = testDb.close
})

afterEach(async () => {
  await close()
})

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000)

function run(type: string, status: string, startedHoursAgo: number, extra: object = {}) {
  return {
    type,
    status,
    startedAt: hoursAgo(startedHoursAgo),
    completedAt: status === 'running' ? null : hoursAgo(startedHoursAgo - 0.5),
    metadata: {},
    ...extra,
  }
}

describe('getJobHealth', () => {
  it('reports never-run jobs without inventing a problem', async () => {
    const health = await getJobHealth(db, null)
    expect(health.discovery).toMatchObject({
      status: 'never',
      lastSuccessAt: null,
      lastProblem: null,
    })
    expect(health.sources).toEqual([])
  })

  it('ignores runs a restart interrupted', async () => {
    await db
      .insert(jobRuns)
      .values([run('pipeline', 'completed', 48), run('pipeline', 'interrupted', 2)])
    const health = await getJobHealth(db, null)
    expect(health.discovery.status).toBe('ok')
    expect(health.discovery.lastSuccessAt).not.toBeNull()
  })

  it('surfaces the error from a failed latest run', async () => {
    await db
      .insert(jobRuns)
      .values([
        run('library_sync', 'completed', 12),
        run('library_sync', 'failed', 1, { error: 'Plex unreachable' }),
      ])
    const health = await getJobHealth(db, null)
    expect(health.librarySync.status).toBe('failing')
    expect(health.librarySync.lastProblem?.error).toBe('Plex unreachable')
  })

  it('treats a few failed playlist refreshes among many as a warning', async () => {
    await db
      .insert(jobRuns)
      .values([
        run('playlist', 'completed', 3),
        run('playlist', 'completed', 2),
        run('playlist', 'failed', 1, { error: 'Timed out' }),
      ])
    const health = await getJobHealth(db, null)
    expect(health.playlists).toMatchObject({ status: 'warning', recentRuns: 3, recentFailures: 1 })
  })

  it('lists sources from the latest run, skipping unconfigured ones', async () => {
    await db.insert(jobRuns).values(
      run('pipeline', 'completed', 5, {
        sourceResults: {
          ai: { status: 'ok', artists: 12 },
          plex: { status: 'error', role: 'history', error: 'No listening history returned' },
          lastfm: { status: 'skipped', reason: 'not_configured' },
        },
      }),
    )
    const health = await getJobHealth(db, null)
    expect(health.sources).toEqual([
      { name: 'ai', ok: true, error: null, role: 'candidates', artists: 12 },
      {
        name: 'plex',
        ok: false,
        error: 'No listening history returned',
        role: 'history',
        artists: null,
      },
    ])
  })

  it("doesn't flag Plex from runs recorded before source roles existed", async () => {
    await db.insert(jobRuns).values(
      run('pipeline', 'completed', 5, {
        sourceResults: { plex: { status: 'error', error: 'No artists returned' } },
      }),
    )
    const health = await getJobHealth(db, null)
    expect(health.sources).toEqual([
      { name: 'plex', ok: true, error: null, role: 'history', artists: null },
    ])
  })
})

describe('markInterrupted', () => {
  it('closes out every running job left by the previous process', async () => {
    await db
      .insert(jobRuns)
      .values([run('pipeline', 'running', 0.1), run('playlist', 'completed', 1)])
    const marked = await createJobRecorder(db).markInterrupted()
    expect(marked).toBe(1)
    const rows = await db.select().from(jobRuns)
    const interrupted = rows.find((r) => r.type === 'pipeline')
    expect(interrupted?.status).toBe('interrupted')
    expect(interrupted?.completedAt).not.toBeNull()
  })
})
