import { Info, type LucideIcon, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { useClickOutside } from '../hooks/use-click-outside'
import { useHints } from '../hooks/use-hints'

type HintProps = {
  id: string
  type?: 'inline' | 'spotlight' | 'empty-state' | 'post-action'
  children: React.ReactNode
  className?: string
  /** Icon shown for the 'inline' trigger button. Defaults to the info glyph. */
  icon?: LucideIcon
  /** Extra classes applied directly to the 'inline' trigger icon (e.g. a rotation transition). */
  iconClassName?: string
}

export function Hint({
  id,
  type = 'inline',
  children,
  className = '',
  icon: Icon = Info,
  iconClassName = '',
}: HintProps) {
  const { isHintDismissed, dismissHint } = useHints()
  // Only used by the 'inline' branch below, but declared unconditionally
  // since hooks can't be called after an early return.
  const [open, setOpen] = useState(false)
  const tipRef = useRef<HTMLSpanElement>(null)
  useClickOutside(tipRef, () => setOpen(false), open)

  if (isHintDismissed(id)) return null

  if (type === 'inline') {
    // Desktop has a cursor, so plain CSS :hover (via the `group` wrapper)
    // reveals the tooltip with no JS at all. Touch devices don't reliably
    // fire hover, so the same icon also toggles `open` on tap -- that's
    // what shows the popup on mobile. One markup tree serves both instead
    // of branching on a media-query hook.
    return (
      <div className={`flex justify-end ${className}`}>
        <span ref={tipRef} className="group relative inline-flex">
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-label="Show tip"
            aria-expanded={open}
            className="shrink-0 p-0.5 text-muted hover:text-text transition-colors"
          >
            <Icon size={15} aria-hidden="true" className={iconClassName} />
          </button>
          <div
            role="tooltip"
            className={`absolute right-0 top-full z-20 mt-1.5 w-64 rounded-md border border-border bg-surface p-2.5 text-xs text-muted shadow-lg transition-opacity duration-150 md:group-hover:opacity-100 md:group-hover:pointer-events-auto ${
              open ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
            }`}
          >
            <div className="flex items-start gap-2">
              <span className="flex-1">{children}</span>
              <button
                type="button"
                onClick={() => {
                  setOpen(false)
                  dismissHint(id)
                }}
                aria-label="Dismiss hint"
                className="shrink-0 text-muted hover:text-text transition-colors"
              >
                <X size={12} aria-hidden="true" />
              </button>
            </div>
          </div>
        </span>
      </div>
    )
  }

  if (type === 'spotlight') {
    return (
      <div
        className={`flex items-start gap-2 px-3 py-2 rounded-md border border-accent/30 bg-accent/8 text-sm ${className}`}
      >
        <span className="flex-1 text-text">{children}</span>
        <button
          type="button"
          onClick={() => dismissHint(id)}
          aria-label="Dismiss hint"
          className="shrink-0 text-muted hover:text-text transition-colors"
        >
          <X size={13} aria-hidden="true" />
        </button>
      </div>
    )
  }

  if (type === 'empty-state') {
    return (
      <div className={`text-center space-y-3 py-6 ${className}`}>
        <div className="text-sm text-muted max-w-sm mx-auto">{children}</div>
        <button
          type="button"
          onClick={() => dismissHint(id)}
          className="text-xs text-muted hover:text-text transition-colors underline underline-offset-2"
        >
          Dismiss
        </button>
      </div>
    )
  }

  // post-action: toast-like
  return (
    <div
      className={`flex items-start gap-2 px-3 py-2 bg-surface border border-border rounded-lg text-sm ${className}`}
    >
      <span className="flex-1 text-text">{children}</span>
      <button
        type="button"
        onClick={() => dismissHint(id)}
        aria-label="Dismiss hint"
        className="shrink-0 text-muted hover:text-text transition-colors"
      >
        <X size={13} aria-hidden="true" />
      </button>
    </div>
  )
}
