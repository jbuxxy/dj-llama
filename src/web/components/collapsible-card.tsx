import { ChevronDown, ChevronRight } from 'lucide-react'
import { useState } from 'react'

export function CollapsibleCard({
  title,
  subtitle,
  headerExtra,
  children,
  defaultCollapsed = false,
}: {
  title: string
  subtitle?: string
  headerExtra?: React.ReactNode
  children: React.ReactNode
  defaultCollapsed?: boolean
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed)
  return (
    <div className="bg-surface border border-border rounded-lg p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="flex items-start gap-2 text-left flex-1 min-w-0"
          aria-expanded={!collapsed}
        >
          {collapsed ? (
            <ChevronRight size={16} className="mt-0.5 shrink-0 text-muted" aria-hidden="true" />
          ) : (
            <ChevronDown size={16} className="mt-0.5 shrink-0 text-muted" aria-hidden="true" />
          )}
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-text">{title}</h2>
            {subtitle && <p className="text-xs text-muted mt-0.5 max-w-2xl">{subtitle}</p>}
          </div>
        </button>
        {headerExtra && <div className="shrink-0">{headerExtra}</div>}
      </div>
      {!collapsed && children}
    </div>
  )
}
