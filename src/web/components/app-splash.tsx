import { useEffect, useState } from 'react'

/**
 * Shown while auth/setup status resolve on a cold load -- replaces the
 * blank screen the app used to render through several sequential requests.
 * Mirrors the static splash baked into index.html's #root, so the handoff
 * from "HTML loaded" to "React mounted" doesn't flicker.
 */
export function AppSplash() {
  // Only mention the wait if it's actually noticeable.
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 1500)
    return () => clearTimeout(t)
  }, [])
  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center gap-3 bg-bg"
      role="status"
      aria-live="polite"
    >
      <img src="/icon.png" alt="" width="64" height="64" className="animate-pulse" />
      <p className="text-2xl font-display tracking-wide text-accent">DJ LLAMA</p>
      <p className={`text-xs text-muted transition-opacity ${slow ? 'opacity-100' : 'opacity-0'}`}>
        Connecting to your server...
      </p>
    </div>
  )
}
