import { useQuery } from '@tanstack/react-query'
import { type FormEvent, useState } from 'react'
import { toast } from 'sonner'
import { getCurrentUser, getSettings, moodDiscover, quickDiscover } from '../lib/api'
import { ArtistThumb } from './artist-thumb'

export function MoodPromptBar({
  existingArtistNames,
  onQueued,
}: {
  existingArtistNames: Set<string>
  onQueued: () => void
}) {
  // AI-powered feature -- hide it rather than let a user submit into a
  // guaranteed 400 (mood.ts rejects when no AI provider is configured).
  // Query keys match App.tsx/settings.tsx's own fetches, so this is a cache
  // hit (no extra request) whenever either has already loaded this session.
  const { data: settings, isLoading: settingsLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: getSettings,
  })
  const { data: currentUser } = useQuery({ queryKey: ['currentUser'], queryFn: getCurrentUser })
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Array<{
    artistName: string
    reasoning: string
    confidence: number
    genres: string[]
    suggestedAlbum?: string
    coverUrl?: string
    alreadyOwned: boolean
  }> | null>(null)
  const [loading, setLoading] = useState(false)
  const [queued, setQueued] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!query.trim() || loading) return
    setLoading(true)
    try {
      const res = await moodDiscover(query.trim())
      setResults(res.results)
    } catch (err) {
      const detail = err instanceof Error ? err.message.trim() : ''
      // ApiError.message falls back to "API Error <status>" - still worth showing.
      toast.error(detail ? `Mood discovery failed: ${detail}` : 'Mood discovery failed')
    } finally {
      setLoading(false)
    }
  }

  async function handleAddToQueue(artistName: string, suggestedAlbum?: string, reasoning?: string) {
    setQueued((prev) => new Set([...prev, artistName]))
    try {
      await quickDiscover(artistName, { suggestedAlbum, reasoning })
      toast.success(`Added "${artistName}" and discovering similar artists`)
      // Seed artist is stored async on the backend - poll for it to appear
      setTimeout(onQueued, 2000)
      setTimeout(onQueued, 5000)
    } catch {
      toast.error(`Failed to add "${artistName}"`)
      setQueued((prev) => {
        const next = new Set(prev)
        next.delete(artistName)
        return next
      })
    }
  }

  // Wait for settings to resolve before deciding -- otherwise an
  // AI-configured install would flash the "not configured" message on
  // every mount before the query resolves.
  if (settingsLoading) return null

  const aiConfigured = Boolean(settings?.aiProvider && settings?.aiModel)
  if (!aiConfigured) {
    return (
      <div className="mb-4 rounded border border-border bg-surface px-3 py-2.5 text-sm text-muted">
        {currentUser?.isAdmin
          ? "AI-powered mood discovery isn't set up yet. Configure an AI provider in Settings to enable it."
          : "AI-powered mood discovery isn't set up yet. Ask your admin to configure an AI provider."}
      </div>
    )
  }

  return (
    <div className="mb-4">
      <form onSubmit={handleSubmit} className="flex gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="rainy day jazz, upbeat 90s pop, dark ambient..."
          maxLength={500}
          className="flex-1 bg-surface border border-border rounded px-3 py-1.5 text-sm text-text placeholder:text-muted/50 focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-[-1px]"
        />
        <button
          type="submit"
          disabled={loading || !query.trim()}
          className="px-3 py-1.5 bg-accent text-accent-fg rounded text-sm font-medium hover:bg-accent/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
        >
          {loading ? 'Discovering...' : 'Discover'}
        </button>
      </form>
      {results && (
        <div className="mt-3">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-medium text-text">Mood results ({results.length})</h3>
            <button
              type="button"
              onClick={() => setResults(null)}
              className="text-xs text-muted hover:text-text"
            >
              Clear
            </button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {results.map((r) => {
              const isExpanded = expanded.has(r.artistName)
              const primary = r.suggestedAlbum ?? r.artistName
              const secondary = r.suggestedAlbum ? r.artistName : undefined
              return (
                // biome-ignore lint/a11y/useSemanticElements: intentional div[role=button] - nesting <button> inside <button> is invalid HTML
                <div
                  key={r.artistName}
                  role="button"
                  tabIndex={0}
                  onClick={() =>
                    setExpanded((prev) => {
                      const next = new Set(prev)
                      if (next.has(r.artistName)) next.delete(r.artistName)
                      else next.add(r.artistName)
                      return next
                    })
                  }
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      e.currentTarget.click()
                    }
                  }}
                  className="bg-surface border border-border rounded p-3 cursor-pointer hover:border-accent/40 transition-colors"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1 flex items-start gap-2.5">
                      <ArtistThumb
                        name={r.artistName}
                        imageUrl={r.coverUrl}
                        size={isExpanded ? 14 : 10}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="font-medium text-sm text-text truncate">{primary}</div>
                        {secondary && (
                          <div className="text-xs text-muted truncate">{secondary}</div>
                        )}
                        <p
                          className={`text-xs text-muted mt-1 ${isExpanded ? '' : 'line-clamp-2'}`}
                        >
                          {r.reasoning}
                        </p>
                        <div className="flex flex-wrap gap-1 mt-1.5">
                          {(isExpanded ? r.genres : r.genres.slice(0, 3)).map((g) => (
                            <span
                              key={g}
                              className="text-micro px-1.5 py-0.5 bg-bg border border-border rounded text-muted"
                            >
                              {g}
                            </span>
                          ))}
                        </div>
                      </div>
                    </div>
                    <div className="shrink-0">
                      {r.alreadyOwned ? (
                        <span className="text-micro text-muted px-2 py-1 bg-bg border border-border rounded">
                          Already in your library
                        </span>
                      ) : existingArtistNames.has(r.artistName.toLowerCase()) ? (
                        <span className="text-micro text-muted px-2 py-1 bg-bg border border-border rounded">
                          Pending review
                        </span>
                      ) : queued.has(r.artistName) ? (
                        <span className="text-micro text-approve px-2 py-1 bg-approve/10 border border-approve/20 rounded">
                          Added
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation()
                            handleAddToQueue(r.artistName, r.suggestedAlbum, r.reasoning)
                          }}
                          className="text-micro px-2 py-1 bg-accent/10 text-accent border border-accent/20 rounded hover:bg-accent/20 transition-colors"
                        >
                          + Request
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
