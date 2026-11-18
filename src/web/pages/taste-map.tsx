import { useMutation, useQuery } from '@tanstack/react-query'
import { Minus, Plus, RotateCcw } from 'lucide-react'
import { type PointerEvent, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { Button } from '../components/ui/button'
import { Skeleton } from '../components/ui/skeleton'
import { getCurrentUser, getTasteMap, refreshTasteMap, type TasteMapPoint } from '../lib/api'
import { cn } from '../lib/utils'

// Kind is the color (three validated slots -- a scatter can't carry more and
// stay distinguishable); shape repeats it so color is never the only cue.
const KINDS: Array<{ kind: TasteMapPoint['kind']; label: string; color: string }> = [
  { kind: 'owned', label: 'In your library', color: 'var(--color-viz-1)' },
  { kind: 'recommended', label: 'Recommended', color: 'var(--color-viz-2)' },
  { kind: 'keeper', label: 'Keepers', color: 'var(--color-viz-3)' },
]
const COLOR = Object.fromEntries(KINDS.map((k) => [k.kind, k.color])) as Record<
  TasteMapPoint['kind'],
  string
>

const SIZE = 1000
const PAD = 30
const MIN_ZOOM = 1
const MAX_ZOOM = 12

function Marker({
  p,
  x,
  y,
  r,
  dim,
}: {
  p: TasteMapPoint
  x: number
  y: number
  r: number
  dim: boolean
}) {
  const common = {
    fill: COLOR[p.kind],
    stroke: 'var(--color-surface)',
    strokeWidth: r * 0.5,
    opacity: dim ? 0.15 : p.kind === 'owned' ? 0.75 : 1,
  }
  if (p.kind === 'recommended') {
    const s = r * 1.15
    return (
      <rect
        x={x - s}
        y={y - s}
        width={s * 2}
        height={s * 2}
        transform={`rotate(45 ${x} ${y})`}
        {...common}
      />
    )
  }
  if (p.kind === 'keeper') {
    const s = r * 1.5
    return (
      <polygon
        points={`${x},${y - s} ${x + s * 0.95},${y + s * 0.7} ${x - s * 0.95},${y + s * 0.7}`}
        {...common}
      />
    )
  }
  return <circle cx={x} cy={y} r={r} {...common} />
}

export function TasteMapPage() {
  const navigate = useNavigate()
  const { data, isLoading } = useQuery({ queryKey: ['taste-map'], queryFn: getTasteMap })
  const { data: me } = useQuery({ queryKey: ['currentUser'], queryFn: getCurrentUser })
  const refresh = useMutation({
    mutationFn: refreshTasteMap,
    onSuccess: () =>
      toast.success('Embedding artists in the background. Reload in a minute to see the map.'),
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Could not start'),
  })
  const [genre, setGenre] = useState<string | null>(null)
  const [hidden, setHidden] = useState<Set<TasteMapPoint['kind']>>(new Set())
  const [view, setView] = useState<'map' | 'list'>('map')
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [hover, setHover] = useState<TasteMapPoint | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const drag = useRef<{ x: number; y: number; px: number; py: number; moved: boolean } | null>(null)

  const points = data?.map?.points ?? []
  const visible = useMemo(() => points.filter((p) => !hidden.has(p.kind)), [points, hidden])
  const counts = useMemo(() => {
    const c = { owned: 0, recommended: 0, keeper: 0 }
    for (const p of points) c[p.kind]++
    return c
  }, [points])

  // Data (0..1) -> SVG units, with the current pan/zoom.
  const sx = (v: number) => (PAD + v * (SIZE - 2 * PAD) - SIZE / 2) * zoom + SIZE / 2 + pan.x
  const sy = (v: number) => (PAD + (1 - v) * (SIZE - 2 * PAD) - SIZE / 2) * zoom + SIZE / 2 + pan.y

  function toSvg(e: { clientX: number; clientY: number }) {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0 }
    return {
      x: ((e.clientX - rect.left) / rect.width) * SIZE,
      y: ((e.clientY - rect.top) / rect.height) * SIZE,
    }
  }

  function nearest(at: { x: number; y: number }): TasteMapPoint | null {
    let best: TasteMapPoint | null = null
    let bestD = (14 * SIZE) / (svgRef.current?.getBoundingClientRect().width || SIZE)
    bestD *= bestD
    for (const p of visible) {
      const dx = sx(p.x) - at.x
      const dy = sy(p.y) - at.y
      const d = dx * dx + dy * dy
      if (d < bestD) {
        bestD = d
        best = p
      }
    }
    return best
  }

  function zoomAt(factor: number, at = { x: SIZE / 2, y: SIZE / 2 }) {
    const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom * factor))
    const k = next / zoom
    setPan((p) => ({
      x: at.x - (at.x - SIZE / 2 - p.x) * k - SIZE / 2,
      y: at.y - (at.y - SIZE / 2 - p.y) * k - SIZE / 2,
    }))
    setZoom(next)
  }

  function onPointerDown(e: PointerEvent<SVGSVGElement>) {
    const at = toSvg(e)
    drag.current = { x: at.x, y: at.y, px: pan.x, py: pan.y, moved: false }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  function onPointerMove(e: PointerEvent<SVGSVGElement>) {
    const at = toSvg(e)
    const d = drag.current
    if (d) {
      if (Math.abs(at.x - d.x) + Math.abs(at.y - d.y) > 4) d.moved = true
      if (d.moved) {
        setPan({ x: d.px + at.x - d.x, y: d.py + at.y - d.y })
        return
      }
    }
    setHover(nearest(at))
  }
  function onPointerUp(e: PointerEvent<SVGSVGElement>) {
    const d = drag.current
    drag.current = null
    if (d && !d.moved) {
      const hit = nearest(toSvg(e))
      if (hit?.mbid) navigate(`/requests/artist/${hit.mbid}`)
    }
  }

  const r = Math.max(3.2, 4 * Math.sqrt(zoom) * (points.length > 1200 ? 0.8 : 1))
  const labelled = visible.filter((p) => p.kind === 'keeper').slice(0, 12)

  return (
    <div className="max-w-6xl mx-auto px-4 py-6 space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-text">Taste Map</h1>
          <p className="text-sm text-muted max-w-2xl">
            Every artist in your library and every recommendation, placed by how they sound:
            neighbors are similar. Recommendations far from your library are DJ Llama stretching
            you; keepers are the stretches that stuck.
          </p>
        </div>
        {points.length > 0 && (
          <fieldset className="flex rounded-md border border-border overflow-hidden text-xs">
            <legend className="sr-only">View</legend>
            {(['map', 'list'] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                aria-pressed={view === v}
                className={cn(
                  'px-3 py-1.5 capitalize',
                  view === v ? 'bg-accent text-accent-fg' : 'text-muted hover:text-text',
                )}
              >
                {v}
              </button>
            ))}
          </fieldset>
        )}
      </div>

      {isLoading ? (
        <Skeleton className="w-full max-w-[min(100%,78vh)] mx-auto aspect-square rounded-lg" />
      ) : !data?.available ? (
        <div className="bg-surface border border-border rounded-lg p-6 text-center text-sm text-muted">
          The taste map needs an AI provider that can create embeddings (Gemini, OpenAI or Ollama).
          Change it in Settings &gt; Connections.
        </div>
      ) : points.length < 5 ? (
        <div className="bg-surface border border-border rounded-lg p-6 text-center space-y-3">
          <p className="text-sm text-muted">
            Not enough artists embedded yet. This fills in automatically overnight.
          </p>
          {me?.isAdmin && (
            <Button size="sm" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
              {refresh.isPending ? 'Starting...' : 'Build it now'}
            </Button>
          )}
        </div>
      ) : (
        <>
          {/* Filters: one row above the chart. */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <ul className="flex flex-wrap gap-3 text-xs" aria-label="Legend">
              {KINDS.map((k) => {
                const off = hidden.has(k.kind)
                return (
                  <li key={k.kind}>
                    <button
                      type="button"
                      aria-pressed={!off}
                      onClick={() =>
                        setHidden((prev) => {
                          const next = new Set(prev)
                          if (next.has(k.kind)) next.delete(k.kind)
                          else next.add(k.kind)
                          return next
                        })
                      }
                      className={cn(
                        'flex items-center gap-1.5',
                        off ? 'text-muted line-through' : 'text-text',
                      )}
                    >
                      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                        <Marker
                          p={{ kind: k.kind } as TasteMapPoint}
                          x={6}
                          y={6}
                          r={3.5}
                          dim={off}
                        />
                      </svg>
                      {k.label} <span className="text-muted tabular-nums">{counts[k.kind]}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
            {data.map && data.map.genres.length > 0 && (
              <fieldset className="flex flex-wrap gap-1.5">
                <legend className="sr-only">Highlight a genre</legend>
                {data.map.genres.map((g) => (
                  <button
                    key={g}
                    type="button"
                    onClick={() => setGenre(genre === g ? null : g)}
                    aria-pressed={genre === g}
                    className={cn(
                      'px-2 py-0.5 rounded-full border text-xs',
                      genre === g
                        ? 'border-accent text-accent'
                        : 'border-border text-muted hover:text-text',
                    )}
                  >
                    {g}
                  </button>
                ))}
              </fieldset>
            )}
          </div>

          {view === 'map' ? (
            <div className="relative bg-surface border border-border rounded-lg overflow-hidden w-full max-w-[min(100%,78vh)] mx-auto">
              <svg
                ref={svgRef}
                viewBox={`0 0 ${SIZE} ${SIZE}`}
                className="block w-full aspect-square touch-none cursor-grab active:cursor-grabbing select-none"
                role="img"
                aria-label={`Taste map of ${points.length} artists. Use the list view for a readable version.`}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerLeave={() => setHover(null)}
                onWheel={(e) => zoomAt(e.deltaY < 0 ? 1.2 : 1 / 1.2, toSvg(e))}
              >
                <g>
                  {/* Library first, so recommendations and keepers draw on top. */}
                  {(['owned', 'recommended', 'keeper'] as const).map((kind) =>
                    visible
                      .filter((p) => p.kind === kind)
                      .map((p) => (
                        <Marker
                          key={p.key}
                          p={p}
                          x={sx(p.x)}
                          y={sy(p.y)}
                          r={r}
                          dim={genre != null && p.genre !== genre}
                        />
                      )),
                  )}
                  {labelled.map((p) => (
                    <text
                      key={`l-${p.key}`}
                      x={sx(p.x) + r * 2}
                      y={sy(p.y) + 4}
                      fontSize={13}
                      fill="var(--color-text)"
                      stroke="var(--color-surface)"
                      strokeWidth={3}
                      paintOrder="stroke"
                      className="pointer-events-none"
                    >
                      {p.name}
                    </text>
                  ))}
                  {hover && (
                    <circle
                      cx={sx(hover.x)}
                      cy={sy(hover.y)}
                      r={r * 2.2}
                      fill="none"
                      stroke="var(--color-text)"
                      strokeWidth={1.5}
                      className="pointer-events-none"
                    />
                  )}
                </g>
              </svg>
              {hover && (
                <div className="absolute top-3 left-3 max-w-[70%] bg-bg/95 border border-border rounded-md px-3 py-2 shadow-sm pointer-events-none">
                  <p className="text-sm font-medium text-text truncate">{hover.name}</p>
                  <p className="text-xs text-muted">
                    {KINDS.find((k) => k.kind === hover.kind)?.label}
                    {hover.genre ? ` · ${hover.genre}` : ''}
                  </p>
                </div>
              )}
              <div className="absolute bottom-3 right-3 flex flex-col gap-1">
                <Button
                  size="icon"
                  variant="outline"
                  aria-label="Zoom in"
                  onClick={() => zoomAt(1.5)}
                >
                  <Plus size={14} />
                </Button>
                <Button
                  size="icon"
                  variant="outline"
                  aria-label="Zoom out"
                  onClick={() => zoomAt(1 / 1.5)}
                >
                  <Minus size={14} />
                </Button>
                <Button
                  size="icon"
                  variant="outline"
                  aria-label="Reset view"
                  onClick={() => {
                    setZoom(1)
                    setPan({ x: 0, y: 0 })
                  }}
                >
                  <RotateCcw size={14} />
                </Button>
              </div>
            </div>
          ) : (
            <TasteMapList points={visible.filter((p) => genre == null || p.genre === genre)} />
          )}
        </>
      )}
    </div>
  )
}

// The readable version of the map: every point, grouped by kind.
function TasteMapList({ points }: { points: TasteMapPoint[] }) {
  const navigate = useNavigate()
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      {KINDS.map((k) => {
        const rows = points
          .filter((p) => p.kind === k.kind)
          .sort((a, b) => a.name.localeCompare(b.name))
        return (
          <section key={k.kind} className="bg-surface border border-border rounded-lg p-3">
            <h2 className="text-xs font-semibold text-text uppercase tracking-wide mb-2">
              {k.label} <span className="text-muted font-normal">{rows.length}</span>
            </h2>
            <ul className="max-h-96 overflow-y-auto space-y-0.5 text-sm">
              {rows.map((p) => (
                <li key={p.key}>
                  <button
                    type="button"
                    disabled={!p.mbid}
                    onClick={() => p.mbid && navigate(`/requests/artist/${p.mbid}`)}
                    className="w-full text-left truncate text-text enabled:hover:text-accent disabled:cursor-default"
                  >
                    {p.name}
                    {p.genre && <span className="text-muted text-xs"> · {p.genre}</span>}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )
      })}
    </div>
  )
}
