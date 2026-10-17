import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Clock,
  ExternalLink,
  Pencil,
  Plus,
  Upload,
  X,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { SEASONAL_PRESETS } from '@/core/playlists/seasonal-presets'
import { errMsg, isHttpUrl } from '@/core/validation'
import { ArtistThumb } from '../components/artist-thumb'
import { CollapsibleCard } from '../components/collapsible-card'
import { CronPicker } from '../components/cron-picker'
import { MediasageSection } from '../components/mediasage-section'
import { PlaylistCard } from '../components/playlist-card'
import { PlaylistCover } from '../components/playlist-cover'
import { PlaylistForm } from '../components/playlist-form'
import {
  DeleteButton,
  DuplicateButton,
  EnabledToggle,
  GenerateButton,
  SweepLiveTracksButton,
} from '../components/playlist-row-actions'
import { SeasonCover } from '../components/season-cover'
import { SeasonalTrackEditor } from '../components/seasonal-track-editor'
import { Toggle } from '../components/toggle'
import { Skeleton } from '../components/ui/skeleton'
import {
  type AdminImportedPlaylistRow,
  createPlaylistApi,
  deleteAdminImportedPlaylistApi,
  deletePlaylistApi,
  deletePlaylistMissingTrackApi,
  generateAdminImportedPlaylistApi,
  generatePlaylistApi,
  getAdminImportedPlaylists,
  getAuthStatus,
  getPlaylist,
  getPlaylistMissingTracks,
  getPlaylistScheduler,
  getPlaylists,
  getSettings,
  type PlaylistInsert,
  type PlaylistMissingTrack,
  type PlaylistRow,
  type PlaylistTrackRow,
  setAdminImportedPlaylistEnabledApi,
  updatePlaylistApi,
  updateSettings,
} from '../lib/api'
import { clearPlaylistGenerating, markPlaylistGenerating } from '../lib/generating-playlists'
import { formatSchedule } from '../lib/playlist-format'

function formatNextRun(nextRun: string): string {
  const date = new Date(nextRun)
  const diffMinutes = Math.round((date.getTime() - Date.now()) / 60_000)
  const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
  if (diffMinutes < 0) return formatter.format(diffMinutes, 'minute')
  if (diffMinutes < 60) return formatter.format(diffMinutes, 'minute')
  const diffHours = Math.round(diffMinutes / 60)
  if (diffHours < 24) return formatter.format(diffHours, 'hour')
  return formatter.format(Math.round(diffHours / 24), 'day')
}

function formatSchedulerSubtitle(info: {
  nextRun: string | null
  cron: string | null
  enabled: boolean
}): string {
  if (info.enabled && info.nextRun) {
    return `Next generation ${formatNextRun(info.nextRun)}`
  }
  if (info.enabled && info.cron) {
    return `Scheduled: ${formatSchedule(info.cron)}`
  }
  if (!info.enabled && info.cron) {
    return 'Schedule paused'
  }
  return 'No schedule configured'
}

const MONTH_ABBR = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]

type SeasonalWindow = { startMonth: number; startDay: number; endMonth: number; endDay: number }

function formatWindow(window: SeasonalWindow): string {
  const start = `${MONTH_ABBR[window.startMonth - 1]} ${window.startDay}`
  const end = `${MONTH_ABBR[window.endMonth - 1]} ${window.endDay}`
  return `${start} – ${end}`
}

function SkeletonGrid() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {[1, 2, 3].map((i) => (
        <div key={i} className="bg-surface border border-border rounded-lg p-4 space-y-3">
          <div className="flex items-start justify-between gap-2">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-5 w-20 rounded-full" />
          </div>
          <div className="space-y-1.5">
            <Skeleton className="h-3.5 w-32" />
            <Skeleton className="h-3.5 w-24" />
          </div>
          <div className="flex items-center justify-between pt-1 border-t border-border">
            <Skeleton className="h-7 w-24 rounded" />
            <Skeleton className="h-5 w-9 rounded-full" />
          </div>
        </div>
      ))}
    </div>
  )
}

// One preset's row: on/off toggle plus an optional window-override editor.
// Editing is only possible once the row exists (preset toggled on) since the
// override lives on that playlist's own `config` jsonb.
function isTodayInWindow(window: SeasonalWindow): boolean {
  const now = new Date()
  const value = (now.getMonth() + 1) * 100 + now.getDate()
  const start = window.startMonth * 100 + window.startDay
  const end = window.endMonth * 100 + window.endDay
  return start <= end ? value >= start && value <= end : value >= start || value <= end
}

function SeasonalPresetRow({
  presetKey,
  row,
  window,
  label,
  enabled,
  hasOverride,
  disabled,
  onToggle,
  onSaveWindow,
  onResetWindow,
  onChanged,
}: {
  presetKey: string
  row: PlaylistRow | undefined
  window: SeasonalWindow
  label: string
  enabled: boolean
  hasOverride: boolean
  disabled: boolean
  onToggle: (next: boolean) => void
  onSaveWindow: (window: SeasonalWindow) => Promise<void>
  onResetWindow: () => Promise<void>
  onChanged: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<SeasonalWindow>(window)
  const [saving, setSaving] = useState(false)

  function openEditor() {
    setDraft(window)
    setEditing(true)
  }

  async function save() {
    setSaving(true)
    try {
      await onSaveWindow(draft)
      setEditing(false)
    } finally {
      setSaving(false)
    }
  }

  async function reset() {
    setSaving(true)
    try {
      await onResetWindow()
      setEditing(false)
    } finally {
      setSaving(false)
    }
  }

  function numberField(label: string, value: number, max: number, onChange: (v: number) => void) {
    return (
      <label className="flex items-center gap-1 text-xs text-muted">
        {label}
        <input
          type="number"
          min={1}
          max={max}
          value={value}
          onChange={(e) => onChange(Number(e.target.value) || 1)}
          className="w-14 px-1.5 py-1 text-xs bg-bg border border-border rounded text-text"
        />
      </label>
    )
  }

  const inSeason = isTodayInWindow(window)
  const status = !row
    ? 'Off'
    : row.status === 'active' && row.pushedToPlex
      ? 'Live in Plex'
      : inSeason
        ? 'Not generated yet'
        : `Goes live ${MONTH_ABBR[window.startMonth - 1]} ${window.startDay}`

  return (
    <div className="py-2.5 space-y-2">
      <div className="flex items-start gap-2.5">
        <SeasonCover presetKey={presetKey} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              disabled={!row}
              className="flex items-center gap-1.5 text-sm text-text hover:text-accent transition-colors min-w-0 disabled:hover:text-text"
              aria-expanded={expanded}
            >
              {row &&
                (expanded ? (
                  <ChevronDown size={14} aria-hidden="true" className="shrink-0" />
                ) : (
                  <ChevronRight size={14} aria-hidden="true" className="shrink-0" />
                ))}
              <span className="truncate">{label}</span>
            </button>
            <Toggle checked={enabled} disabled={disabled} label={label} onChange={onToggle} />
          </div>
          <div className={`flex items-center flex-wrap gap-x-2 gap-y-1 mt-1 ${row ? 'ml-5' : ''}`}>
            <span className="text-xs text-muted">{formatWindow(window)}</span>
            {enabled && (
              <button
                type="button"
                onClick={() => (editing ? setEditing(false) : openEditor())}
                className="text-xs text-accent hover:underline"
              >
                Edit window
              </button>
            )}
          </div>
          {row && (
            <div className="flex items-center flex-wrap gap-2 mt-1.5 ml-5">
              <span className="text-xs text-muted">
                {row.trackCount ? `${row.trackCount} songs · ` : ''}
                {status}
              </span>
              <GenerateButton playlistId={row.id} onGenerated={onChanged} />
            </div>
          )}
          {row && expanded && (
            <div className="mt-2 ml-5">
              <SeasonalTrackEditor playlistId={row.id} onChanged={onChanged} />
            </div>
          )}
        </div>
      </div>
      {editing && (
        <div className="flex flex-wrap items-end gap-3 pl-0.5">
          <div className="flex items-end gap-1.5">
            {numberField('Start', draft.startMonth, 12, (v) =>
              setDraft((d) => ({ ...d, startMonth: v })),
            )}
            {numberField('/', draft.startDay, 31, (v) => setDraft((d) => ({ ...d, startDay: v })))}
          </div>
          <div className="flex items-end gap-1.5">
            {numberField('End', draft.endMonth, 12, (v) =>
              setDraft((d) => ({ ...d, endMonth: v })),
            )}
            {numberField('/', draft.endDay, 31, (v) => setDraft((d) => ({ ...d, endDay: v })))}
          </div>
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="px-2.5 py-1 text-xs font-medium rounded-md bg-accent text-accent-fg disabled:opacity-50"
          >
            Save
          </button>
          {hasOverride && (
            <button
              type="button"
              onClick={reset}
              disabled={saving}
              className="px-2.5 py-1 text-xs font-medium rounded-md border border-border text-muted hover:text-text disabled:opacity-50"
            >
              Reset to default
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// Seasonal playlists section -- built-in presets toggled on/off, distinct
// from the custom-playlist grid below. Each preset maps to one 'seasonal'
// strategy playlists row (created on toggle-on, deleted on toggle-off); the
// scheduler's daily tick handles the actual generate/push and window-close
// teardown (src/index.ts's tickSeasonalPlaylists), not this UI. Tristate:
// this per-preset row is the inner toggle, gated by the outer master toggle
// (`masterEnabled`) which the parent page owns since it's a global preference,
// not a per-playlist setting.
function SeasonalPlaylistsSection({
  playlists,
  masterEnabled,
  onToggleMaster,
  onChanged,
}: {
  playlists: PlaylistRow[]
  masterEnabled: boolean
  onToggleMaster: (next: boolean) => void
  onChanged: () => void
}) {
  const [pendingKey, setPendingKey] = useState<string | null>(null)

  const seasonalByPreset = new Map(
    playlists
      .filter((p) => p.strategy === 'seasonal' && p.config?.presetKey)
      .map((p) => [p.config?.presetKey as string, p]),
  )

  async function toggle(presetKey: string, label: string, enabled: boolean) {
    setPendingKey(presetKey)
    try {
      if (enabled) {
        await createPlaylistApi({
          name: label,
          strategy: 'seasonal',
          config: { size: 25, presetKey, trackSourcePriority: ['local', 'spotify', 'deezer'] },
          enabled: true,
        })
      } else {
        const existing = seasonalByPreset.get(presetKey)
        if (existing) await deletePlaylistApi(existing.id)
      }
      onChanged()
    } catch (err) {
      toast.error(errMsg(err))
    } finally {
      setPendingKey(null)
    }
  }

  async function saveWindow(presetKey: string, window: SeasonalWindow) {
    const existing = seasonalByPreset.get(presetKey)
    if (!existing) return
    try {
      await updatePlaylistApi(existing.id, {
        config: {
          ...(existing.config ?? { size: 25, trackSourcePriority: [] }),
          windowOverride: window,
        },
      })
      onChanged()
    } catch (err) {
      toast.error(errMsg(err))
    }
  }

  async function resetWindow(presetKey: string) {
    const existing = seasonalByPreset.get(presetKey)
    if (!existing) return
    try {
      const { windowOverride: _drop, ...rest } = existing.config ?? {
        size: 25,
        trackSourcePriority: [],
      }
      await updatePlaylistApi(existing.id, { config: rest })
      onChanged()
    } catch (err) {
      toast.error(errMsg(err))
    }
  }

  return (
    <CollapsibleCard
      defaultCollapsed
      title="Seasonal Playlists"
      subtitle="Built from the Halloween, Christmas, and summer songs in your library -- pushed to Plex while the season is active and removed when it ends. Expand one to remove songs or add suggested replacements."
      headerExtra={
        <Toggle
          checked={masterEnabled}
          label="Enable seasonal playlists"
          onChange={onToggleMaster}
        />
      }
    >
      <div className={`divide-y divide-border ${masterEnabled ? '' : 'opacity-50'}`}>
        {SEASONAL_PRESETS.map((preset) => {
          const row = seasonalByPreset.get(preset.key)
          const enabled = row != null
          const windowOverride = row?.config?.windowOverride
          return (
            <SeasonalPresetRow
              key={preset.key}
              presetKey={preset.key}
              row={row}
              onChanged={onChanged}
              label={preset.label}
              window={windowOverride ?? preset.window}
              hasOverride={windowOverride != null}
              enabled={enabled}
              disabled={pendingKey === preset.key}
              onToggle={(next) => toggle(preset.key, preset.label, next)}
              onSaveWindow={(w) => saveWindow(preset.key, w)}
              onResetWindow={() => resetWindow(preset.key)}
            />
          )
        })}
      </div>
    </CollapsibleCard>
  )
}

const DAILY_MIX_COUNT = 3
const CURATED_STRATEGIES = ['weekly_digest', 'genre_focus', 'mood_mix', 'rediscover'] as const
type CuratedStrategy = (typeof CURATED_STRATEGIES)[number]

function isCuratedStrategy(strategy: string): strategy is CuratedStrategy {
  return (CURATED_STRATEGIES as readonly string[]).includes(strategy)
}

// Per-row "how it's created" text for a curated-strategy entry -- reuses the
// same real detail (lookback windows etc.) the old section-wide subtitle
// used to carry in one paragraph, but scoped to just the one row it applies to.
function describeCuratedRow(row: PlaylistRow): string {
  switch (row.strategy) {
    case 'weekly_digest':
      return 'Curated from your last 7 days of listening'
    case 'rediscover':
      return "Artists you haven't played in 30+ days"
    case 'genre_focus':
      return row.config?.genre
        ? `Deep dive into a genre: ${row.config.genre}`
        : 'Deep dive into a genre'
    case 'mood_mix':
      return row.config?.mood
        ? `Tracks matching a mood or vibe: ${row.config.mood}`
        : 'Tracks matching a mood or vibe'
    default:
      return ''
  }
}

// Curated Playlists section -- Daily Mix (a fixed set of DAILY_MIX_COUNT
// 'daily_mix' rows, always on for every user with no disable control --
// self-provisioned below the first time this section renders for a user
// who doesn't have them yet) plus every user-created curated-strategy row
// (weekly_digest/genre_focus/mood_mix/rediscover, made via the "+ Create
// Playlist" form) listed underneath as individually editable/deletable
// entries. Every row -- daily mix or curated -- shares one Generate button
// and the same server-side overwrite-on-regenerate behavior
// (pushPlaylistTracksToPlex deletes the previous same-name Plex playlist
// before creating the replacement, see src/index.ts), so there's never a
// stale duplicate left behind in Plex.
function CuratedPlaylistsSection({
  playlists,
  onEdit,
  onChanged,
  onCreate,
}: {
  playlists: PlaylistRow[]
  onEdit: (playlist: PlaylistRow) => void
  onChanged: () => void
  onCreate: () => void
}) {
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [tracks, setTracks] = useState<PlaylistTrackRow[] | null>(null)
  const [tracksLoading, setTracksLoading] = useState(false)
  const [tracksError, setTracksError] = useState(false)
  const [provisioning, setProvisioning] = useState(false)

  const mixRows = playlists
    .filter((p) => p.strategy === 'daily_mix')
    .sort((a, b) => (a.config?.mixIndex ?? 0) - (b.config?.mixIndex ?? 0))
  const curatedRows = playlists.filter((p) => isCuratedStrategy(p.strategy))

  // Daily Mix is always on -- if this user doesn't have their
  // DAILY_MIX_COUNT rows yet (new account, or one created before this
  // became default-on), create them once. The parent only mounts this
  // section after its own playlists fetch has resolved, so `playlists`
  // here is never a still-loading empty array.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally one-shot -- must only re-check when mixRows.length changes; including onChanged/t/provisioning would re-fire this on every render with an unstable prop reference and risk creating duplicate mixes
  useEffect(() => {
    if (provisioning || mixRows.length > 0) return
    setProvisioning(true)
    Promise.all(
      Array.from({ length: DAILY_MIX_COUNT }, (_, mixIndex) =>
        createPlaylistApi({
          name: `Daily Mix ${mixIndex + 1}`,
          strategy: 'daily_mix',
          schedule: '0 5 * * *',
          config: { size: 25, trackSourcePriority: ['local'], mixIndex },
          enabled: true,
        }),
      ),
    )
      .then(onChanged)
      .catch(() => toast.error('Failed to create playlist'))
      .finally(() => setProvisioning(false))
  }, [mixRows.length])

  async function handleExpand(id: number) {
    if (expandedId === id) {
      setExpandedId(null)
      return
    }
    setExpandedId(id)
    setTracks(null)
    setTracksError(false)
    setTracksLoading(true)
    try {
      const result = await getPlaylist(id)
      setTracks(result.tracks.slice().sort((a, b) => a.position - b.position))
    } catch {
      setTracksError(true)
    } finally {
      setTracksLoading(false)
    }
  }

  function Row({ row, curated }: { row: PlaylistRow; curated: boolean }) {
    const description = curated
      ? `${describeCuratedRow(row)} · ${formatSchedule(row.schedule)}`
      : 'Genre-based mix from your own library, refreshed daily'
    return (
      <div className="py-2.5 flex items-start gap-2.5">
        <PlaylistCover name={row.name} coverUrl={row.coverUrl} collageUrls={row.collageUrls} />
        <div className="flex-1 min-w-0">
          <button
            type="button"
            onClick={() => handleExpand(row.id)}
            className="flex items-center gap-1.5 text-sm text-text hover:text-accent transition-colors w-full min-w-0"
            aria-expanded={expandedId === row.id}
          >
            {expandedId === row.id ? (
              <ChevronDown size={14} aria-hidden="true" className="shrink-0" />
            ) : (
              <ChevronRight size={14} aria-hidden="true" className="shrink-0" />
            )}
            <span className="truncate">{row.name}</span>
          </button>
          <div className="flex items-center justify-between flex-wrap gap-2 mt-1.5 ml-5">
            <div className="flex items-center flex-wrap gap-2 min-w-0">
              {row.trackCount != null && (
                <span className="text-xs text-muted">{row.trackCount} tracks</span>
              )}
              <GenerateButton playlistId={row.id} onGenerated={onChanged} />
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <DuplicateButton playlistId={row.id} />
              {curated && (
                <>
                  <EnabledToggle playlistId={row.id} enabled={row.enabled} />
                  <button
                    type="button"
                    onClick={() => onEdit(row)}
                    className="p-1.5 text-muted hover:text-text transition-colors"
                    title="Edit playlist"
                    aria-label="Edit playlist"
                  >
                    <Pencil size={14} aria-hidden="true" />
                  </button>
                  <DeleteButton playlistId={row.id} onDeleted={onChanged} />
                </>
              )}
            </div>
          </div>
          {description && <p className="text-xs text-muted mt-1 ml-5">{description}</p>}
          {!curated && !row.enabled && <p className="text-micro-lg text-muted/60 ml-5">Disabled</p>}
          {expandedId === row.id && (
            <div className="mt-2 ml-5">
              {tracksLoading ? (
                <p className="text-xs text-muted py-1">Loading...</p>
              ) : tracksError ? (
                <p className="text-xs text-red-400 py-1">Playlist not found.</p>
              ) : tracks && tracks.length > 0 ? (
                <ul className="rounded-md border border-border/60 divide-y divide-border/60 overflow-hidden">
                  {tracks.map((track, i) => (
                    <li
                      key={track.id}
                      className="flex items-center gap-2 px-2 py-1.5 text-xs hover:bg-surface transition-colors"
                    >
                      <span className="w-5 text-right text-muted shrink-0">{i + 1}</span>
                      <span className="text-text truncate">
                        {track.trackName ?? (
                          <span className="italic text-muted">Unknown track</span>
                        )}
                      </span>
                      <span className="text-muted truncate ml-auto shrink-0 max-w-[40%]">
                        {track.artistName}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted py-1">
                  No tracks yet. Generate the playlist to populate it.
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <CollapsibleCard
      defaultCollapsed
      title="Curated Playlists"
      subtitle="Daily Mix plus every curated playlist you create (Weekly Digest, Genre Focus, Mood Mix, Rediscover) -- each regenerates on its own schedule and overwrites the previous version in Plex automatically. Hit Generate on any entry to run it now."
      headerExtra={
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onCreate}
            aria-label="Create Playlist"
            title="Create Playlist"
            className="flex items-center justify-center size-8 bg-accent text-accent-fg rounded-md hover:opacity-90 transition-opacity shrink-0"
          >
            <Plus size={15} aria-hidden="true" />
          </button>
        </div>
      }
    >
      {mixRows.length > 0 || curatedRows.length > 0 ? (
        <div className="divide-y divide-border">
          {mixRows.map((row) => (
            <Row key={row.id} row={row} curated={false} />
          ))}
          {curatedRows.map((row) => (
            <Row key={row.id} row={row} curated />
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted py-2">
          Daily Mix is off and you have no curated playlists yet -- use the + button above to add
          one.
        </p>
      )}
    </CollapsibleCard>
  )
}

// One imported playlist's missing-tracks list -- lazily fetched on expand,
// live-reconciled server-side on every re-sync (external-import.ts) so this
// always reflects what's currently unmatched, not a growing history.
function MissingTracksList({ playlistId }: { playlistId: number }) {
  const queryClient = useQueryClient()
  // Keyed under the 'playlists' prefix so the SSE 'playlist-generated' handler's
  // queryClient.invalidateQueries({ queryKey: ['playlists'] }) (use-realtime-updates.ts)
  // refetches this too -- otherwise this list only reflected what existed on expand
  // and stayed stale through a whole regenerate cycle until manually collapsed/reopened.
  const { data: tracks = null, isLoading: loading } = useQuery<PlaylistMissingTrack[]>({
    queryKey: ['playlists', playlistId, 'missing-tracks'],
    queryFn: () => getPlaylistMissingTracks(playlistId),
  })

  async function dismiss(trackId: number) {
    try {
      await deletePlaylistMissingTrackApi(playlistId, trackId)
      queryClient.setQueryData<PlaylistMissingTrack[]>(
        ['playlists', playlistId, 'missing-tracks'],
        (prev) => prev?.filter((t) => t.id !== trackId) ?? prev,
      )
    } catch {
      toast.error('Failed to dismiss track')
    }
  }

  if (loading) return <p className="text-xs text-muted py-1">Loading...</p>
  if (!tracks || tracks.length === 0) {
    return <p className="text-xs text-muted py-1">Nothing missing -- every track matched.</p>
  }

  // Grouped by album, not flattened per-track -- a request is always made at
  // the album level (the album the track originally appeared on), so the
  // list should reflect that unit instead of reading like an unrelated pile
  // of individual songs.
  const groups = new Map<
    string,
    {
      albumTitle: string | null
      resolvedAlbumTitle: string | null
      artistName: string
      coverUrl: string | null
      tracks: PlaylistMissingTrack[]
    }
  >()
  for (const track of tracks) {
    const key = `${track.artistName.toLowerCase()}::${(track.albumTitle ?? '').toLowerCase()}`
    const existing = groups.get(key)
    if (existing) {
      existing.tracks.push(track)
      existing.coverUrl ??= track.coverUrl
    } else {
      groups.set(key, {
        albumTitle: track.albumTitle,
        resolvedAlbumTitle: track.resolvedAlbumTitle,
        artistName: track.artistName,
        coverUrl: track.coverUrl,
        tracks: [track],
      })
    }
  }

  return (
    <ul className="space-y-3 py-1">
      {[...groups.values()].map((group) => (
        <li
          key={`${group.artistName}::${group.albumTitle ?? ''}`}
          className="flex items-start gap-2.5"
        >
          <ArtistThumb
            name={group.albumTitle ?? group.artistName}
            imageUrl={group.coverUrl}
            size={10}
            className="shrink-0"
          />
          <div className="min-w-0 flex-1 space-y-1">
            <p className="text-xs font-medium text-text truncate">
              {group.resolvedAlbumTitle
                ? `Requesting ${group.resolvedAlbumTitle} · ${group.artistName}`
                : group.albumTitle
                  ? `Tagged on the source playlist as ${group.albumTitle} · ${group.artistName} (not yet resolved)`
                  : `Missing track · ${group.artistName}`}
            </p>
            <ul className="space-y-1 pl-3 border-l border-border">
              {group.tracks.map((track) => (
                <li key={track.id} className="flex items-center justify-between gap-2 text-xs">
                  <span className="text-muted truncate min-w-0 flex items-center gap-1">
                    {track.reason === 'search_error' && (
                      <AlertTriangle
                        size={11}
                        className="text-warning shrink-0"
                        aria-hidden="true"
                      />
                    )}
                    <span
                      className="truncate"
                      title={
                        track.reason === 'search_error'
                          ? 'Plex search failed last sync -- this may resolve on its own next sync rather than needing a request.'
                          : undefined
                      }
                    >
                      {track.trackName}
                    </span>
                  </span>
                  <span className="flex items-center gap-1 shrink-0">
                    <a
                      href={`/requests?q=${encodeURIComponent(`${track.artistName} ${track.trackName}`)}`}
                      className="p-1 text-muted hover:text-accent transition-colors"
                      title={'Search & Request'}
                      aria-label={'Search & Request'}
                    >
                      <ExternalLink size={12} aria-hidden="true" />
                    </a>
                    <button
                      type="button"
                      onClick={() => dismiss(track.id)}
                      className="p-1 text-muted hover:text-reject transition-colors"
                      title="Dismiss"
                      aria-label="Dismiss"
                    >
                      <X size={12} aria-hidden="true" />
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </li>
      ))}
    </ul>
  )
}

// Branding for each import source's badge -- same visual language as the
// recommendation cards' StreamingLinks pills (colored initials, CSS-var
// per-service color), reused here as a clickable link back to the original
// playlist rather than a search fallback.
const IMPORT_SOURCE_META: Record<
  'spotify' | 'deezer' | 'youtube_music' | 'apple_music',
  { label: string; initials: string; color: string }
> = {
  spotify: { label: 'Spotify', initials: 'SP', color: 'var(--color-svc-spotify)' },
  deezer: { label: 'Deezer', initials: 'DZ', color: 'var(--color-svc-deezer)' },
  youtube_music: { label: 'YouTube Music', initials: 'YT', color: 'var(--color-svc-youtube)' },
  apple_music: { label: 'Apple Music', initials: 'AM', color: 'var(--color-svc-apple)' },
}

// Auto-detects which of the 4 supported sources a pasted playlist link (or
// bare ID/URI) belongs to, so the import form can stay a single box instead
// of one per source.
function detectImportSource(
  raw: string,
): 'spotify' | 'deezer' | 'youtube_music' | 'apple_music' | null {
  const value = raw.trim()
  if (/spotify\.com|^spotify:/i.test(value)) return 'spotify'
  if (/deezer\.com|^deezer:/i.test(value)) return 'deezer'
  if (/music\.youtube\.com|youtube\.com|youtu\.be/i.test(value)) return 'youtube_music'
  if (/music\.apple\.com/i.test(value)) return 'apple_music'
  return null
}

function ImportSourceBadge({ source, url }: { source: string; url?: string }) {
  const meta = IMPORT_SOURCE_META[source as keyof typeof IMPORT_SOURCE_META]
  if (!meta) return null
  const href = url && isHttpUrl(url) ? url : undefined
  const commonProps = {
    title: meta.label,
    style: { borderColor: `${meta.color}40`, color: meta.color },
    className:
      'inline-flex items-center justify-center px-1.5 py-0.5 rounded text-micro font-bold border bg-surface/50 hover:opacity-80 transition-opacity',
  }
  return href ? (
    <a href={href} target="_blank" rel="noopener noreferrer" {...commonProps}>
      {meta.initials}
    </a>
  ) : (
    <span {...commonProps}>{meta.initials}</span>
  )
}

// Popup for adding a new imported playlist -- URL plus the two settings
// worth deciding up front (push to Plexamp, keep it in sync on a schedule)
// rather than making the user hunt for them in the row's own controls right
// after creation. Both default on: an import someone bothers to paste a link
// for is almost always meant to be live in Plexamp and stay current.
function ImportPlaylistDialog({
  onSave,
  onCancel,
}: {
  onSave: (data: { url: string; autoPushToPlex: boolean; schedule: string | null }) => Promise<void>
  onCancel: () => void
}) {
  const [url, setUrl] = useState('')
  const [autoPushToPlex, setAutoPushToPlex] = useState(true)
  const [useSchedule, setUseSchedule] = useState(true)
  const [schedule, setSchedule] = useState('0 5 * * *')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const urlInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    urlInputRef.current?.focus()

    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!url.trim()) return
    setError(null)
    setSubmitting(true)
    try {
      await onSave({ url: url.trim(), autoPushToPlex, schedule: useSchedule ? schedule : null })
    } catch (err) {
      setError(errMsg(err) || 'Import failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard handled via document useEffect above
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
      aria-label="Import a Playlist"
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: modal content panel */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: stop-propagation prevents backdrop dismiss */}
      <div
        className="bg-bg border border-border rounded-lg shadow-xl w-full max-w-md mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <h2 className="text-lg font-semibold text-text">Import a Playlist</h2>
          <p className="text-xs text-muted">
            Only Public playlists are readable this way -- make sure the playlist is marked Public
            in its source app.
          </p>

          {error && (
            <div className="text-sm text-reject bg-reject/10 border border-reject/20 rounded px-3 py-2">
              {error}
            </div>
          )}

          <div>
            <label htmlFor="import-url" className="block text-sm font-medium text-text mb-1">
              Paste a Spotify, Deezer, YouTube Music, or Apple Music playlist link
            </label>
            <input
              id="import-url"
              ref={urlInputRef}
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="Paste a Spotify, Deezer, YouTube Music, or Apple Music playlist link"
              className="w-full px-3 py-2 bg-surface border border-border rounded text-sm text-text placeholder:text-muted focus:border-accent focus:outline-none"
            />
          </div>

          <div className="flex items-center justify-between gap-2">
            <label htmlFor="import-push" className="text-sm text-text">
              Push to Plexamp
            </label>
            <Toggle checked={autoPushToPlex} onChange={setAutoPushToPlex} label="Push to Plexamp" />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm text-text">Refresh automatically</span>
              <Toggle
                checked={useSchedule}
                onChange={setUseSchedule}
                label="Schedule automatic generation"
              />
            </div>
            {useSchedule && <CronPicker value={schedule} onChange={setSchedule} />}
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onCancel}
              className="px-4 py-2 text-sm text-muted hover:text-text border border-border rounded"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || !url.trim()}
              className="px-4 py-2 text-sm bg-accent text-accent-fg rounded font-medium hover:opacity-90 disabled:opacity-60"
            >
              {submitting ? 'Importing…' : 'Import'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// Imported playlists (strategy 'import') get their own section instead of
// sitting in the generic Custom Playlists grid -- unlike every other
// strategy, they mirror an exact external playlist rather than generating
// one, so they need source-specific controls: whether re-syncing actually
// pushes to Plexamp and a list of tracks that didn't match. Creation happens
// in its own popup (ImportPlaylistDialog) rather than an inline form, so the
// push-to-Plexamp/schedule choices are made once up front instead of via the
// row's own controls right after creation.
function ImportPlaylistSection({
  playlists,
  onChanged,
}: {
  playlists: PlaylistRow[]
  onChanged: () => void
}) {
  const queryClient = useQueryClient()
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [scheduleEditId, setScheduleEditId] = useState<number | null>(null)
  const [scheduleDraft, setScheduleDraft] = useState('0 5 * * *')
  const [showAddDialog, setShowAddDialog] = useState(false)

  const importedRows = playlists.filter((p) => p.strategy === 'import')

  async function handleImport(data: {
    url: string
    autoPushToPlex: boolean
    schedule: string | null
  }) {
    const source = detectImportSource(data.url)
    if (!source) {
      throw new Error(
        "Couldn't tell which service that link is from -- paste a Spotify, Deezer, YouTube Music, or Apple Music playlist URL.",
      )
    }
    let createdId: number | undefined
    try {
      const created = await createPlaylistApi({
        name: `${IMPORT_SOURCE_META[source].label} Playlist`,
        strategy: 'import',
        schedule: data.schedule,
        autoPushToPlex: data.autoPushToPlex,
        config: {
          size: 0,
          trackSourcePriority: ['local'],
          importSource: source,
          importPlaylistId: data.url,
        },
        enabled: true,
      })
      createdId = created.id
      markPlaylistGenerating(queryClient, created.id)
      await generatePlaylistApi(created.id)
      toast.success('Import started')
      setShowAddDialog(false)
      onChanged()
    } catch (err) {
      if (createdId != null) clearPlaylistGenerating(queryClient, createdId)
      throw err
    }
  }

  async function handleTogglePush(row: PlaylistRow, autoPushToPlex: boolean) {
    try {
      await updatePlaylistApi(row.id, { autoPushToPlex })
      onChanged()
    } catch {
      toast.error('Failed to update playlist')
    }
  }

  async function handleToggleSchedule(row: PlaylistRow, enabled: boolean) {
    try {
      await updatePlaylistApi(row.id, { schedule: enabled ? scheduleDraft : null })
      onChanged()
    } catch {
      toast.error('Failed to update playlist')
    }
  }

  async function saveSchedule(row: PlaylistRow, cron: string) {
    setScheduleDraft(cron)
    try {
      await updatePlaylistApi(row.id, { schedule: cron })
      onChanged()
    } catch {
      toast.error('Failed to update playlist')
    }
  }

  return (
    <CollapsibleCard
      defaultCollapsed
      title="Import a Playlist"
      subtitle="Mirror a Spotify, Deezer, YouTube Music, or Apple Music playlist into Plex. Songs Plex already has get added; songs it doesn't show up below under missing tracks."
      headerExtra={
        <button
          type="button"
          onClick={() => setShowAddDialog(true)}
          aria-label="Import"
          title="Import"
          className="flex items-center justify-center size-8 bg-accent text-accent-fg rounded-md hover:opacity-90 transition-opacity shrink-0"
        >
          <Plus size={15} aria-hidden="true" />
        </button>
      }
    >
      {importedRows.length === 0 && (
        <p className="text-xs text-muted py-2">
          Only Public playlists are readable this way -- make sure the playlist is marked Public in
          its source app.
        </p>
      )}

      {importedRows.length > 0 && (
        <div className="divide-y divide-border pt-3 border-t border-border">
          {importedRows.map((row) => (
            <div key={row.id} className="py-2.5 flex items-start gap-2.5">
              <PlaylistCover
                name={row.name}
                coverUrl={row.coverUrl}
                collageUrls={row.collageUrls}
              />
              <div className="flex-1 min-w-0 space-y-1.5">
                <button
                  type="button"
                  onClick={() => setExpandedId(expandedId === row.id ? null : row.id)}
                  className="flex items-center gap-1.5 text-sm text-text hover:text-accent transition-colors w-full min-w-0"
                  aria-expanded={expandedId === row.id}
                >
                  {expandedId === row.id ? (
                    <ChevronDown size={14} aria-hidden="true" className="shrink-0" />
                  ) : (
                    <ChevronRight size={14} aria-hidden="true" className="shrink-0" />
                  )}
                  <span className="truncate">{row.name}</span>
                </button>
                <div className="flex items-center justify-between flex-wrap gap-2 ml-5">
                  <div className="flex items-center flex-wrap gap-2 min-w-0">
                    {row.config?.importSource && (
                      <ImportSourceBadge
                        source={row.config.importSource}
                        url={row.config.importPlaylistId}
                      />
                    )}
                    {row.trackCount != null && (
                      <span
                        className="text-xs text-muted"
                        title="Tracks currently matched into this Plex playlist -- may be fewer than the source playlist's total if some songs aren't in your library. See missing tracks below."
                      >
                        {`${row.trackCount} in Plex`}
                      </span>
                    )}
                    <GenerateButton playlistId={row.id} onGenerated={onChanged} />
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => {
                        setScheduleDraft(row.schedule ?? '0 5 * * *')
                        setScheduleEditId(scheduleEditId === row.id ? null : row.id)
                      }}
                      className={`flex items-center justify-center p-1.5 rounded border transition-colors ${
                        row.schedule != null
                          ? 'bg-accent/15 text-accent border-accent/40'
                          : 'text-muted border-border hover:text-accent hover:border-accent/40'
                      }`}
                      title={
                        row.schedule != null
                          ? `Edit schedule — ${formatSchedule(row.schedule)}`
                          : `Edit schedule — Manual`
                      }
                      aria-label="Edit schedule"
                      aria-expanded={scheduleEditId === row.id}
                    >
                      <Clock size={14} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleTogglePush(row, !row.autoPushToPlex)}
                      className={`flex items-center justify-center p-1.5 rounded border transition-colors ${
                        row.autoPushToPlex
                          ? 'bg-accent/15 text-accent border-accent/40'
                          : 'text-muted border-border hover:text-accent hover:border-accent/40'
                      }`}
                      title="Push to Plexamp"
                      aria-label="Push to Plexamp"
                      aria-pressed={row.autoPushToPlex}
                    >
                      <Upload size={14} aria-hidden="true" />
                    </button>
                    {row.pushedToPlex && <SweepLiveTracksButton playlistId={row.id} />}
                    <DeleteButton playlistId={row.id} onDeleted={onChanged} />
                  </div>
                </div>

                {scheduleEditId === row.id && (
                  <div className="sm:ml-5 sm:pl-3 sm:border-l border-border space-y-3 py-1">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm text-text">Refresh automatically</span>
                      <Toggle
                        checked={row.schedule != null}
                        onChange={(on) => handleToggleSchedule(row, on)}
                        label="Schedule automatic generation"
                      />
                    </div>
                    {row.schedule != null && (
                      <CronPicker
                        value={scheduleDraft}
                        onChange={(cron) => saveSchedule(row, cron)}
                      />
                    )}
                  </div>
                )}

                {expandedId === row.id && (
                  <div className="ml-5 pl-2 border-l border-border">
                    <p className="text-xs font-medium text-muted mb-0.5">Missing tracks</p>
                    <MissingTracksList playlistId={row.id} />
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {showAddDialog && (
        <ImportPlaylistDialog onSave={handleImport} onCancel={() => setShowAddDialog(false)} />
      )}
    </CollapsibleCard>
  )
}

// Admin-only oversight of every user's imported playlist -- lets an admin
// spot-check what's being mirrored into Plex, regenerate a stuck one, or
// remove one, without having to log in as each user. Separate section (not
// merged into ImportPlaylistSection above, which is scoped to the viewer's
// own imports) since it reads a different endpoint and shows an owner column
// the personal list has no use for.
const ADMIN_IMPORTS_QUERY_KEY = ['playlists', 'admin-imports'] as const

function AdminImportedPlaylistsSection() {
  const queryClient = useQueryClient()

  const { data: rows = [], isLoading } = useQuery<AdminImportedPlaylistRow[]>({
    queryKey: ADMIN_IMPORTS_QUERY_KEY,
    queryFn: getAdminImportedPlaylists,
  })

  function refetch() {
    queryClient.invalidateQueries({ queryKey: ADMIN_IMPORTS_QUERY_KEY })
  }

  if (!isLoading && rows.length === 0) return null

  return (
    <CollapsibleCard
      defaultCollapsed
      title="Imported Playlists — All Users"
      subtitle="Every user's imported playlist in one place -- regenerate, pause, or remove any of them."
    >
      {isLoading ? (
        <Skeleton className="h-16 w-full" />
      ) : (
        <div className="divide-y divide-border">
          {rows.map((row) => (
            <div key={row.id} className="py-2.5 flex items-center gap-2.5">
              <PlaylistCover
                name={row.name}
                coverUrl={row.coverUrl}
                collageUrls={row.collageUrls}
              />
              <div className="flex-1 min-w-0">
                <p className="text-sm text-text truncate">{row.name}</p>
                <div className="flex items-center flex-wrap gap-x-2 gap-y-1 mt-0.5">
                  {row.config?.importSource && (
                    <ImportSourceBadge
                      source={row.config.importSource}
                      url={row.config.importPlaylistId}
                    />
                  )}
                  <span className="text-xs text-muted">
                    Owner: <span className="text-text font-medium">{row.ownerUsername}</span>
                  </span>
                  {row.trackCount != null && (
                    <span
                      className="text-xs text-muted"
                      title="Tracks currently matched into this Plex playlist -- may be fewer than the source playlist's total if some songs aren't in your library. See missing tracks below."
                    >
                      {`${row.trackCount} in Plex`}
                    </span>
                  )}
                  {/* Paused imports never refresh on their own; say so rather
                      than leave them looking scheduled. */}
                  <span className={`text-xs ${row.enabled ? 'text-muted' : 'text-warning'}`}>
                    {row.enabled ? formatSchedule(row.schedule) : 'Paused'}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <EnabledToggle
                  playlistId={row.id}
                  enabled={row.enabled}
                  updateFn={setAdminImportedPlaylistEnabledApi}
                  queryKey={ADMIN_IMPORTS_QUERY_KEY}
                />
                <GenerateButton
                  playlistId={row.id}
                  onGenerated={refetch}
                  generateFn={generateAdminImportedPlaylistApi}
                />
                <DeleteButton
                  playlistId={row.id}
                  onDeleted={refetch}
                  deleteFn={deleteAdminImportedPlaylistApi}
                  className="p-1.5 text-muted hover:text-reject transition-colors"
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </CollapsibleCard>
  )
}

// PlaylistsPage

export function PlaylistsPage() {
  const queryClient = useQueryClient()
  const location = useLocation()
  const navigate = useNavigate()
  const [formMode, setFormMode] = useState<'create' | 'edit' | null>(null)
  const [editingPlaylist, setEditingPlaylist] = useState<PlaylistRow | null>(null)

  const { data: playlists = [], isLoading } = useQuery<PlaylistRow[]>({
    queryKey: ['playlists'],
    queryFn: getPlaylists,
  })

  const { data: authStatus } = useQuery({ queryKey: ['auth-status'], queryFn: getAuthStatus })
  const isAdmin = authStatus?.isAdmin ?? false

  const { data: schedulerInfo } = useQuery<{
    nextRun: string | null
    cron: string | null
    enabled: boolean
  }>({
    queryKey: ['playlists', 'scheduler'],
    queryFn: getPlaylistScheduler,
  })

  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: getSettings,
  })
  const prefs = (settings?.preferences as Record<string, unknown> | undefined) ?? {}
  const seasonalMasterEnabled = Boolean(prefs.seasonalPlaylistsEnabled)

  // Tristate outer switch for the seasonal category as a whole -- individual
  // presets keep their own on/off underneath (SeasonalPlaylistsSection).
  const toggleSeasonalMaster = useMutation({
    mutationFn: (enabled: boolean) =>
      updateSettings({ preferences: { seasonalPlaylistsEnabled: enabled } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['settings'] }),
    onError: (err) => toast.error(errMsg(err)),
  })

  useEffect(() => {
    const editId = (location.state as { editId?: number } | null)?.editId
    if (!editId || playlists.length === 0) return

    const playlist = playlists.find((row) => row.id === editId)
    if (!playlist) return

    setEditingPlaylist(playlist)
    setFormMode('edit')
    navigate(location.pathname, { replace: true, state: null })
  }, [location.pathname, location.state, navigate, playlists])

  function openCreate() {
    setEditingPlaylist(null)
    setFormMode('create')
  }

  function openEdit(playlist: PlaylistRow) {
    setEditingPlaylist(playlist)
    setFormMode('edit')
  }

  function closeForm() {
    setFormMode(null)
    setEditingPlaylist(null)
  }

  function refetch() {
    queryClient.invalidateQueries({ queryKey: ['playlists'] })
  }

  async function handleSave(data: PlaylistInsert) {
    try {
      if (formMode === 'edit' && editingPlaylist) {
        await updatePlaylistApi(editingPlaylist.id, data)
        toast.success('Playlist updated')
      } else {
        const created = await createPlaylistApi(data)
        toast.success('Playlist created')
        // The user already previewed an ai_prompt playlist before creating
        // it (enforced in PlaylistForm) -- generate and push immediately
        // instead of leaving them to find the "Generate" button on the card.
        if (data.strategy === 'ai_prompt') {
          markPlaylistGenerating(queryClient, created.id)
          generatePlaylistApi(created.id).catch(() => {
            clearPlaylistGenerating(queryClient, created.id)
            toast.error('Failed to start generation')
          })
        }
      }
      closeForm()
      refetch()
    } catch {
      toast.error(formMode === 'edit' ? 'Failed to update playlist' : 'Failed to create playlist')
    }
  }

  // Custom Playlists: everything that isn't seasonal/daily_mix, isn't one of
  // the curated strategies (those live as rows inside CuratedPlaylistsSection
  // above), and isn't an imported playlist (its own ImportPlaylistSection
  // below) -- in practice ai_prompt (Mediasage + free-text prompt) and
  // "Duplicate to Plexamp" snapshot copies.
  const customPlaylists = playlists.filter(
    (p) =>
      p.strategy !== 'seasonal' &&
      p.strategy !== 'daily_mix' &&
      p.strategy !== 'import' &&
      !isCuratedStrategy(p.strategy),
  )

  return (
    <div className="p-6 space-y-6 max-w-6xl mx-auto pb-24 md:pb-6">
      {/* Page header: title + a status line reflecting this user's own
          scheduled playlists. Generation is per-playlist (each row has its
          own enabled toggle + cron below) -- there's no global on/off here
          anymore. */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex-1 min-w-0">
          <h1 className="text-2xl font-display tracking-wide text-text">Playlists</h1>
          <p className="text-xs text-muted mt-0.5">
            {schedulerInfo
              ? formatSchedulerSubtitle(schedulerInfo)
              : 'Automatic music digest generation'}
          </p>
        </div>
      </div>

      {!isLoading && (
        <SeasonalPlaylistsSection
          playlists={playlists}
          masterEnabled={seasonalMasterEnabled}
          onToggleMaster={(next) => toggleSeasonalMaster.mutate(next)}
          onChanged={refetch}
        />
      )}

      {!isLoading && (
        <CuratedPlaylistsSection
          playlists={playlists}
          onEdit={openEdit}
          onChanged={refetch}
          onCreate={openCreate}
        />
      )}

      {!isLoading && customPlaylists.length > 0 && (
        <CollapsibleCard
          defaultCollapsed
          title="Custom Playlists"
          subtitle="AI-prompt playlists (including Discover Mix) and frozen copies you’ve duplicated to Plexamp."
        >
          <span className="text-xs text-muted">
            {customPlaylists.length} {customPlaylists.length === 1 ? 'playlist' : 'playlists'}
          </span>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {customPlaylists.map((playlist) => (
              <PlaylistCard
                key={playlist.id}
                playlist={playlist}
                onEdit={() => openEdit(playlist)}
                onRefetch={refetch}
              />
            ))}
          </div>
        </CollapsibleCard>
      )}

      {isLoading && <SkeletonGrid />}

      <MediasageSection onCreated={refetch} />

      <ImportPlaylistSection playlists={playlists} onChanged={refetch} />

      {isAdmin && <AdminImportedPlaylistsSection />}

      {/* Create / Edit modal */}
      {formMode && (
        <PlaylistForm
          playlist={editingPlaylist ?? undefined}
          onSave={handleSave}
          onCancel={closeForm}
        />
      )}
    </div>
  )
}
