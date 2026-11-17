import { useEffect, useRef, useState } from 'react'

type SSEHandlers = {
  /** Called for every message, in order -- never coalesced. */
  onMessage: (data: unknown) => void
  /** Called when the stream re-opens after having dropped. */
  onReconnect?: () => void
}

/**
 * EventSource wrapper. Messages go straight to a callback instead of into
 * React state: storing "the latest message" in state let React batch two
 * events that arrived in the same tick into one render, silently dropping
 * the first (e.g. a playlist-generated right after a library-updated).
 */
export function useSSE(url: string | null, handlers: SSEHandlers) {
  const [connected, setConnected] = useState(false)
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers

  useEffect(() => {
    if (!url) return
    const source = new EventSource(url)
    let everOpened = false
    let dropped = false
    source.onopen = () => {
      setConnected(true)
      if (everOpened && dropped) handlersRef.current.onReconnect?.()
      everOpened = true
      dropped = false
    }
    source.onmessage = (e) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(e.data as string)
      } catch {
        // Ignore malformed SSE messages (keep-alive pings, partial writes)
        return
      }
      handlersRef.current.onMessage(parsed)
    }
    source.onerror = () => {
      setConnected(false)
      dropped = true
    }
    return () => source.close()
  }, [url])

  return { connected }
}
