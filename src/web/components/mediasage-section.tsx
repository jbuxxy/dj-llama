import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { generateMixTitle } from '@/core/playlists/mix-title'
import { errMsg } from '@/core/validation'
import {
  createPlaylistApi,
  generatePlaylistApi,
  getGenres,
  getSettings,
  type PlaylistPreview,
  previewAiPlaylist,
  previewPlaylistFilterCountApi,
} from '../lib/api'
import { clearPlaylistGenerating, markPlaylistGenerating } from '../lib/generating-playlists'
import { CollapsibleCard } from './collapsible-card'
import { CronPicker } from './cron-picker'
import { Toggle } from './toggle'

const CURRENT_DECADE = Math.floor(new Date().getFullYear() / 10) * 10
const DECADE_OPTIONS: number[] = []
for (let decade = CURRENT_DECADE; decade >= 1950; decade -= 10) {
  DECADE_OPTIONS.push(decade)
}

// Mood-quiz: each question is optional (no selection = no fragment
// contributed) and maps to a short natural-language fragment that gets
// joined into the same free-text prompt the ai_prompt strategy already
// consumes (buildMoodPrompt/prompt.ts) -- no new AI plumbing, just a guided
// way to produce the prompt text instead of requiring the user to type one.
type QuizOption = { value: string; labelKey: string; fragment: string }

const ENERGY_OPTIONS: QuizOption[] = [
  {
    value: 'chill',
    labelKey: 'Chill & mellow',
    fragment: 'low-energy, mellow, laid-back tracks',
  },
  { value: 'upbeat', labelKey: 'Upbeat & energetic', fragment: 'upbeat, energetic tracks' },
  {
    value: 'intense',
    labelKey: 'High energy / intense',
    fragment: 'high-energy, intense tracks',
  },
]
const FAMILIARITY_OPTIONS: QuizOption[] = [
  {
    value: 'familiar',
    labelKey: 'Mostly music I already love',
    fragment: 'staying close to music the listener already loves',
  },
  {
    value: 'mixed',
    labelKey: 'A good mix of familiar and new',
    fragment: 'a mix of familiar favorites and newer discoveries',
  },
  {
    value: 'adventurous',
    labelKey: "Push toward my library's edges",
    fragment: "pushing toward lesser-played, more adventurous picks in the listener's library",
  },
]
const VOCAL_OPTIONS: QuizOption[] = [
  { value: 'vocals', labelKey: 'Vocals only', fragment: 'vocal tracks only' },
  {
    value: 'either',
    labelKey: 'Instrumental is fine too',
    fragment: 'instrumental tracks are welcome too',
  },
]
const VIBE_OPTIONS: QuizOption[] = [
  { value: 'focus', labelKey: 'Focus / study', fragment: 'good for focus or studying' },
  {
    value: 'party',
    labelKey: 'Party / social',
    fragment: 'good for a party or social setting',
  },
  {
    value: 'emotional',
    labelKey: 'Emotional / introspective',
    fragment: 'an emotional, introspective mood',
  },
  {
    value: 'background',
    labelKey: 'Background / ambient',
    fragment: 'unobtrusive background/ambient listening',
  },
]

function QuizRow({
  labelKey,
  options,
  value,
  onChange,
}: {
  labelKey: string
  options: QuizOption[]
  value: string | null
  onChange: (next: string | null) => void
}) {
  return (
    <div>
      <p className="text-xs font-medium text-muted mb-1.5">{labelKey}</p>
      <div className="flex flex-wrap gap-1.5">
        {options.map((opt) => {
          const active = value === opt.value
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => onChange(active ? null : opt.value)}
              className={`px-2 py-0.5 text-xs rounded-full border transition-colors ${
                active
                  ? 'bg-accent/15 border-accent/40 text-accent'
                  : 'border-border text-muted hover:text-text'
              }`}
            >
              {opt.labelKey}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function buildQuizPrompt(answers: {
  energy: string | null
  familiarity: string | null
  vocals: string | null
  vibe: string | null
}): string {
  const optionSets: [string | null, QuizOption[]][] = [
    [answers.energy, ENERGY_OPTIONS],
    [answers.familiarity, FAMILIARITY_OPTIONS],
    [answers.vocals, VOCAL_OPTIONS],
    [answers.vibe, VIBE_OPTIONS],
  ]
  const fragments = optionSets
    .map(([value, options]) => options.find((o) => o.value === value)?.fragment)
    .filter((f): f is string => !!f)
  if (fragments.length === 0) return ''
  return `A playlist that is ${fragments.join(', ')}.`
}

// Standalone mediasage-style creation section, always visible on the
// Playlists page (gated only on AI being configured) -- previously this
// filter-first flow was buried inside the generic "Create Playlist" modal,
// only reachable after picking ai_prompt from a strategy dropdown, with no
// guided way to describe what you want beyond free text. This is the one
// dedicated entry point for it; the generic header button now covers the
// four simple/direct strategies only.
export function MediasageSection({ onCreated }: { onCreated: () => void }) {
  const queryClient = useQueryClient()
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: getSettings })
  const aiConfigured = Boolean(settings?.aiProvider && settings?.aiModel)

  const [prompt, setPrompt] = useState('')
  const [energy, setEnergy] = useState<string | null>(null)
  const [familiarity, setFamiliarity] = useState<string | null>(null)
  const [vocals, setVocals] = useState<string | null>(null)
  const [vibe, setVibe] = useState<string | null>(null)
  const [size, setSize] = useState(25)
  const [genreFilters, setGenreFilters] = useState<string[]>([])
  const [decadeFilters, setDecadeFilters] = useState<number[]>([])
  const [excludeLiveVersions, setExcludeLiveVersions] = useState(true)
  const [useListeningHistory, setUseListeningHistory] = useState(true)
  const [filterMatchCount, setFilterMatchCount] = useState<number | null>(null)
  const [useSchedule, setUseSchedule] = useState(false)
  const [schedule, setSchedule] = useState('0 8 * * 1')
  const [previewResult, setPreviewResult] = useState<PlaylistPreview | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const { data: genreOptions } = useQuery({
    queryKey: ['genres'],
    queryFn: getGenres,
    staleTime: 5 * 60_000,
  })

  const effectivePrompt = [buildQuizPrompt({ energy, familiarity, vocals, vibe }), prompt.trim()]
    .filter(Boolean)
    .join(' ')

  function toggleGenreFilter(g: string) {
    setGenreFilters((prev) => (prev.includes(g) ? prev.filter((x) => x !== g) : [...prev, g]))
    setPreviewResult(null)
  }

  function toggleDecadeFilter(d: number) {
    setDecadeFilters((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]))
    setPreviewResult(null)
  }

  useEffect(() => {
    if (!effectivePrompt) {
      setFilterMatchCount(null)
      return
    }
    const timer = setTimeout(() => {
      previewPlaylistFilterCountApi({ genreFilters, decadeFilters, excludeLiveVersions })
        .then((res) => setFilterMatchCount(res.count))
        .catch(() => setFilterMatchCount(null))
    }, 300)
    return () => clearTimeout(timer)
  }, [genreFilters, decadeFilters, excludeLiveVersions, effectivePrompt])

  async function handlePreview() {
    if (!effectivePrompt) return
    setPreviewing(true)
    setPreviewError(null)
    try {
      const result = await previewAiPlaylist(effectivePrompt, size, {
        useListeningHistory,
        genreFilters,
        decadeFilters,
        excludeLiveVersions,
      })
      setPreviewResult(result)
      if (result.tracks.length === 0)
        setPreviewError(
          'No artists in your library or approved recommendations matched this description. Try a different description.',
        )
    } catch (err) {
      setPreviewError(errMsg(err))
    } finally {
      setPreviewing(false)
    }
  }

  async function handleCreate() {
    if (!effectivePrompt || !previewResult) return
    setSubmitting(true)
    try {
      const created = await createPlaylistApi({
        // Evocative generated title (e.g. "Golden Hour Groove - Jul 2026")
        // instead of asking the user to name it -- regenerated fresh on
        // every future Generate too (see generatePlaylist in
        // core/playlists/generator.ts), matching Daily Mix.
        name: generateMixTitle(),
        strategy: 'ai_prompt',
        schedule: useSchedule ? schedule : null,
        config: {
          size,
          trackSourcePriority: ['local', 'spotify', 'deezer'],
          prompt: effectivePrompt,
          useListeningHistory,
          genreFilters: genreFilters.length > 0 ? genreFilters : undefined,
          decadeFilters: decadeFilters.length > 0 ? decadeFilters : undefined,
          excludeLiveVersions,
        },
        enabled: true,
      })
      // ai_prompt playlists always start pending_review with no schedule tie
      // -- generate immediately so the user has something to Push/Reject
      // right away instead of hunting for a Generate button on the card.
      // Marked generating up front so the card that appears after onCreated()
      // below already shows the spinner instead of a static Generate button.
      markPlaylistGenerating(queryClient, created.id)
      generatePlaylistApi(created.id).catch(() => {
        clearPlaylistGenerating(queryClient, created.id)
        toast.error('Failed to start generation')
      })
      toast.success('Playlist created')
      setPrompt('')
      setEnergy(null)
      setFamiliarity(null)
      setVocals(null)
      setVibe(null)
      setPreviewResult(null)
      onCreated()
    } catch (err) {
      toast.error(errMsg(err))
    } finally {
      setSubmitting(false)
    }
  }

  if (!aiConfigured) return null

  return (
    <CollapsibleCard
      defaultCollapsed
      title="Discover Mix"
      subtitle="Describe a vibe, answer a few quick questions, or both -- AI picks albums from your own library and approved recommendations, scoped by genre/decade filters before it ever sees the full catalog."
    >
      <div className="space-y-2.5 border border-border rounded p-2.5">
        <p className="text-xs font-semibold text-text">Guide me (optional)</p>
        <QuizRow labelKey={'Energy'} options={ENERGY_OPTIONS} value={energy} onChange={setEnergy} />
        <QuizRow
          labelKey={'Familiar vs. new'}
          options={FAMILIARITY_OPTIONS}
          value={familiarity}
          onChange={setFamiliarity}
        />
        <QuizRow labelKey={'Vocals'} options={VOCAL_OPTIONS} value={vocals} onChange={setVocals} />
        <QuizRow labelKey={'Setting'} options={VIBE_OPTIONS} value={vibe} onChange={setVibe} />
      </div>

      <div>
        <label htmlFor="mediasage-prompt" className="block text-xs font-medium text-muted mb-1">
          Anything else? (optional)
        </label>
        <textarea
          id="mediasage-prompt"
          value={prompt}
          onChange={(e) => {
            setPrompt(e.target.value)
            setPreviewResult(null)
          }}
          placeholder="moody synth-pop for a rainy commute"
          rows={2}
          maxLength={2000}
          className="w-full px-3 py-2 bg-bg border border-border rounded text-sm text-text placeholder:text-muted focus:border-accent focus:outline-none resize-none"
        />
      </div>

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

      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor="mediasage-size" className="text-xs font-medium text-muted">
          Track count
        </label>
        <input
          id="mediasage-size"
          type="number"
          min={1}
          max={200}
          value={size}
          onChange={(e) => setSize(Number(e.target.value))}
          className="w-20 px-2 py-1 text-xs bg-bg border border-border rounded text-text focus:border-accent focus:outline-none"
        />
        <button
          type="button"
          onClick={handlePreview}
          disabled={!effectivePrompt || previewing}
          className="px-3 py-1.5 text-sm border border-border rounded text-text hover:bg-bg disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {previewing ? 'Previewing...' : 'Preview'}
        </button>
      </div>

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

      <div className="flex justify-end">
        <button
          type="button"
          onClick={handleCreate}
          disabled={!previewResult || submitting}
          className="px-4 py-2 text-sm bg-accent text-accent-fg rounded font-medium hover:opacity-90 disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {submitting ? 'Saving...' : 'Create & Generate'}
        </button>
      </div>
    </CollapsibleCard>
  )
}
