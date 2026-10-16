import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { errMsg } from '@/core/validation'
import {
  getGenres,
  type PlaylistInsert,
  type PlaylistPreview,
  type PlaylistRow,
  previewAiPlaylist,
  previewPlaylistFilterCountApi,
} from '../lib/api'
import { CronPicker } from './cron-picker'
import { Toggle } from './toggle'

const CURRENT_DECADE = Math.floor(new Date().getFullYear() / 10) * 10
const DECADE_OPTIONS: number[] = []
for (let decade = CURRENT_DECADE; decade >= 1950; decade -= 10) {
  DECADE_OPTIONS.push(decade)
}

type PlaylistFormProps = {
  playlist?: PlaylistRow
  onSave: (data: PlaylistInsert) => void
  onCancel: () => void
}

const STRATEGIES = [
  {
    value: 'weekly_digest',
    labelKey: 'Weekly Digest',
    descriptionKey: 'Curated selection from your recent discoveries',
  },
  {
    value: 'genre_focus',
    labelKey: 'Genre Focus',
    descriptionKey: 'Deep dive into a specific genre',
  },
  {
    value: 'mood_mix',
    labelKey: 'Mood Mix',
    descriptionKey: 'Tracks matching a specific mood or vibe',
  },
  {
    value: 'rediscover',
    labelKey: 'Rediscover',
    descriptionKey: 'Resurface artists you may have forgotten',
  },
  {
    value: 'ai_prompt',
    labelKey: 'AI Prompt',
    descriptionKey: 'Describe the playlist you want in your own words',
  },
] as const

export function PlaylistForm({ playlist, onSave, onCancel }: PlaylistFormProps) {
  const [name, setName] = useState(playlist?.name ?? '')
  const [strategy, setStrategy] = useState(playlist?.strategy ?? 'weekly_digest')
  const [schedule, setSchedule] = useState(playlist?.schedule ?? '0 8 * * 1')
  // New playlists start with the schedule toggle on (a real cron default is
  // already pre-filled below it) -- editing an existing row reflects whatever
  // it actually has. ai_prompt is excluded from this form's new-playlist
  // strategies (see visibleStrategies below), so this can't fight its
  // separate no-schedule default in mediasage-section.tsx.
  const [useSchedule, setUseSchedule] = useState(playlist ? !!playlist.schedule : true)
  const [size, setSize] = useState(playlist?.config?.size ?? 25)
  const [genre, setGenre] = useState(playlist?.config?.genre ?? '')
  const [mood, setMood] = useState(playlist?.config?.mood ?? '')
  const [prompt, setPrompt] = useState(playlist?.config?.prompt ?? '')
  const [enabled, setEnabled] = useState(playlist?.enabled ?? true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [previewResult, setPreviewResult] = useState<PlaylistPreview | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)

  // Manual (ai_prompt) generation filters -- mediasage-style filter-first
  // scoping, applied to the library candidate pool before the AI ever sees
  // it. See core/playlists/library-filter.ts.
  const [genreFilters, setGenreFilters] = useState<string[]>(playlist?.config?.genreFilters ?? [])
  const [decadeFilters, setDecadeFilters] = useState<number[]>(
    playlist?.config?.decadeFilters ?? [],
  )
  const [excludeLiveVersions, setExcludeLiveVersions] = useState(
    playlist?.config?.excludeLiveVersions ?? true,
  )
  const [useListeningHistory, setUseListeningHistory] = useState(
    playlist?.config?.useListeningHistory ?? true,
  )
  const [filterMatchCount, setFilterMatchCount] = useState<number | null>(null)

  const { data: genreOptions } = useQuery({
    queryKey: ['genres'],
    queryFn: getGenres,
    staleTime: 5 * 60_000,
  })

  function toggleGenreFilter(name: string) {
    setGenreFilters((prev) =>
      prev.includes(name) ? prev.filter((g) => g !== name) : [...prev, name],
    )
    setPreviewResult(null)
  }

  function toggleDecadeFilter(d: number) {
    setDecadeFilters((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]))
    setPreviewResult(null)
  }

  // Live "N albums match" feedback as filters change -- debounced so rapid
  // toggling doesn't fire a request per click.
  useEffect(() => {
    if (strategy !== 'ai_prompt') return
    const timer = setTimeout(() => {
      previewPlaylistFilterCountApi({ genreFilters, decadeFilters, excludeLiveVersions })
        .then((res) => setFilterMatchCount(res.count))
        .catch(() => setFilterMatchCount(null))
    }, 300)
    return () => clearTimeout(timer)
  }, [strategy, genreFilters, decadeFilters, excludeLiveVersions])

  // AI Prompt now has its own dedicated creation flow (MediasageSection,
  // always visible on the Playlists page with a guided mood quiz) rather
  // than living behind this dropdown -- keeps exactly one obvious path to
  // create one instead of two. Still shown here when editing a pre-existing
  // ai_prompt row (created before this change, or via that section) so
  // renaming/rescheduling it doesn't break.
  const isEditingAiPrompt = !!playlist && playlist.strategy === 'ai_prompt'
  const visibleStrategies = STRATEGIES.filter((s) => s.value !== 'ai_prompt' || isEditingAiPrompt)

  const isEdit = !!playlist

  function handlePromptChange(value: string) {
    setPrompt(value)
    // A previous preview no longer reflects the edited prompt.
    setPreviewResult(null)
  }

  async function handlePreview() {
    if (!prompt.trim()) return
    setPreviewing(true)
    setPreviewError(null)
    try {
      const result = await previewAiPlaylist(prompt.trim(), size, {
        useListeningHistory,
        genreFilters,
        decadeFilters,
        excludeLiveVersions,
      })
      setPreviewResult(result)
      if (result.tracks.length === 0) {
        setPreviewError(
          'No artists in your library or approved recommendations matched this description. Try a different description.',
        )
      }
    } catch (err) {
      setPreviewError(errMsg(err))
    } finally {
      setPreviewing(false)
    }
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) {
      setError('Name is required')
      return
    }
    if (strategy === 'genre_focus' && !genre.trim()) {
      setError('Genre is required for Genre Focus strategy')
      return
    }
    if (strategy === 'mood_mix' && !mood.trim()) {
      setError('Mood is required for Mood Mix strategy')
      return
    }
    if (strategy === 'ai_prompt' && !prompt.trim()) {
      setError('Description is required for AI Prompt strategy')
      return
    }
    if (strategy === 'ai_prompt' && !isEdit && !previewResult) {
      setError('Preview the playlist before creating it')
      return
    }
    setError(null)
    setSubmitting(true)
    try {
      const config = {
        size,
        trackSourcePriority: ['local', 'spotify', 'deezer'] as ('local' | 'spotify' | 'deezer')[],
        ...(strategy === 'genre_focus' ? { genre: genre.trim() } : {}),
        ...(strategy === 'mood_mix' ? { mood: mood.trim() } : {}),
        ...(strategy === 'ai_prompt'
          ? {
              prompt: prompt.trim(),
              useListeningHistory,
              genreFilters: genreFilters.length > 0 ? genreFilters : undefined,
              decadeFilters: decadeFilters.length > 0 ? decadeFilters : undefined,
              excludeLiveVersions,
            }
          : {}),
      }
      onSave({
        name: name.trim(),
        strategy,
        schedule: useSchedule ? schedule : null,
        config,
        enabled,
      })
    } catch (err: unknown) {
      setError(errMsg(err))
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
      aria-label={isEdit ? 'Edit playlist' : 'Create playlist'}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: modal content panel */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: stop-propagation prevents backdrop dismiss */}
      <div
        className="bg-bg border border-border rounded-lg shadow-xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <h2 className="text-lg font-semibold text-text">
            {isEdit ? 'Edit Playlist' : 'Create Playlist'}
          </h2>

          {error && (
            <div className="text-sm text-reject bg-reject/10 border border-reject/20 rounded px-3 py-2">
              {error}
            </div>
          )}

          <div>
            <label htmlFor="playlist-name" className="block text-sm font-medium text-text mb-1">
              Name
            </label>
            <input
              id="playlist-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Weekly Mix"
              className="w-full px-3 py-2 bg-surface border border-border rounded text-sm text-text placeholder:text-muted focus:border-accent focus:outline-none"
            />
          </div>

          <div>
            <label htmlFor="playlist-strategy" className="block text-sm font-medium text-text mb-1">
              Strategy
            </label>
            <select
              id="playlist-strategy"
              value={strategy}
              onChange={(e) => setStrategy(e.target.value)}
              className="w-full px-3 py-2 bg-surface border border-border rounded text-sm text-text focus:border-accent focus:outline-none"
            >
              {visibleStrategies.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.labelKey} - {s.descriptionKey}
                </option>
              ))}
            </select>
          </div>

          {strategy === 'genre_focus' && (
            <div>
              <label htmlFor="playlist-genre" className="block text-sm font-medium text-text mb-1">
                Genre
              </label>
              <input
                id="playlist-genre"
                type="text"
                value={genre}
                onChange={(e) => setGenre(e.target.value)}
                placeholder="shoegaze"
                className="w-full px-3 py-2 bg-surface border border-border rounded text-sm text-text placeholder:text-muted focus:border-accent focus:outline-none"
              />
            </div>
          )}

          {strategy === 'mood_mix' && (
            <div>
              <label htmlFor="playlist-mood" className="block text-sm font-medium text-text mb-1">
                Mood
              </label>
              <input
                id="playlist-mood"
                type="text"
                value={mood}
                onChange={(e) => setMood(e.target.value)}
                placeholder="late night driving"
                className="w-full px-3 py-2 bg-surface border border-border rounded text-sm text-text placeholder:text-muted focus:border-accent focus:outline-none"
              />
            </div>
          )}

          {strategy === 'ai_prompt' && (
            <div className="space-y-2">
              <div>
                <label
                  htmlFor="playlist-prompt"
                  className="block text-sm font-medium text-text mb-1"
                >
                  Describe your playlist
                </label>
                <textarea
                  id="playlist-prompt"
                  value={prompt}
                  onChange={(e) => handlePromptChange(e.target.value)}
                  placeholder="moody synth-pop for a rainy commute"
                  rows={3}
                  maxLength={2000}
                  className="w-full px-3 py-2 bg-surface border border-border rounded text-sm text-text placeholder:text-muted focus:border-accent focus:outline-none resize-none"
                />
                <p className="text-xs text-muted mt-1">
                  AI picks tracks only from artists already in your library or approved
                  recommendations - it won't invent new artists.
                </p>
              </div>

              {/* Filter-first scoping (mediasage-style): narrows the
                  candidate pool before the AI ever sees it. */}
              <div className="space-y-2 border border-border rounded p-2.5">
                {genreOptions && genreOptions.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-muted mb-1.5">Filter by genre</p>
                    <div className="flex flex-wrap gap-1.5">
                      {genreOptions.map((g) => {
                        const active = genreFilters.includes(g.name)
                        return (
                          <button
                            key={g.name}
                            type="button"
                            onClick={() => toggleGenreFilter(g.name)}
                            className={`px-2 py-0.5 text-xs rounded-full border transition-colors ${
                              active
                                ? 'bg-accent/15 border-accent/40 text-accent'
                                : 'border-border text-muted hover:text-text'
                            }`}
                          >
                            {g.name}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}

                <div>
                  <p className="text-xs font-medium text-muted mb-1.5">Any decade</p>
                  <div className="flex flex-wrap gap-1.5">
                    {DECADE_OPTIONS.map((d) => {
                      const active = decadeFilters.includes(d)
                      return (
                        <button
                          key={d}
                          type="button"
                          onClick={() => toggleDecadeFilter(d)}
                          className={`px-2 py-0.5 text-xs rounded-full border transition-colors ${
                            active
                              ? 'bg-accent/15 border-accent/40 text-accent'
                              : 'border-border text-muted hover:text-text'
                          }`}
                        >
                          {d}s
                        </button>
                      )
                    })}
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <label className="flex items-center gap-1.5 text-xs text-text">
                    <input
                      type="checkbox"
                      checked={excludeLiveVersions}
                      onChange={(e) => {
                        setExcludeLiveVersions(e.target.checked)
                        setPreviewResult(null)
                      }}
                      className="rounded border-border"
                    />
                    Exclude live versions
                  </label>

                  <label className="flex items-center gap-1.5 text-xs text-text">
                    <input
                      type="checkbox"
                      checked={useListeningHistory}
                      onChange={(e) => {
                        setUseListeningHistory(e.target.checked)
                        setPreviewResult(null)
                      }}
                      className="rounded border-border"
                    />
                    Blend in my recent Plex listening history
                  </label>
                </div>

                {filterMatchCount != null && (
                  <p className="text-xs text-muted">
                    {filterMatchCount > 0
                      ? `${filterMatchCount} albums match these filters`
                      : 'No albums match these filters'}
                  </p>
                )}
              </div>

              <button
                type="button"
                onClick={handlePreview}
                disabled={!prompt.trim() || previewing}
                className="px-3 py-1.5 text-sm border border-border rounded text-text hover:bg-surface disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {previewing ? 'Previewing...' : 'Preview'}
              </button>

              {previewError && <p className="text-xs text-reject">{previewError}</p>}

              {previewResult && previewResult.tracks.length > 0 && (
                <div className="border border-border rounded p-2 max-h-48 overflow-y-auto space-y-1">
                  <p className="text-xs text-muted">
                    {`${previewResult.tracks.length} tracks from ${previewResult.artistCount} artists`}
                  </p>
                  {previewResult.tracks.map((track) => (
                    <div
                      key={`${track.artistName}::${track.trackName}::${track.mbid ?? track.spotifyUri ?? track.deezerId ?? track.localPath ?? ''}`}
                      className="text-xs text-text truncate"
                    >
                      <span className="font-medium">{track.artistName}</span>
                      {track.trackName && <span className="text-muted"> — {track.trackName}</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div>
            <label htmlFor="playlist-size" className="block text-sm font-medium text-text mb-1">
              Track count
            </label>
            <input
              id="playlist-size"
              type="number"
              min={1}
              max={200}
              value={size}
              onChange={(e) => setSize(Number(e.target.value))}
              className="w-24 px-3 py-2 bg-surface border border-border rounded text-sm text-text focus:border-accent focus:outline-none"
            />
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-medium text-text">Refresh automatically</span>
              <Toggle
                checked={useSchedule}
                onChange={setUseSchedule}
                label="Schedule automatic generation"
              />
            </div>
            {useSchedule && <CronPicker value={schedule} onChange={setSchedule} />}
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="playlist-enabled"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="rounded border-border"
            />
            <label htmlFor="playlist-enabled" className="text-sm text-text">
              Enabled
            </label>
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
              disabled={submitting}
              className="px-4 py-2 text-sm bg-accent text-accent-fg rounded font-medium hover:opacity-90 disabled:opacity-60"
            >
              {submitting ? 'Saving...' : isEdit ? 'Save' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
