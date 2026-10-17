import { useQueryClient } from '@tanstack/react-query'
import { Check, Copy, Play, Radio, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import {
  deletePlaylistApi,
  duplicatePlaylistApi,
  generatePlaylistApi,
  type PlaylistRow,
  sweepPlaylistLiveTracksApi,
  updatePlaylistApi,
} from '../lib/api'
import {
  clearPlaylistGenerating,
  markPlaylistGenerating,
  useGeneratingPlaylistIds,
} from '../lib/generating-playlists'
import { ConfirmDialog } from './confirm-dialog'
import { Toggle } from './toggle'
import { Spinner } from './ui/spinner'

type Size = 'sm' | 'lg'

const GENERATE_CLASSES: Record<Size, string> = {
  sm: 'px-2 py-1 text-xs gap-1',
  lg: 'px-3 py-1.5 text-sm gap-1.5',
}
const ICON_SIZE: Record<Size, number> = { sm: 11, lg: 14 }
const SPINNER_SIZE: Record<Size, string | undefined> = { sm: undefined, lg: 'w-3.5 h-3.5' }

// Every "kick off a generate" button on the playlists page and its detail
// page shares this exact shape (spinner-while-in-flight via the shared
// generating-playlists cache, same success/failure toasts) -- previously
// copy-pasted into PlaylistCard, CuratedPlaylistsSection, ImportPlaylistSection,
// AdminImportedPlaylistsSection, and PlaylistActions with drifting padding/sizes.
export function GenerateButton({
  playlistId,
  onGenerated,
  size = 'sm',
  generateFn = generatePlaylistApi,
}: {
  playlistId: number
  onGenerated: () => void
  size?: Size
  generateFn?: (id: number) => Promise<unknown>
}) {
  const queryClient = useQueryClient()
  const generatingIds = useGeneratingPlaylistIds()
  const generating = generatingIds.has(playlistId)

  async function handleGenerate() {
    markPlaylistGenerating(queryClient, playlistId)
    try {
      await generateFn(playlistId)
      toast.success('Playlist generation started')
      onGenerated()
    } catch {
      clearPlaylistGenerating(queryClient, playlistId)
      toast.error('Failed to start generation')
    }
  }

  return (
    <button
      type="button"
      onClick={handleGenerate}
      disabled={generating}
      className={`flex items-center ${GENERATE_CLASSES[size]} bg-accent/15 text-accent rounded hover:bg-accent/25 disabled:opacity-60 disabled:cursor-not-allowed transition-colors`}
      title="Generate now"
    >
      {generating ? (
        <Spinner className={SPINNER_SIZE[size]} />
      ) : (
        <Play size={ICON_SIZE[size]} aria-hidden="true" />
      )}
      {generating ? 'Generating...' : 'Generate'}
    </button>
  )
}

// Icon-only secondary action: duplicate-to-Plexamp, with the same
// 2s "copied" check-mark feedback everywhere it appears.
export function DuplicateButton({ playlistId }: { playlistId: number }) {
  const [duplicating, setDuplicating] = useState(false)
  const [duplicated, setDuplicated] = useState(false)

  async function handleDuplicate() {
    setDuplicating(true)
    try {
      await duplicatePlaylistApi(playlistId)
      toast.success('Playlist duplicated -- give it a name to keep')
      setDuplicated(true)
      setTimeout(() => setDuplicated(false), 2000)
    } catch {
      toast.error('Failed to duplicate playlist')
    } finally {
      setDuplicating(false)
    }
  }

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        handleDuplicate()
      }}
      disabled={duplicating}
      className="p-1.5 text-muted hover:text-text transition-colors disabled:opacity-50"
      title="Duplicate to Plexamp"
      aria-label="Duplicate to Plexamp"
    >
      {duplicated ? (
        <Check size={14} aria-hidden="true" className="text-approve" />
      ) : (
        <Copy size={14} aria-hidden="true" />
      )}
    </button>
  )
}

// Manual-only: reads the playlist's actual current Plex items and swaps just
// the ones on a live/acoustic/demo release, without a full regenerate. No
// automatic schedule -- this button is the only trigger. Caller decides
// whether to render it at all (only meaningful once pushedToPlex is true).
export function SweepLiveTracksButton({
  playlistId,
  labeled = false,
}: {
  playlistId: number
  labeled?: boolean
}) {
  const [sweeping, setSweeping] = useState(false)

  async function handleSweep() {
    setSweeping(true)
    try {
      const result = await sweepPlaylistLiveTracksApi(playlistId)
      if (result.replaced.length > 0) {
        toast.success(`Replaced ${result.replaced.length} live version(s) with the studio release`)
      } else {
        toast.info('No live versions found -- nothing to replace')
      }
    } catch {
      toast.error('Failed to check for live tracks')
    } finally {
      setSweeping(false)
    }
  }

  if (labeled) {
    return (
      <button
        type="button"
        onClick={handleSweep}
        disabled={sweeping}
        className="flex items-center gap-1.5 px-3 py-1.5 bg-surface border border-border rounded-md text-sm text-muted hover:text-text transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
      >
        {sweeping ? <Spinner className="w-3.5 h-3.5" /> : <Radio size={14} aria-hidden="true" />}
        {sweeping ? 'Checking...' : 'Fix live tracks'}
      </button>
    )
  }

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        handleSweep()
      }}
      disabled={sweeping}
      className="flex items-center justify-center p-1.5 rounded border text-muted border-border hover:text-accent hover:border-accent/40 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
      title="Fix live tracks"
      aria-label="Fix live tracks"
    >
      {sweeping ? <Spinner /> : <Radio size={14} aria-hidden="true" />}
    </button>
  )
}

// Icon-only delete with confirm dialog + the delete API call + toasts, all
// absorbed here -- every one of the 4 call sites had an identical
// try/delete/toast/onRefetch body differing only in which delete endpoint
// they hit, so that logic moved in rather than just the button chrome.
export function DeleteButton({
  playlistId,
  onDeleted,
  deleteFn = deletePlaylistApi,
  className,
}: {
  playlistId: number
  onDeleted: () => void
  deleteFn?: (id: number) => Promise<unknown>
  className?: string
}) {
  const [confirming, setConfirming] = useState(false)

  async function handleConfirmedDelete() {
    try {
      await deleteFn(playlistId)
      toast.success('Playlist deleted')
      onDeleted()
    } catch {
      toast.error('Failed to delete playlist')
    } finally {
      setConfirming(false)
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          setConfirming(true)
        }}
        className={className ?? 'p-1.5 text-muted hover:text-reject transition-colors'}
        title="Delete"
        aria-label="Delete"
      >
        <Trash2 size={14} aria-hidden="true" />
      </button>
      {confirming && (
        <ConfirmDialog
          title="Delete"
          message="Delete this playlist? This cannot be undone."
          confirmLabel="Delete"
          onConfirm={handleConfirmedDelete}
          onCancel={() => setConfirming(false)}
        />
      )}
    </>
  )
}

// Enabled/disabled switch for a row in the shared ['playlists'] query cache --
// flips immediately with an optimistic update (reverted on failure) rather
// than waiting on a PATCH + refetch round trip, and guards against a second
// click landing mid-flight. PlaylistCard used to skip the optimistic update
// (so its toggle lagged until the next refetch) while CuratedPlaylistsSection
// had it; unified here so every row behaves the same way.
// updateFn/queryKey let the admin All Users list reuse it against its own
// endpoint and cache, the same way GenerateButton/DeleteButton take theirs.
export function EnabledToggle({
  playlistId,
  enabled,
  updateFn = (id, next) => updatePlaylistApi(id, { enabled: next }),
  queryKey = ['playlists'],
}: {
  playlistId: number
  enabled: boolean
  updateFn?: (id: number, enabled: boolean) => Promise<unknown>
  queryKey?: readonly unknown[]
}) {
  const queryClient = useQueryClient()
  const [toggling, setToggling] = useState(false)

  async function handleToggle(next: boolean) {
    if (toggling) return
    setToggling(true)
    queryClient.setQueryData<PlaylistRow[]>(queryKey, (old) =>
      old?.map((p) => (p.id === playlistId ? { ...p, enabled: next } : p)),
    )
    try {
      await updateFn(playlistId, next)
    } catch {
      queryClient.setQueryData<PlaylistRow[]>(queryKey, (old) =>
        old?.map((p) => (p.id === playlistId ? { ...p, enabled: !next } : p)),
      )
      toast.error('Failed to update playlist')
    } finally {
      setToggling(false)
    }
  }

  return (
    <Toggle
      checked={enabled}
      onChange={handleToggle}
      label={enabled ? 'Disable playlist' : 'Enable playlist'}
      disabled={toggling}
    />
  )
}
