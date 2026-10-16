// Plex sign-in normally opens in a new window while the app polls in this tab.
// That breaks in two cases, so the whole tab goes to Plex and comes back:
//  - framed (e.g. inside a dashboard launcher): Plex refuses to load in a frame
//  - car browsers (Tesla) have no real separate windows
export function usesSameTabPlexSignIn(): boolean {
  let framed = false
  try {
    framed = window.self !== window.top
  } catch {
    framed = true
  }
  return framed || /\bTesla\b/i.test(navigator.userAgent)
}

// When framed, navigate the top window (allowed after a user click); fall back
// to this frame if the embedder forbids it.
export function goTopLevel(url: string) {
  try {
    if (window.top && window.top !== window.self) {
      window.top.location.href = url
      return
    }
  } catch {
    // cross-origin top that blocks navigation: fall through
  }
  window.location.href = url
}

// Removes a one-shot marker (e.g. plexAuthReturn) from the address bar and
// reports whether it was there.
export function consumeQueryFlag(name: string): boolean {
  const params = new URLSearchParams(window.location.search)
  if (!params.has(name)) return false
  params.delete(name)
  const query = params.toString()
  window.history.replaceState(
    window.history.state,
    '',
    `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`,
  )
  return true
}
