// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { realtimeBroker } from '@/core/realtime/broker'
import { notifyUsers } from '@/db/queries/change-events'

describe('notifyUsers', () => {
  afterEach(() => vi.restoreAllMocks())

  it('publishes once per distinct user and skips missing owners', () => {
    const publish = vi.spyOn(realtimeBroker, 'publish')
    notifyUsers([3, 3, null, undefined, 5], { type: 'activity-updated' })
    expect(publish.mock.calls.map(([id]) => id)).toEqual([3, 5])
  })
})
