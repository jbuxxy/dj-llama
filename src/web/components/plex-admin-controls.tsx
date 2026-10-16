import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { errMsg } from '@/core/validation'
import {
  getPlexLibrarySections,
  type PlexSection,
  type PlexServerChoice,
  pollPlexReconfigure,
  selectPlexReconfigureLibrary,
  selectPlexReconfigureServer,
  startPlexReconfigure,
  updatePlexLibrarySections,
} from '../lib/api'
import { consumeQueryFlag, goTopLevel, usesSameTabPlexSignIn } from '../lib/plex-same-tab'
import { ConfirmDialog } from './confirm-dialog'
import { Button } from './ui/button'

// Admin-only controls for changing which Plex server/libraries the whole app
// connects to, from inside the (already-collapsed-by-default) Plex card in
// Settings > Connections. See src/server/routes/settings.ts for why "change
// server" needs a full re-auth (the account-level Plex identity token is
// never persisted) while "change library" doesn't (the server connection is
// already known-good, just re-list its sections).

function ChangeLibrarySection({ onChanged }: { onChanged: () => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ['plex-library-sections'],
    queryFn: getPlexLibrarySections,
  })
  const [selected, setSelected] = useState<Set<string> | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (data && selected === null) {
      setSelected(new Set(data.currentSectionIds))
    }
  }, [data, selected])

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current ?? [])
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function handleSave() {
    if (!selected || selected.size === 0) {
      toast.error('Select at least one library.')
      return
    }
    setSaving(true)
    try {
      await updatePlexLibrarySections([...selected])
      onChanged()
      toast.success('Library selection saved')
    } catch (err: unknown) {
      toast.error(errMsg(err))
    } finally {
      setSaving(false)
    }
  }

  if (isLoading || !data) {
    return <p className="text-xs text-muted">Loading...</p>
  }

  return (
    <div className="space-y-2">
      <div className="space-y-1.5">
        {data.sections.map((s: PlexSection) => (
          <label
            key={s.id}
            className="flex items-center gap-2 rounded border border-border px-3 py-2 cursor-pointer hover:bg-bg"
          >
            <input
              type="checkbox"
              checked={selected?.has(s.id) ?? false}
              onChange={() => toggle(s.id)}
              className="accent-accent"
            />
            <span className="text-sm text-text">{s.title}</span>
          </label>
        ))}
      </div>
      <div className="flex justify-end">
        <Button size="sm" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving...' : 'Save'}
        </Button>
      </div>
    </div>
  )
}

const POLL_INTERVAL_MS = 1500
const POLL_TIMEOUT_MS = 5 * 60 * 1000

type ReconfigStatus = 'idle' | 'waiting' | 'select-server' | 'select-library' | 'submitting'

function ChangeServerSection({ onChanged }: { onChanged: () => void }) {
  const [confirming, setConfirming] = useState(false)
  const [status, setStatus] = useState<ReconfigStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [servers, setServers] = useState<PlexServerChoice[]>([])
  const [sections, setSections] = useState<PlexSection[]>([])
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  const pollDeadline = useRef(0)
  const pollInFlight = useRef(false)

  useEffect(() => {
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current)
    }
  }, [])

  const stopPolling = useCallback(() => {
    if (pollTimer.current) {
      clearInterval(pollTimer.current)
      pollTimer.current = null
    }
  }, [])

  const attemptPoll = useCallback(async () => {
    if (pollInFlight.current) return
    pollInFlight.current = true
    try {
      if (Date.now() > pollDeadline.current) {
        stopPolling()
        setStatus('idle')
        setError('Timed out waiting for Plex sign-in. Try again.')
        return
      }
      try {
        const result = await pollPlexReconfigure()
        if (result.status === 'complete') {
          stopPolling()
          setStatus('idle')
          onChanged()
          toast.success('Plex server updated')
        } else if (result.status === 'select-server') {
          stopPolling()
          setServers(result.servers)
          setStatus('select-server')
        } else if (result.status === 'select-library') {
          stopPolling()
          setSections(result.sections)
          setSelectedIds(new Set())
          setStatus('select-library')
        }
      } catch (err: unknown) {
        stopPolling()
        setStatus('idle')
        setError(errMsg(err))
      }
    } finally {
      pollInFlight.current = false
    }
  }, [onChanged, stopPolling])

  useEffect(() => {
    if (status !== 'waiting') return
    function onFocusOrVisible() {
      if (document.visibilityState === 'hidden') return
      void attemptPoll()
    }
    document.addEventListener('visibilitychange', onFocusOrVisible)
    window.addEventListener('focus', onFocusOrVisible)
    return () => {
      document.removeEventListener('visibilitychange', onFocusOrVisible)
      window.removeEventListener('focus', onFocusOrVisible)
    }
  }, [status, attemptPoll])

  const startPolling = useCallback(() => {
    setStatus('waiting')
    pollDeadline.current = Date.now() + POLL_TIMEOUT_MS
    pollTimer.current = setInterval(() => void attemptPoll(), POLL_INTERVAL_MS)
  }, [attemptPoll])

  // Back from Plex after a same-tab sign-in (car browser / framed app): resume
  // polling from the PIN cookie instead of starting over.
  useEffect(() => {
    if (!consumeQueryFlag('plexReconfigureReturn')) return
    startPolling()
    void attemptPoll()
  }, [startPolling, attemptPoll])

  async function handleConfirmChangeServer() {
    setConfirming(false)
    setError(null)
    const sameTab = usesSameTabPlexSignIn()
    try {
      const { authAppUrl } = await startPlexReconfigure(sameTab)
      if (sameTab) {
        goTopLevel(authAppUrl)
        return
      }
      window.open(authAppUrl, '_blank', 'noopener,noreferrer')
    } catch (err: unknown) {
      setError(errMsg(err))
      return
    }
    startPolling()
  }

  async function handleSelectServer(machineIdentifier: string) {
    setError(null)
    setStatus('submitting')
    try {
      const result = await selectPlexReconfigureServer(machineIdentifier)
      setSections(result.sections)
      setSelectedIds(new Set())
      setStatus('select-library')
    } catch (err: unknown) {
      setStatus('select-server')
      setError(errMsg(err))
    }
  }

  function toggleSection(id: string) {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function handleConfirmLibraries() {
    if (selectedIds.size === 0) {
      setError('Select at least one library.')
      return
    }
    setError(null)
    setStatus('submitting')
    try {
      await selectPlexReconfigureLibrary([...selectedIds])
      setStatus('idle')
      onChanged()
      toast.success('Plex server updated')
    } catch (err: unknown) {
      setStatus('select-library')
      setError(errMsg(err))
    }
  }

  if (status === 'select-server') {
    return (
      <div className="space-y-2">
        <p className="text-xs text-muted">
          This Plex account owns more than one server. Choose which one DJ Llama should connect to.
        </p>
        <div className="space-y-1.5">
          {servers.map((s) => (
            <button
              key={s.machineIdentifier}
              type="button"
              onClick={() => handleSelectServer(s.machineIdentifier)}
              className="w-full text-left rounded border border-border px-3 py-2 hover:bg-bg transition-colors"
            >
              <span className="text-sm text-text">{s.name}</span>
            </button>
          ))}
        </div>
        {error && <p className="text-sm text-reject">{error}</p>}
      </div>
    )
  }

  if (status === 'select-library' || status === 'submitting') {
    return (
      <div className="space-y-2">
        <p className="text-xs text-muted">
          Select which Plex library section(s) count as Music. Anyone shared on at least one of
          these gets access to DJ Llama.
        </p>
        <div className="space-y-1.5">
          {sections.map((s) => (
            <label
              key={s.id}
              className="flex items-center gap-2 rounded border border-border px-3 py-2 cursor-pointer hover:bg-bg"
            >
              <input
                type="checkbox"
                checked={selectedIds.has(s.id)}
                onChange={() => toggleSection(s.id)}
                className="accent-accent"
              />
              <span className="text-sm text-text">{s.title}</span>
            </label>
          ))}
        </div>
        <div className="flex justify-end">
          <Button size="sm" disabled={status === 'submitting'} onClick={handleConfirmLibraries}>
            {status === 'submitting' ? 'Saving...' : 'Continue'}
          </Button>
        </div>
        {error && <p className="text-sm text-reject">{error}</p>}
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={status === 'waiting'}
        onClick={() => setConfirming(true)}
      >
        {status === 'waiting' ? 'Waiting for Plex...' : 'Change server'}
      </Button>
      {status === 'waiting' && (
        <p className="text-xs text-muted">Finish signing in in the Plex tab that just opened.</p>
      )}
      {error && <p className="text-sm text-reject">{error}</p>}
      {confirming && (
        <ConfirmDialog
          title="Change the connected Plex server?"
          message="This changes which Plex server DJ Llama connects to for every user, including library sync. You'll sign in with Plex again to pick the new server."
          confirmLabel="Change server"
          destructive
          onConfirm={handleConfirmChangeServer}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  )
}

export function PlexAdminControls() {
  const queryClient = useQueryClient()

  function refetchAll() {
    queryClient.invalidateQueries({ queryKey: ['settings'] })
    queryClient.invalidateQueries({ queryKey: ['plex-server-name'] })
    queryClient.invalidateQueries({ queryKey: ['plex-library-sections'] })
  }

  return (
    <div className="space-y-4 border-t border-border pt-3">
      <div>
        <h4 className="text-xs font-semibold text-text uppercase tracking-wide">Music library</h4>
        <p className="text-xs text-muted mt-1">
          Which Plex library section(s) count as Music. Anyone shared on at least one of these gets
          access to DJ Llama.
        </p>
        <div className="mt-2">
          <ChangeLibrarySection onChanged={refetchAll} />
        </div>
      </div>
      <div>
        <h4 className="text-xs font-semibold text-text uppercase tracking-wide">Plex server</h4>
        <p className="text-xs text-muted mt-1">
          Which Plex server the whole app connects to. Changing this affects every user, not just
          you.
        </p>
        <div className="mt-2">
          <ChangeServerSection onChanged={refetchAll} />
        </div>
      </div>
    </div>
  )
}
