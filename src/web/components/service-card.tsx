import { ChevronDown } from 'lucide-react'
import type * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { Button } from './ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from './ui/card'

type ServiceStatus = 'connected' | 'not_configured' | 'error' | 'testing'

export type ServiceCardProps = {
  name: string
  description?: React.ReactNode
  status: ServiceStatus
  icon?: React.ReactNode
  onTest?: () => void
  children: React.ReactNode
  /**
   * When provided, renders an enable/disable switch in the header. Turning it
   * off is expected to clear the underlying connection (see each card's
   * onEnabledChange handler) -- off always means fully hidden (no status, no
   * chevron, nothing to expand). Omit entirely for a connection that's
   * always-on / required and can't be disabled from here (e.g. Lidarr).
   */
  enabled?: boolean
  onEnabledChange?: (enabled: boolean) => void
}

function EnableToggle({
  enabled,
  onChange,
}: {
  enabled: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={enabled ? 'Disable' : 'Enable'}
      onClick={() => onChange(!enabled)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2 ${
        enabled ? 'bg-accent' : 'bg-border'
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
          enabled ? 'translate-x-6' : 'translate-x-1'
        }`}
      />
    </button>
  )
}

function StatusIndicator({ status }: { status: ServiceStatus }) {
  if (status === 'testing') {
    return (
      <span className="flex items-center gap-1.5 text-xs text-muted">
        <span className="inline-block h-2 w-2 rounded-full bg-muted animate-pulse" />
        Testing...
      </span>
    )
  }

  const dot: Record<Exclude<ServiceStatus, 'testing'>, string> = {
    connected: 'bg-approve',
    not_configured: 'bg-muted',
    error: 'bg-reject',
  }

  const statusLabel: Record<Exclude<ServiceStatus, 'testing'>, string> = {
    connected: 'Connected',
    not_configured: 'Not configured',
    error: 'Error',
  }

  const textColor: Record<Exclude<ServiceStatus, 'testing'>, string> = {
    connected: 'text-approve',
    not_configured: 'text-muted',
    error: 'text-reject',
  }

  return (
    <span className={`flex items-center gap-1.5 text-xs ${textColor[status]}`}>
      <span className={`inline-block h-2 w-2 rounded-full ${dot[status]}`} />
      {statusLabel[status]}
    </span>
  )
}

// Every card follows one of two header shapes: an enable/disable toggle (for
// optional services -- off means genuinely disconnected, not just hidden), or
// a plain "Connected *" status + chevron (for always-on/required services
// with nothing to disable, e.g. Lidarr). Either way, the body's open/closed
// state is independent of "enabled" and always starts collapsed -- a
// service being connected is not a reason to dump its whole form open on
// every page load. The one exception: flipping an optional service's toggle
// from off to on auto-expands once, so there's somewhere to type into.
export function ServiceCard({
  name,
  description,
  status,
  icon,
  onTest,
  children,
  enabled,
  onEnabledChange,
}: ServiceCardProps) {
  const [open, setOpen] = useState(false)
  const prevEnabled = useRef(enabled)

  useEffect(() => {
    if (enabled && !prevEnabled.current) setOpen(true)
    prevEnabled.current = enabled
  }, [enabled])

  const disabled = enabled === false
  const bodyHidden = disabled || !open

  return (
    <Card>
      <CardHeader className="pt-3 pb-3">
        <div className="flex items-center justify-between gap-3">
          <CardTitle>
            <span className="flex items-center gap-2">
              {icon}
              {name}
            </span>
          </CardTitle>
          <div className="flex items-center gap-3">
            {!disabled && <StatusIndicator status={status} />}
            {onEnabledChange && (
              <EnableToggle enabled={enabled ?? false} onChange={onEnabledChange} />
            )}
            {!disabled && (
              <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                aria-expanded={open}
                aria-label={`${open ? 'Collapse' : 'Expand'} ${name}`}
                className="text-muted hover:text-text"
              >
                <ChevronDown
                  className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`}
                />
              </button>
            )}
          </div>
        </div>
        {!bodyHidden && description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      {!bodyHidden && (
        <>
          <CardContent className="space-y-3">{children}</CardContent>
          {onTest && (
            <CardFooter>
              <Button variant="outline" size="sm" onClick={onTest} disabled={status === 'testing'}>
                Test Connection
              </Button>
            </CardFooter>
          )}
        </>
      )}
    </Card>
  )
}
