import { useRef, useState } from 'react'

const PULL_THRESHOLD = 80

export function usePullToRefresh(onRefresh: () => void) {
  const [pullY, setPullY] = useState(0)
  const pullStartY = useRef(0)
  const pullActive = useRef(false)

  function handleTouchStart(e: React.TouchEvent) {
    const touch = e.touches[0]
    if (!touch) return
    if (window.scrollY === 0) {
      pullStartY.current = touch.clientY
      pullActive.current = true
    }
  }

  function handleTouchMove(e: React.TouchEvent) {
    if (!pullActive.current) return
    const touch = e.touches[0]
    if (!touch) return
    const dy = touch.clientY - pullStartY.current
    if (dy > 0) {
      setPullY(Math.min(dy, PULL_THRESHOLD + 20))
    }
  }

  function handleTouchEnd() {
    if (pullActive.current && pullY >= PULL_THRESHOLD) {
      onRefresh()
    }
    pullActive.current = false
    setPullY(0)
  }

  return {
    pullY,
    pullThreshold: PULL_THRESHOLD,
    handlers: {
      onTouchStart: handleTouchStart,
      onTouchMove: handleTouchMove,
      onTouchEnd: handleTouchEnd,
    },
  }
}
