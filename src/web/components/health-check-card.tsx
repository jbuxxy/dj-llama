import { Music, Tag } from 'lucide-react'
import { useState } from 'react'
import type { HealthCheckItem, HealthCheckResult } from '../lib/api'
import { Button } from './ui/button'

const FIX_HINT_KEYS: Record<string, string> = {
  'missing-albums': 'Triggers an album search in Lidarr for each affected artist',
  'genre-gaps': 'Triggers a metadata refresh in Lidarr to fetch genre tags',
}

const CHECK_ICONS: Record<string, React.ReactNode> = {
  'missing-albums': <Music size={16} className="text-muted shrink-0" />,
  'genre-gaps': <Tag size={16} className="text-muted shrink-0" />,
}

function severitySurfaceClass(severity: HealthCheckResult['severity']): string {
  switch (severity) {
    case 'error':
      return 'border-reject/30 bg-reject/5'
    case 'warning':
      return 'border-warning/35 bg-warning/8'
    case 'info':
      return 'border-accent/30 bg-accent/5'
  }
}

function severityDotClass(severity: HealthCheckResult['severity']): string {
  switch (severity) {
    case 'error':
      return 'bg-reject'
    case 'warning':
      return 'bg-warning'
    case 'info':
      return 'bg-accent'
  }
}

function severityBadgeClass(severity: HealthCheckResult['severity']): string {
  switch (severity) {
    case 'error':
      return 'bg-reject/15 text-reject'
    case 'warning':
      return 'bg-warning/15 text-warning'
    case 'info':
      return 'bg-accent/15 text-accent'
  }
}

type Props = {
  check: HealthCheckResult
  onFix: (checkId: string) => void
  fixing: boolean
  lidarrBaseUrl?: string | null
}

const PREVIEW_COUNT = 5

export function HealthCheckCard({ check, onFix, fixing, lidarrBaseUrl }: Props) {
  const [expanded, setExpanded] = useState(false)

  const visibleItems: HealthCheckItem[] = expanded
    ? check.items
    : check.items.slice(0, PREVIEW_COUNT)
  const hasMore = check.items.length > PREVIEW_COUNT
  const fixDisabled = fixing || check.count === 0 || !check.fixable
  const fixHintKey = FIX_HINT_KEYS[check.id]

  return (
    <div
      className={`border ${severitySurfaceClass(check.severity)} rounded-lg p-4 flex flex-col gap-3`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-text flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className={`w-1.5 h-1.5 rounded-full shrink-0 ${severityDotClass(check.severity)}`}
            />
            {CHECK_ICONS[check.id]}
            {check.name}
          </p>
          <p className="text-xs text-muted mt-0.5">{check.description}</p>
        </div>
        <span
          className={`shrink-0 text-xs font-semibold px-2 py-0.5 rounded-full ${severityBadgeClass(check.severity)}`}
        >
          {check.count}
        </span>
      </div>

      {visibleItems.length > 0 && (
        <div className="bg-bg border border-border rounded divide-y divide-border text-xs">
          {visibleItems.map((item) => (
            <div
              key={`${item.mbid}-${item.artistId}`}
              className="flex items-center justify-between gap-2 px-3 py-2"
            >
              {lidarrBaseUrl ? (
                <a
                  href={`${lidarrBaseUrl.replace(/\/$/, '')}/artist/${item.mbid}`}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-accent underline truncate"
                  onClick={(e) => e.stopPropagation()}
                >
                  {item.artistName}
                </a>
              ) : (
                <span className="font-medium text-text truncate">{item.artistName}</span>
              )}
              <span className="text-muted text-right shrink-0 max-w-[55%] truncate">
                {item.detail}
              </span>
            </div>
          ))}
        </div>
      )}

      {hasMore && (
        <button
          type="button"
          className="text-xs text-accent underline text-left w-fit"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? 'Show less' : `Show all ${check.count}`}
        </button>
      )}

      {check.fixable && (
        <div className="pt-1 space-y-1.5">
          {fixHintKey && <p className="text-xs text-muted italic">{fixHintKey}</p>}
          <Button
            size="sm"
            variant="outline"
            disabled={fixDisabled}
            onClick={() => onFix(check.id)}
            className="text-xs"
          >
            {fixing ? 'Fixing...' : 'Fix'}
          </Button>
        </div>
      )}
    </div>
  )
}
