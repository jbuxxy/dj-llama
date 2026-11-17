import { useState } from 'react'
import { errMsg, isValidMbid } from '@/core/validation'
import type { LibraryUnreconciledAlbumRow, LibraryUnreconciledRow } from '../lib/api'
import { rerunLibraryReconciler, saveLibraryAlbumOverride, saveLibraryOverride } from '../lib/api'

const BUTTON_CLASS =
  'text-sm px-3 py-1 border border-border rounded hover:opacity-90 disabled:opacity-50 transition-opacity'

/**
 * One unmatched library item with "pin this MBID" / "ignore forever"
 * controls. `save(mbid)` writes the override (null = ignore); the
 * reconciler is re-run afterwards so the row drops off on success.
 */
function UnreconciledOverrideRow({
  title,
  subtitle,
  placeholder,
  save,
  onResolved,
}: {
  title: string
  subtitle: string
  placeholder: string
  save: (mbid: string | null) => Promise<unknown>
  onResolved: () => void
}) {
  const [mbidInput, setMbidInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function apply(mbid: string | null) {
    setBusy(true)
    try {
      await save(mbid)
      await rerunLibraryReconciler().catch(() => undefined)
      setMbidInput('')
      onResolved()
    } catch (err) {
      setError(errMsg(err))
    } finally {
      setBusy(false)
    }
  }

  function pinMbid() {
    const mbid = mbidInput.trim()
    setError(null)
    if (!isValidMbid(mbid)) {
      setError('Not a valid MBID (UUID expected)')
      return
    }
    void apply(mbid)
  }

  function ignore() {
    setError(null)
    void apply(null)
  }

  return (
    <div className="bg-surface border border-border rounded-lg p-3 space-y-2">
      <div className="space-y-1">
        <div className="font-medium text-text">{title}</div>
        <div className="text-xs text-muted">{subtitle}</div>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <input
          type="text"
          value={mbidInput}
          onChange={(e) => setMbidInput(e.target.value)}
          placeholder={placeholder}
          className="flex-1 px-2 py-1 border border-border rounded bg-bg text-text text-sm"
          disabled={busy}
        />
        <div className="flex gap-2">
          <button type="button" onClick={pinMbid} disabled={busy} className={BUTTON_CLASS}>
            Pin
          </button>
          <button type="button" onClick={ignore} disabled={busy} className={BUTTON_CLASS}>
            Ignore forever
          </button>
        </div>
      </div>

      {error && <div className="text-xs text-red-500">{error}</div>}
    </div>
  )
}

export function LibraryUnreconciledRowComponent({
  row,
  onResolved,
}: {
  row: LibraryUnreconciledRow
  onResolved: () => void
}) {
  return (
    <UnreconciledOverrideRow
      title={row.name}
      subtitle={`${row.source} - normalized: ${row.nameNormalized}`}
      placeholder="Paste MBID (UUID)"
      save={(correctMbid) =>
        saveLibraryOverride({
          source: row.source,
          sourceArtistId: row.sourceArtistId,
          correctMbid,
        })
      }
      onResolved={onResolved}
    />
  )
}

export function LibraryUnreconciledAlbumRowComponent({
  row,
  onResolved,
}: {
  row: LibraryUnreconciledAlbumRow
  onResolved: () => void
}) {
  return (
    <UnreconciledOverrideRow
      title={row.title}
      subtitle={`${row.source} - ${row.primaryType ?? 'Unknown type'} - ${row.releaseYear ?? 'Unknown year'}`}
      placeholder="Paste album MBID (UUID)"
      save={(correctAlbumMbid) =>
        saveLibraryAlbumOverride({
          source: row.source,
          sourceAlbumId: row.sourceAlbumId,
          correctAlbumMbid,
        })
      }
      onResolved={onResolved}
    />
  )
}
