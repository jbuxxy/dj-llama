import { ChevronDown } from 'lucide-react'
import { useRef, useState } from 'react'
import { useClickOutside } from '../hooks/use-click-outside'
import { Button } from './ui/button'

type AlbumApproveProps = {
  loading?: boolean
  fill?: boolean
  onApprove: () => void
  onApproveWholeDiscography: () => void
}

/**
 * Album-kind counterpart to <MonitoringOptions> -- for a specific-album
 * recommendation there's no whole-artist monitor scope to pick, so the
 * primary button just approves the one presented album. The secondary
 * dropdown keeps exactly one explicit action: expand to the whole artist's
 * discography (wired to PATCH .../recommendations/:id's expandToDiscography
 * flag), rather than showing the artist-oriented all/new/selected/popular/
 * none menu that doesn't apply to a single album.
 */
export function AlbumApprove({
  loading,
  fill,
  onApprove,
  onApproveWholeDiscography,
}: AlbumApproveProps) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  useClickOutside(containerRef, () => setOpen(false), open)

  return (
    <div ref={containerRef} className={`relative inline-flex ${fill ? 'w-full' : ''}`}>
      <Button
        size="sm"
        variant="outline"
        className={`rounded-r-none text-approve border-approve/40 hover:bg-approve/10 hover:text-approve border-r-0 ${fill ? 'flex-1 py-2 text-sm' : ''}`}
        disabled={loading}
        onClick={(e) => {
          e.stopPropagation()
          onApprove()
        }}
      >
        Approve
      </Button>
      <button
        type="button"
        disabled={loading}
        onClick={(e) => {
          e.stopPropagation()
          setOpen((v) => !v)
        }}
        className={`inline-flex items-center justify-center px-1.5 py-1.5 rounded-r-md text-xs border border-approve/40 text-approve hover:bg-approve/10 transition-colors disabled:pointer-events-none disabled:opacity-50 ${fill ? 'px-2 py-2' : ''}`}
        aria-label="More approve options"
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <ChevronDown size={14} aria-hidden="true" />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="More approve options"
          className="absolute right-0 bottom-full mb-1 z-50 bg-surface border border-border rounded-lg shadow-lg py-1 min-w-[220px]"
        >
          <button
            type="button"
            role="menuitem"
            onClick={(e) => {
              e.stopPropagation()
              setOpen(false)
              onApproveWholeDiscography()
            }}
            className="w-full text-left px-3 py-2 transition-colors hover:bg-bg/50"
          >
            <div className="text-sm text-text font-medium">Approve whole discography</div>
            <div className="text-xs text-muted mt-0.5">
              Add the whole artist and monitor every album, not just this one
            </div>
          </button>
        </div>
      )}
    </div>
  )
}
