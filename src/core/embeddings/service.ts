// What the rest of the app asks of artist embeddings. Every method degrades
// to "nothing" when the configured AI provider can't embed, so callers don't
// need their own feature checks.

import { UMAP } from 'umap-js'
import { normalizeArtistName } from '@/core/library/normalize'
import type { RecommendationProvider } from '@/core/providers/types'
import type { Database } from '@/db'
import {
  getArtistCardsByMbids,
  listLibraryKeysForUser,
  listRecommendedArtistsForUser,
  upsertEmbeddings,
} from '@/db/queries/embeddings'
import {
  backfillEmbeddings,
  embeddingKey,
  embeddingText,
  getEmbeddingIndex,
  hashText,
  invalidateEmbeddingIndex,
  normalize,
} from './index'

export type EmbeddingProviderHandle = { provider: RecommendationProvider; model: string }

export type SimilarArtist = {
  name: string
  mbid: string | null
  score: number
  owned: boolean
  artistId: number | null
  imageUrl: string | null
}

export type TasteMapPoint = {
  key: string
  name: string
  mbid: string | null
  x: number
  y: number
  kind: 'owned' | 'recommended' | 'keeper'
  genre: string | null
}

export type TasteMap = {
  points: TasteMapPoint[]
  genres: string[]
  computedAt: string
}

const MAP_TTL_MS = 6 * 60 * 60 * 1000
const MAP_MAX_POINTS = 2500
const TOP_GENRES = 8

export function createEmbeddingService(deps: {
  db: Database
  /** The embedding-capable provider, or null when the configured one can't embed. */
  getProvider: () => Promise<EmbeddingProviderHandle | null>
}) {
  const { db } = deps
  const maps = new Map<number, { at: number; size: number; map: Promise<TasteMap> }>()

  async function libraryKeys(userId: number): Promise<Set<string>> {
    const rows = await listLibraryKeysForUser(db, userId)
    const keys = new Set<string>()
    for (const r of rows) {
      keys.add(r.mbid ? `mbid:${r.mbid}` : `name:${r.nameNormalized}`)
      // A library row with an MBID may have been embedded under its name if
      // it arrived before reconciliation; match both.
      if (r.mbid) keys.add(`name:${r.nameNormalized}`)
    }
    return keys
  }

  return {
    async available(): Promise<boolean> {
      return (await deps.getProvider()) != null
    },

    async backfill(onProgress?: (done: number, total: number) => void) {
      const handle = await deps.getProvider()
      if (!handle) return { embedded: 0, pending: 0, model: null }
      const result = await backfillEmbeddings(db, handle.provider, handle.model, onProgress)
      if (result.embedded > 0) maps.clear()
      return { ...result, model: handle.model }
    },

    /** "More like this": nearest artists to one artist, owned ones flagged. */
    async similar(
      userId: number,
      target: { mbid: string | null; name: string },
      limit = 12,
    ): Promise<SimilarArtist[] | null> {
      const handle = await deps.getProvider()
      if (!handle) return null
      const index = await getEmbeddingIndex(db, handle.model)
      const selfKey = embeddingKey(target)
      const vector =
        index.vectorOf(selfKey) ?? index.vectorOf(`name:${normalizeArtistName(target.name)}`)
      if (!vector) return []
      const owned = await libraryKeys(userId)
      const selfName = normalizeArtistName(target.name)
      const hits = index.nearest(
        vector,
        limit,
        (e) => e.key !== selfKey && normalizeArtistName(e.name) !== selfName,
      )
      const cards = await getArtistCardsByMbids(
        db,
        hits.map((h) => h.mbid).filter((m): m is string => !!m),
      )
      return hits.map((h) => {
        const card = h.mbid ? cards.get(h.mbid) : undefined
        return {
          name: h.name,
          mbid: h.mbid,
          score: Math.round(h.score * 1000) / 1000,
          owned: owned.has(h.key) || owned.has(`name:${normalizeArtistName(h.name)}`),
          artistId: card?.id ?? null,
          imageUrl: card?.imageUrl ?? null,
        }
      })
    },

    /**
     * Semantic score per candidate MBID: max similarity to anything in the
     * user's library, mapped from cosine to 0..1. Candidates without a vector
     * yet are embedded on the spot (one batched call) and stored.
     */
    async semanticScores(
      userId: number,
      candidates: Array<{ mbid: string; name: string; genres?: string[]; tags?: string[] }>,
    ): Promise<Map<string, number>> {
      const out = new Map<string, number>()
      const handle = await deps.getProvider()
      if (!handle?.provider.embed || candidates.length === 0) return out
      let index = await getEmbeddingIndex(db, handle.model)
      // One entry per MBID: the same artist can arrive from several seeds, and a
      // repeated key in one upsert fails the whole statement in Postgres
      const missing = [...new Map(candidates.map((c) => [c.mbid, c])).values()].filter(
        (c) => !index.vectorOf(`mbid:${c.mbid}`),
      )
      if (missing.length > 0) {
        const sources = missing.map((c) => ({
          name: c.name,
          mbid: c.mbid,
          genres: c.genres ?? [],
          tags: c.tags ?? [],
          description: null,
        }))
        const texts = sources.map(embeddingText)
        const vectors = await handle.provider.embed(texts)
        await upsertEmbeddings(
          db,
          sources.map((s, i) => ({
            key: embeddingKey(s),
            name: s.name,
            mbid: s.mbid,
            model: handle.model,
            vector: normalize(vectors[i] ?? []),
            textHash: hashText(handle.model, texts[i] as string),
          })),
        )
        invalidateEmbeddingIndex()
        index = await getEmbeddingIndex(db, handle.model)
      }
      const owned = await libraryKeys(userId)
      for (const c of candidates) {
        const v = index.vectorOf(`mbid:${c.mbid}`)
        if (!v) continue
        const best = index.maxSimilarity(v, owned)
        // Cosines between artist texts cluster well above 0; stretch the
        // useful range (≈0.5-1) over 0..1.
        if (best != null) out.set(c.mbid, Math.max(0, Math.min(1, (best - 0.5) * 2)))
      }
      return out
    },

    /** Library artists closest to a free-text mood, for instant results while the AI works. */
    async libraryMatchesForQuery(
      userId: number,
      query: string,
      limit = 6,
    ): Promise<Array<{ name: string; mbid: string | null; score: number }>> {
      const handle = await deps.getProvider()
      if (!handle?.provider.embed) return []
      const [vectors, index, owned] = await Promise.all([
        handle.provider.embed([`Music that sounds like: ${query}`]),
        getEmbeddingIndex(db, handle.model),
        libraryKeys(userId),
      ])
      const q = vectors[0]
      if (!q) return []
      return index
        .nearest(normalize(q), limit, (e) => owned.has(e.key))
        .map((h) => ({ name: h.name, mbid: h.mbid, score: h.score }))
    },

    /** 2D layout of the user's library and recommendations (UMAP; cached per user). */
    async tasteMap(userId: number): Promise<TasteMap | null> {
      const handle = await deps.getProvider()
      if (!handle) return null
      const index = await getEmbeddingIndex(db, handle.model)
      const hit = maps.get(userId)
      if (hit && Date.now() - hit.at < MAP_TTL_MS && hit.size === index.size) return hit.map
      const map = buildTasteMap(userId, index).catch((err) => {
        maps.delete(userId)
        throw err
      })
      maps.set(userId, { at: Date.now(), size: index.size, map })
      return map
    },
  }

  async function buildTasteMap(
    userId: number,
    index: Awaited<ReturnType<typeof getEmbeddingIndex>>,
  ): Promise<TasteMap> {
    const [owned, recs] = await Promise.all([
      libraryKeys(userId),
      listRecommendedArtistsForUser(db, userId),
    ])
    const kinds = new Map<string, TasteMapPoint['kind']>()
    for (const key of owned) if (index.vectorOf(key)) kinds.set(key, 'owned')
    for (const r of recs) {
      const key = `mbid:${r.mbid}`
      if (!index.vectorOf(key)) continue
      if (r.outcome === 'keeper') kinds.set(key, 'keeper')
      else if (!kinds.has(key)) kinds.set(key, 'recommended')
    }
    let keys = [...kinds.keys()]
    if (keys.length > MAP_MAX_POINTS) {
      // Keep every keeper and recommendation; thin the library evenly.
      const priority = keys.filter((k) => kinds.get(k) !== 'owned')
      const lib = keys.filter((k) => kinds.get(k) === 'owned')
      const step = lib.length / Math.max(1, MAP_MAX_POINTS - priority.length)
      keys = [...priority, ...lib.filter((_, i) => i % Math.ceil(step) === 0)].slice(
        0,
        MAP_MAX_POINTS,
      )
    }
    const { keys: placed, vectors } = index.vectorsFor(keys)
    const coords = project(vectors)

    const entries = new Map(index.entries.map((e) => [e.key, e]))
    const mbids = placed.map((k) => entries.get(k)?.mbid).filter((m): m is string => !!m)
    const cards = await getArtistCardsByMbids(db, mbids)
    const genreOf = (k: string): string | null => {
      const mbid = entries.get(k)?.mbid
      const g = mbid ? cards.get(mbid)?.genres[0] : undefined
      return g ? g.toLowerCase() : null
    }
    const counts = new Map<string, number>()
    for (const k of placed) {
      const g = genreOf(k)
      if (g) counts.set(g, (counts.get(g) ?? 0) + 1)
    }
    const genres = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_GENRES)
      .map(([g]) => g)
    const top = new Set(genres)
    return {
      points: placed.map((key, i) => {
        const e = entries.get(key)
        const g = genreOf(key)
        const [x, y] = coords[i] ?? [0, 0]
        return {
          key,
          name: e?.name ?? key,
          mbid: e?.mbid ?? null,
          x,
          y,
          kind: kinds.get(key) ?? 'owned',
          genre: g && top.has(g) ? g : null,
        }
      }),
      genres,
      computedAt: new Date().toISOString(),
    }
  }
}

/** UMAP to 2D, seeded so the same data lays out the same way; scaled to 0..1. */
export function project(vectors: number[][]): Array<[number, number]> {
  if (vectors.length === 0) return []
  let coords: number[][]
  if (vectors.length < 15) {
    coords = pca2(vectors)
  } else {
    const umap = new UMAP({
      nComponents: 2,
      nNeighbors: Math.min(15, vectors.length - 1),
      minDist: 0.15,
      random: seededRandom(42),
    })
    coords = umap.fit(vectors)
  }
  const xs = coords.map((c) => c[0] ?? 0)
  const ys = coords.map((c) => c[1] ?? 0)
  const [minX, maxX, minY, maxY] = [
    Math.min(...xs),
    Math.max(...xs),
    Math.min(...ys),
    Math.max(...ys),
  ]
  const sx = maxX - minX || 1
  const sy = maxY - minY || 1
  return coords.map((c) => [((c[0] ?? 0) - minX) / sx, ((c[1] ?? 0) - minY) / sy])
}

/** Two principal components by power iteration -- the small-data fallback. */
function pca2(vectors: number[][]): number[][] {
  const d = vectors[0]?.length ?? 0
  const mean = new Array<number>(d).fill(0)
  for (const v of vectors)
    for (let j = 0; j < d; j++) mean[j] = (mean[j] as number) + (v[j] ?? 0) / vectors.length
  const centered = vectors.map((v) => v.map((x, j) => x - (mean[j] as number)))
  const components: number[][] = []
  for (let c = 0; c < 2; c++) {
    let w = normalize(Array.from({ length: d }, (_, j) => Math.sin(j + c + 1)))
    for (let it = 0; it < 50; it++) {
      const next = new Array<number>(d).fill(0)
      for (const v of centered) {
        let dot = 0
        for (let j = 0; j < d; j++) dot += (v[j] as number) * (w[j] as number)
        for (let j = 0; j < d; j++) next[j] = (next[j] as number) + dot * (v[j] as number)
      }
      for (const prev of components) {
        let dot = 0
        for (let j = 0; j < d; j++) dot += (next[j] as number) * (prev[j] as number)
        for (let j = 0; j < d; j++) next[j] = (next[j] as number) - dot * (prev[j] as number)
      }
      w = normalize(next)
    }
    components.push(w)
  }
  return centered.map((v) =>
    components.map((w) => v.reduce((a, x, j) => a + x * (w[j] as number), 0)),
  )
}

function seededRandom(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}
