export type Mode = 'dark' | 'light' | 'system'

const MODE_KEY = 'djllama-theme'

// Keep backward compat: old 'dark'/'light' values still work as Mode
export function getStoredMode(): Mode {
  const stored = localStorage.getItem(MODE_KEY)
  if (stored === 'dark' || stored === 'light' || stored === 'system') return stored
  return 'system'
}

export function setStoredMode(mode: Mode): void {
  localStorage.setItem(MODE_KEY, mode)
}

export function resolveMode(mode: Mode): 'dark' | 'light' {
  if (mode === 'system') {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  }
  return mode
}

export function applyTheme(mode: Mode): void {
  document.documentElement.setAttribute('data-theme', `djllama-${resolveMode(mode)}`)
}
