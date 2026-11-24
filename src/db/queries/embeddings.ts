import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import type { Database } from '@/db'
import { artistEmbeddings, artists, libraryArtists, recommendations } from '@/db/schema'

export type EmbeddingSource = {
  name: string
  mbid: string | null
  genres: string[]
  tags: string[]
  description: string | null
}

/**
 * Every artist worth a point: everything recommended (the artists table) plus
 * every library artist from any source. Library rows with an MBID that's also
 * in `artists` defer to the richer artists row.
 */
export async function listEmbeddingSources(db: Database): Promise<EmbeddingSource[]> {
  const artistRows = await db
    .select({
      name: artists.name,
      mbid: artists.mbid,
      genres: artists.genres,
      tags: artists.tags,
      description: artists.description,
    })
    .from(artists)
  const libraryRows = await db
    .selectDistinctOn([libraryArtists.mbid, libraryArtists.nameNormalized], {
      name: libraryArtists.name,
      mbid: libraryArtists.mbid,
      genres: libraryArtists.genres,
    })
    .from(libraryArtists)
  const out: EmbeddingSource[] = artistRows.map((a) => ({
    name: a.name,
    mbid: a.mbid,
    genres: a.genres ?? [],
    tags: a.tags ?? [],
    description: a.description?.en ?? null,
  }))
  const seenMbids = new Set(artistRows.map((a) => a.mbid))
  for (const l of libraryRows) {
    if (l.mbid && seenMbids.has(l.mbid)) continue
    out.push({ name: l.name, mbid: l.mbid, genres: l.genres ?? [], tags: [], description: null })
  }
  return out
}

export async function getEmbeddingHashes(
  db: Database,
  model: string,
): Promise<Map<string, string>> {
  const rows = await db
    .select({ key: artistEmbeddings.key, hash: artistEmbeddings.textHash })
    .from(artistEmbeddings)
    .where(eq(artistEmbeddings.model, model))
  return new Map(rows.map((r) => [r.key, r.hash]))
}

export type EmbeddingRow = {
  key: string
  name: string
  mbid: string | null
  model: string
  vector: number[]
  textHash: string
}

export async function upsertEmbeddings(db: Database, rows: EmbeddingRow[]): Promise<void> {
  // Last row per key wins: Postgres rejects an ON CONFLICT DO UPDATE that touches a row twice
  const unique = [...new Map(rows.map((r) => [r.key, r])).values()]
  if (unique.length === 0) return
  await db
    .insert(artistEmbeddings)
    .values(unique.map((r) => ({ ...r, updatedAt: new Date() })))
    .onConflictDoUpdate({
      target: artistEmbeddings.key,
      set: {
        name: sql`excluded.name`,
        mbid: sql`excluded.mbid`,
        model: sql`excluded.model`,
        vector: sql`excluded.vector`,
        textHash: sql`excluded.text_hash`,
        updatedAt: sql`excluded.updated_at`,
      },
    })
}

export async function loadEmbeddings(db: Database, model: string): Promise<EmbeddingRow[]> {
  return db
    .select({
      key: artistEmbeddings.key,
      name: artistEmbeddings.name,
      mbid: artistEmbeddings.mbid,
      model: artistEmbeddings.model,
      vector: artistEmbeddings.vector,
      textHash: artistEmbeddings.textHash,
    })
    .from(artistEmbeddings)
    .where(eq(artistEmbeddings.model, model))
}

/** Embedding keys of everything in this user's library (their Plex rows plus shared Lidarr rows). */
export async function listLibraryKeysForUser(
  db: Database,
  userId: number,
): Promise<Array<{ mbid: string | null; nameNormalized: string }>> {
  return db
    .selectDistinct({ mbid: libraryArtists.mbid, nameNormalized: libraryArtists.nameNormalized })
    .from(libraryArtists)
    .where(sql`${libraryArtists.userId} = ${userId} or ${libraryArtists.userId} is null`)
}

export type RecommendedArtistForMap = {
  mbid: string
  outcome: string | null
  status: string
}

/** This user's recommended artists (latest rec per artist), for the taste map. */
export async function listRecommendedArtistsForUser(
  db: Database,
  userId: number,
): Promise<RecommendedArtistForMap[]> {
  return db
    .selectDistinctOn([artists.mbid], {
      mbid: artists.mbid,
      outcome: recommendations.outcome,
      status: recommendations.status,
    })
    .from(recommendations)
    .innerJoin(artists, eq(artists.id, recommendations.artistId))
    .where(eq(recommendations.userId, userId))
    .orderBy(artists.mbid, sql`${recommendations.createdAt} desc`)
}

export async function getArtistCardsByMbids(
  db: Database,
  mbids: string[],
): Promise<Map<string, { id: number; imageUrl: string | null; genres: string[] }>> {
  if (mbids.length === 0) return new Map()
  const rows = await db
    .select({
      id: artists.id,
      mbid: artists.mbid,
      imageUrl: artists.imageUrl,
      genres: artists.genres,
    })
    .from(artists)
    .where(and(inArray(artists.mbid, mbids), isNotNull(artists.mbid)))
  return new Map(
    rows.map((r) => [r.mbid, { id: r.id, imageUrl: r.imageUrl, genres: r.genres ?? [] }]),
  )
}
