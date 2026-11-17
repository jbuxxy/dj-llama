// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { useSSE } from '@/web/lib/hooks'

const close = vi.fn()
let lastSource: EventSource | null = null
const MockEventSource = vi.fn(function (this: EventSource, _url: string) {
  this.close = close
  lastSource = this
})

beforeEach(() => {
  vi.clearAllMocks()
  lastSource = null
  vi.stubGlobal('localStorage', {
    getItem: vi.fn(() => 'legacy-session-token'),
    removeItem: vi.fn(),
    setItem: vi.fn(),
  })
  vi.stubGlobal('EventSource', MockEventSource)
})

it('opens the exact same-origin SSE URL without a token query', () => {
  const { unmount } = renderHook(() => useSSE('/api/v1/realtime/events', { onMessage: vi.fn() }))

  expect(MockEventSource).toHaveBeenCalledWith('/api/v1/realtime/events')
  expect(String(MockEventSource.mock.calls[0]?.[0])).not.toContain('token=')

  unmount()
  expect(close).toHaveBeenCalledTimes(1)
})

it('delivers every message even when several arrive in the same tick', () => {
  const onMessage = vi.fn()
  renderHook(() => useSSE('/api/v1/realtime/events', { onMessage }))
  const source = lastSource as EventSource

  act(() => {
    source.onmessage?.({ data: JSON.stringify({ type: 'library-updated' }) } as MessageEvent)
    source.onmessage?.({ data: JSON.stringify({ type: 'activity-updated' }) } as MessageEvent)
    source.onmessage?.({ data: 'not json' } as MessageEvent)
  })

  expect(onMessage.mock.calls.map((c) => (c[0] as { type: string }).type)).toEqual([
    'library-updated',
    'activity-updated',
  ])
})

it('calls onReconnect only when the stream re-opens after dropping', () => {
  const onReconnect = vi.fn()
  renderHook(() => useSSE('/api/v1/realtime/events', { onMessage: vi.fn(), onReconnect }))
  const source = lastSource as EventSource

  act(() => source.onopen?.({} as Event))
  expect(onReconnect).not.toHaveBeenCalled()

  act(() => source.onerror?.({} as Event))
  act(() => source.onopen?.({} as Event))
  expect(onReconnect).toHaveBeenCalledTimes(1)
})
