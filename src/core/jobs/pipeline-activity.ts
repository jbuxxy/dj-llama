import type { PipelineOrchestrator } from '@/core/pipeline/orchestrator'
import { errMsg } from '@/core/validation'
import type { ActivityTracker } from './activity'

type QueueEvent = { userId: number | undefined; position: number }
type Progress = {
  userId?: number
  stage?: string
  message?: string
  current?: number
  total?: number
}

const LABEL = 'Discovery scan'

/**
 * Mirrors the (single, global) pipeline orchestrator's events into each
 * owner's activity feed. Scoped per user: progress carries the run's userId
 * (orchestrator.emit injects it), so nobody sees anyone else's scan -- unlike
 * the legacy /pipeline/events stream, which broadcast every run to everyone.
 */
export function bridgePipelineActivity(
  orchestrator: PipelineOrchestrator,
  tracker: ActivityTracker,
): void {
  const ensure = (userId: number) =>
    tracker.findActive(userId, 'pipeline') ??
    tracker.start(userId, { kind: 'pipeline', label: LABEL, stage: 'collect' })

  orchestrator.on('queued', ({ userId, position }: QueueEvent) => {
    if (userId == null) return
    const patch = {
      status: 'queued' as const,
      queuePosition: position,
      message: 'Waiting for another scan to finish',
    }
    const existing = tracker.findActive(userId, 'pipeline')
    if (existing) existing.update(patch)
    else tracker.start(userId, { kind: 'pipeline', label: LABEL, ...patch })
  })

  orchestrator.on('queue-changed', (entries: QueueEvent[]) => {
    for (const { userId, position } of entries) {
      if (userId == null) continue
      tracker.findActive(userId, 'pipeline')?.update({ queuePosition: position })
    }
  })

  orchestrator.on('started', ({ userId }: { userId: number | undefined }) => {
    if (userId == null) return
    ensure(userId).update({
      status: 'running',
      queuePosition: undefined,
      stage: 'collect',
      message: 'Starting scan...',
    })
  })

  orchestrator.on('progress', (p: Progress) => {
    if (p?.userId == null) return
    const job = ensure(p.userId)
    if (p.stage === 'complete') {
      job.done({
        stage: 'complete',
        message: p.message,
        resultSummary: p.message,
        resultHref: '/discover',
        current: undefined,
        total: undefined,
      })
      return
    }
    job.update({
      status: 'running',
      queuePosition: undefined,
      ...(p.stage ? { stage: p.stage } : {}),
      ...(p.message ? { message: p.message } : {}),
      // Always overwrite: a stage without counts must clear the last stage's.
      current: p.current,
      total: p.total,
    })
  })

  orchestrator.on('error', (err: unknown) => {
    const userId = orchestrator.currentUserId
    if (userId == null) return
    tracker.findActive(userId, 'pipeline')?.fail(errMsg(err))
  })
}
