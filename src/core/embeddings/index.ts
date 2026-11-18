// Artist embeddings: what gets embedded, the in-memory similarity index, and
// the backfill that keeps artist_embeddings current. See schema.ts
// (artistEmbeddings) for why this isn't pgvector.

import { createHash } from 'node:crypto'
import { normalizeArtistName } from '@/core/library/normalize'
import type { RecommendationProvider } from '@/core/providers/types'
import type { Database } from '@/db'
import {
  type EmbeddingRow,
  type EmbeddingSource,
  getEmbeddingHashes,
  listEmbeddingSources,
  loadEmbeddings,
  upsertEmbeddings,
} from '@/db/queries/embeddings'

export function embeddingKey(a: { mbid: string | null; name: string }): string {
  return a.mbid ? `mbid:${a.mbid}` : `name:${normalizeArtistName(a.name)}`
}

/** The text an artist is embedded from: name, genres, tags, a short bio. */
export function embeddingText(a: EmbeddingSource): string {
  const parts = [`Music artist: ${a.name}.`]
  const genres = [...new Set(a.genres.map((g) => g.toLowerCase()))].slice(0, 12)
  if (genres.length) parts.push(`Genres: ${genres.join(', ')}.`)
  const tags = [...new Set(a.tags.map((t) => t.toLowerCase()))]
    .filter((t) => !genres.includes(t))
    .slice(0, 12)
  if (tags.length) parts.push(`Tags: ${tags.join(', ')}.`)
  if (a.description) parts.push(a.description.replace(/\s+/g, ' ').slice(0, 400))
  return parts.join(' ')
}

export function hashText(model: string, text: string): string {
  return createHash('sha256').update(`${model}\n${text}`).digest('hex').slice(0, 32)
}

export function normalize(v: number[]): number[] {
  let n = 0
  for (const x of v) n += x * x
  const len = Math.sqrt(n) || 1
  return v.map((x) => x / len)
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += (a[i] as number) * (b[i] as number)
  return dot
}

// ── In-memory index ────────────────────────────────────────────────────────

export type IndexEntry = { key: string; name: string; mbid: string | null }

export class EmbeddingIndex {
  readonly dims: number
  private matrix: Float32Array
  private byKey = new Map<string, number>()

  constructor(
    readonly model: string,
    readonly entries: IndexEntry[],
    vectors: number[][],
  ) {
    this.dims = vectors[0]?.length ?? 0
    this.matrix = new Float32Array(entries.length * this.dims)
    vectors.forEach((v, i) => {
      this.matrix.set(v, i * this.dims)
      this.byKey.set((entries[i] as IndexEntry).key, i)
    })
  }

  get size(): number {
    return this.entries.length
  }

  vectorOf(key: string): Float32Array | null {
    const i = this.byKey.get(key)
    return i == null ? null : this.matrix.subarray(i * this.dims, (i + 1) * this.dims)
  }

  /** Top-k by cosine (vectors are unit-length, so a dot product). */
  nearest(
    query: ArrayLike<number>,
    k: number,
    accept: (e: IndexEntry) => boolean = () => true,
  ): Array<IndexEntry & { score: number }> {
    if (query.length !== this.dims) return []
    const top: Array<{ i: number; score: number }> = []
    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i] as IndexEntry
      if (!accept(entry)) continue
      const score = cosine(query, this.matrix.subarray(i * this.dims, (i + 1) * this.dims))
      if (top.length < k) {
        top.push({ i, score })
        top.sort((a, b) => b.score - a.score)
      } else if (score > (top[k - 1] as { score: number }).score) {
        top[k - 1] = { i, score }
        top.sort((a, b) => b.score - a.score)
      }
    }
    return top.map(({ i, score }) => ({ ...(this.entries[i] as IndexEntry), score }))
  }

  /** Highest similarity between `query` and any entry whose key is in `keys`. */
  maxSimilarity(query: ArrayLike<number>, keys: Set<string>): number | null {
    let best: number | null = null
    for (const key of keys) {
      const v = this.vectorOf(key)
      if (!v) continue
      const s = cosine(query, v)
      if (best == null || s > best) best = s
    }
    return best
  }

  /** Raw vectors for a subset, in the order given (skipping unknown keys). */
  vectorsFor(keys: string[]): { keys: string[]; vectors: number[][] } {
    const out: { keys: string[]; vectors: number[][] } = { keys: [], vectors: [] }
    for (const key of keys) {
      const v = this.vectorOf(key)
      if (!v) continue
      out.keys.push(key)
      out.vectors.push(Array.from(v))
    }
    return out
  }
}

let cached: Promise<EmbeddingIndex> | null = null
let cachedModel: string | null = null

/** The index for `model`, loaded once and reused until invalidated. */
export function getEmbeddingIndex(db: Database, model: string): Promise<EmbeddingIndex> {
  if (!cached || cachedModel !== model) {
    cachedModel = model
    cached = loadEmbeddings(db, model).then(
      (rows) =>
        new EmbeddingIndex(
          model,
          rows.map((r) => ({ key: r.key, name: r.name, mbid: r.mbid })),
          rows.map((r) => r.vector),
        ),
    )
    cached.catch(() => {
      cached = null
    })
  }
  return cached
}

export function invalidateEmbeddingIndex(): void {
  cached = null
}

// ── Backfill ───────────────────────────────────────────────────────────────

/**
 * The embedding model each provider's embed() uses (see the providers).
 * Providers without an entry (Anthropic, OpenAI-compatible) can't embed, and
 * the embedding features stay hidden.
 */
const EMBEDDING_MODELS: Record<string, string> = {
  gemini: 'gemini-embedding-001',
  openai: 'text-embedding-3-small',
  ollama: 'nomic-embed-text',
}

export function embeddingModelFor(providerId: string | null | undefined): string | null {
  return (providerId && EMBEDDING_MODELS[providerId]) || null
}

const BATCH = 100
// Bounds one run's cost and time; the rest catch up on the next run.
const MAX_PER_RUN = 3000

export async function backfillEmbeddings(
  db: Database,
  provider: RecommendationProvider,
  model: string,
  onProgress?: (done: number, total: number) => void,
): Promise<{ embedded: number; pending: number }> {
  if (!provider.embed) return { embedded: 0, pending: 0 }
  const [sources, hashes] = await Promise.all([
    listEmbeddingSources(db),
    getEmbeddingHashes(db, model),
  ])
  const todo: Array<{ source: EmbeddingSource; key: string; text: string; hash: string }> = []
  const seen = new Set<string>()
  for (const source of sources) {
    const key = embeddingKey(source)
    if (seen.has(key)) continue
    seen.add(key)
    const text = embeddingText(source)
    const hash = hashText(model, text)
    if (hashes.get(key) !== hash) todo.push({ source, key, text, hash })
  }
  const batch = todo.slice(0, MAX_PER_RUN)
  let embedded = 0
  for (let i = 0; i < batch.length; i += BATCH) {
    const chunk = batch.slice(i, i + BATCH)
    const vectors = await provider.embed(chunk.map((c) => c.text))
    const rows: EmbeddingRow[] = chunk.map((c, j) => ({
      key: c.key,
      name: c.source.name,
      mbid: c.source.mbid,
      model,
      vector: normalize(vectors[j] ?? []),
      textHash: c.hash,
    }))
    await upsertEmbeddings(
      db,
      rows.filter((r) => r.vector.length > 0),
    )
    embedded += rows.length
    onProgress?.(embedded, batch.length)
  }
  if (embedded > 0) invalidateEmbeddingIndex()
  return { embedded, pending: todo.length - batch.length }
}
