// @vitest-environment node

import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { type ActivityJob, ActivityTracker, trackActivity } from '@/core/jobs/activity'
import { bridgePipelineActivity } from '@/core/jobs/pipeline-activity'
import type { PipelineOrchestrator } from '@/core/pipeline/orchestrator'

function makeTracker() {
  const published: Array<{ userId: number; job: ActivityJob }> = []
  let now = 1_000_000
  const tracker = new ActivityTracker(
    (userId, job) => published.push({ userId, job }),
    () => now,
  )
  return {
    tracker,
    published,
    advance: (ms: number) => {
      now += ms
    },
  }
}

describe('ActivityTracker', () => {
  it('publishes start, progress and completion to the owning user only', () => {
    const { tracker, published, advance } = makeTracker()
    const job = tracker.start(1, { kind: 'library_sync', label: 'Syncing library' })
    advance(1000)
    job.update({ message: 'Halfway', current: 5, total: 10 })
    advance(1000)
    job.done({ resultSummary: 'Library is up to date' })

    expect(published.every((p) => p.userId === 1)).toBe(true)
    expect(published.map((p) => p.job.status)).toEqual(['running', 'running', 'done'])
    expect(published.at(-1)?.job.resultSummary).toBe('Library is up to date')
    expect(published.at(-1)?.job.finishedAt).toBeDefined()
    expect(tracker.list(2)).toEqual([])
    expect(tracker.list(1)).toHaveLength(1)
  })

  it('coalesces rapid progress updates but never drops status changes', () => {
    vi.useFakeTimers()
    try {
      const { tracker, published } = makeTracker()
      const job = tracker.start(1, { kind: 'pipeline', label: 'Scan' })
      for (let i = 1; i <= 20; i++) job.update({ current: i, total: 20 })
      // Start + throttled updates, far fewer than 21
      expect(published.length).toBeLessThan(5)
      job.done()
      expect(published.at(-1)?.job.status).toBe('done')
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores late updates after a job finished', () => {
    const { tracker } = makeTracker()
    const job = tracker.start(1, { kind: 'playlist', label: 'Daily Mix', ref: '7' })
    job.fail('Plex unreachable')
    job.update({ status: 'running', message: 'stray' })
    const [listed] = tracker.list(1)
    expect(listed?.status).toBe('error')
    expect(listed?.message).toBe('Plex unreachable')
    expect(tracker.findActive(1, 'playlist', '7')).toBeNull()
  })

  it('prunes finished jobs after the retention window', () => {
    const { tracker, advance } = makeTracker()
    tracker.start(1, { kind: 'artist_rescan', label: 'Rescan' }).done()
    advance(11 * 60 * 1000)
    expect(tracker.list(1)).toEqual([])
  })

  it('trackActivity runs untracked without a user', async () => {
    await expect(
      trackActivity(undefined, { kind: 'bulk_action', label: 'x' }, async (job) => job),
    ).resolves.toBeNull()
  })
})

describe('bridgePipelineActivity', () => {
  function setup() {
    const { tracker, published } = makeTracker()
    const orchestrator = new EventEmitter() as unknown as PipelineOrchestrator & EventEmitter
    Object.defineProperty(orchestrator, 'currentUserId', { value: 1, writable: true })
    bridgePipelineActivity(orchestrator, tracker)
    return { tracker, published, orchestrator }
  }

  it('turns a queued run into a running one, then a finished one with a result link', () => {
    const { tracker, orchestrator } = setup()
    orchestrator.emit('queued', { userId: 2, position: 1 })
    expect(tracker.list(2)[0]).toMatchObject({ status: 'queued', queuePosition: 1 })

    orchestrator.emit('started', { userId: 2 })
    orchestrator.emit('progress', { userId: 2, stage: 'resolve', current: 3, total: 9 })
    expect(tracker.list(2)[0]).toMatchObject({
      status: 'running',
      stage: 'resolve',
      current: 3,
      total: 9,
    })

    orchestrator.emit('progress', { userId: 2, stage: 'complete', message: 'Done! 4 new' })
    expect(tracker.list(2)[0]).toMatchObject({
      status: 'done',
      resultHref: '/discover',
      resultSummary: 'Done! 4 new',
    })
    expect(tracker.list(2)).toHaveLength(1)
  })

  it("never shows one user's scan to another", () => {
    const { tracker, orchestrator } = setup()
    orchestrator.emit('started', { userId: 1 })
    orchestrator.emit('progress', { userId: 1, stage: 'analyze' })
    expect(tracker.list(1)).toHaveLength(1)
    expect(tracker.list(2)).toEqual([])
  })

  it('fails the running job on error', () => {
    const { tracker, orchestrator } = setup()
    orchestrator.emit('started', { userId: 1 })
    orchestrator.emit('error', new Error('AI provider down'))
    expect(tracker.list(1)[0]).toMatchObject({ status: 'error', message: 'AI provider down' })
  })
})
