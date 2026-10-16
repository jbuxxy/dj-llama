import { describe, expect, it, vi } from 'vitest'
import { throttledLidarrWrite, waitForLidarrIdle } from '@/core/targets/lidarr-throttle'

describe('waitForLidarrIdle', () => {
  it('waits until no artist refresh is queued or running', async () => {
    const getCommands = vi
      .fn()
      .mockResolvedValueOnce([{ name: 'RefreshArtist', status: 'started' }])
      .mockResolvedValueOnce([{ name: 'RefreshArtist', status: 'queued' }])
      .mockResolvedValueOnce([
        { name: 'RefreshArtist', status: 'completed' },
        { name: 'RssSync', status: 'started' },
      ])

    await waitForLidarrIdle(getCommands, { pollMs: 1, maxWaitMs: 1_000 })

    expect(getCommands).toHaveBeenCalledTimes(3)
  })

  it('treats a failing command-queue read as busy, and gives up at the deadline', async () => {
    const getCommands = vi.fn().mockRejectedValue(new Error('The operation was aborted.'))

    await waitForLidarrIdle(getCommands, { pollMs: 5, maxWaitMs: 30 })

    expect(getCommands.mock.calls.length).toBeGreaterThan(1)
  })
})

describe('throttledLidarrWrite', () => {
  it('runs writes to the same Lidarr one at a time, even if one throws', async () => {
    const idle = vi.fn().mockResolvedValue([])
    const order: string[] = []
    const task =
      (name: string, fail = false) =>
      async () => {
        order.push(`${name}:start`)
        await new Promise((r) => setTimeout(r, 5))
        order.push(`${name}:end`)
        if (fail) throw new Error(name)
        return name
      }

    const results = await Promise.allSettled([
      throttledLidarrWrite('http://lidarr', idle, task('a', true)),
      throttledLidarrWrite('http://lidarr', idle, task('b')),
    ])

    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end'])
    expect(results[0].status).toBe('rejected')
    expect(results[1]).toEqual({ status: 'fulfilled', value: 'b' })
  })
})
