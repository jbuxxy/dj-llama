import { and, asc, desc, eq, isNotNull, isNull, lt, ne, or } from 'drizzle-orm'
import type { Database } from '@/db'
import type { PlaylistConfig, PlaylistStrategy } from '@/db/schema'
import { playlists, playlistTracks, users } from '@/db/schema'
import type { Cursor } from '@/server/helpers/pagination-cursor'

export type PlaylistInsert = {
  userId?: number | null
  name: string
  strategy: PlaylistStrategy
  targetIds?: number[]
  schedule?: string | null
  config?: PlaylistConfig | null
  enabled?: boolean
  autoPushToPlex?: boolean
  description?: string | null
  status?: string
}

export type PlaylistUpdate = Partial<
  Pick<
    PlaylistInsert,
    'name' | 'strategy' | 'targetIds' | 'schedule' | 'config' | 'enabled' | 'autoPushToPlex'
  > & {
    lastGeneratedAt: Date | null
    trackCount: number
    status: string
    pushedToPlex: boolean
    reviewExpiresAt: Date | null
    description: string | null
    coverUrl: string | null
  }
>

export type PlaylistRow = typeof playlists.$inferSelect

export type PlaylistTrackInsert = {
  playlistId: number
  artistName: string
  trackName?: string | null
  mbid?: string | null
  spotifyUri?: string | null
  deezerId?: string | null
  localPath?: string | null
  position: number
}

export type PlaylistTrackRow = typeof playlistTracks.$inferSelect

export async function createPlaylist(db: Database, data: PlaylistInsert): Promise<{ id: number }> {
  const [row] = await db
    .insert(playlists)
    .values({
      userId: data.userId ?? null,
      name: data.name,
      strategy: data.strategy,
      targetIds: data.targetIds ?? [],
      schedule: data.schedule ?? null,
      config: data.config ?? null,
      enabled: data.enabled ?? true,
      autoPushToPlex: data.autoPushToPlex ?? false,
      description: data.description ?? null,
      ...(data.status !== undefined ? { status: data.status } : {}),
    })
    .returning({ id: playlists.id })
  if (!row) throw new Error('createPlaylist: no row returned')
  return { id: row.id }
}

export async function getPlaylistsByUser(
  db: Database,
  userId: number,
  opts: { limit?: number; cursor?: Cursor | null } = {},
): Promise<PlaylistRow[]> {
  const conditions = [eq(playlists.userId, userId)]
  if (opts.cursor) {
    conditions.push(
      or(
        lt(playlists.createdAt, new Date(opts.cursor.ts)),
        and(eq(playlists.createdAt, new Date(opts.cursor.ts)), lt(playlists.id, opts.cursor.id)),
      ) as NonNullable<ReturnType<typeof or>>,
    )
  }
  const base = db
    .select()
    .from(playlists)
    .where(and(...conditions))
    .orderBy(desc(playlists.createdAt), desc(playlists.id))
  return opts.limit ? base.limit(opts.limit) : base
}

export async function getEnabledPlaylists(db: Database): Promise<PlaylistRow[]> {
  return db.select().from(playlists).where(eq(playlists.enabled, true))
}

export type ImportedPlaylistWithOwner = PlaylistRow & { ownerUsername: string }

// Admin oversight view (Playlists page, admin-only section): every OTHER
// user's imported playlist in one place, so an admin can spot-check what's
// being mirrored into Plex without having to log in as each user. The
// requesting admin's own imports are excluded -- those already show in their
// personal Import a Playlist section higher up the same page, so listing
// them again here just duplicated the same rows.
export async function getImportedPlaylistsWithOwners(
  db: Database,
  opts: { excludeUserId?: number } = {},
): Promise<ImportedPlaylistWithOwner[]> {
  const conditions = [eq(playlists.strategy, 'import')]
  if (opts.excludeUserId != null) {
    conditions.push(ne(playlists.userId, opts.excludeUserId))
  }
  const rows = await db
    .select({ playlist: playlists, ownerUsername: users.username })
    .from(playlists)
    .innerJoin(users, eq(playlists.userId, users.id))
    .where(and(...conditions))
    .orderBy(desc(playlists.createdAt))
  return rows.map((r) => ({ ...r.playlist, ownerUsername: r.ownerUsername }))
}

export async function getPlaylistWithTracks(
  db: Database,
  playlistId: number,
): Promise<{ playlist: PlaylistRow; tracks: PlaylistTrackRow[] } | null> {
  const [playlist] = await db.select().from(playlists).where(eq(playlists.id, playlistId))
  if (!playlist) return null

  const tracks = await db
    .select()
    .from(playlistTracks)
    .where(eq(playlistTracks.playlistId, playlistId))
    .orderBy(asc(playlistTracks.position))

  return {
    playlist,
    tracks,
  }
}

export async function updatePlaylist(
  db: Database,
  id: number,
  data: PlaylistUpdate,
): Promise<void> {
  await db.update(playlists).set(data).where(eq(playlists.id, id))
}

export async function deletePlaylist(db: Database, id: number): Promise<void> {
  await db.delete(playlists).where(eq(playlists.id, id))
}

export async function replacePlaylistTracks(
  db: Database,
  playlistId: number,
  tracks: PlaylistTrackInsert[],
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(playlistTracks).where(eq(playlistTracks.playlistId, playlistId))
    if (tracks.length > 0) {
      await tx.insert(playlistTracks).values(
        tracks.map((t, i) => ({
          playlistId,
          artistName: t.artistName,
          trackName: t.trackName ?? null,
          mbid: t.mbid ?? null,
          spotifyUri: t.spotifyUri ?? null,
          deezerId: t.deezerId ?? null,
          localPath: t.localPath ?? null,
          position: i,
        })),
      )
    }
  })
}

// pending_review rows whose review window has lapsed -- reviewExpiresAt is
// always null for 'active' rows and for ai_prompt/seasonal playlists (which
// never use this expiry mechanism), so this only ever matches auto-generated,
// non-auto-added playlists nobody acted on in time.
export async function getExpiredReviewPlaylists(db: Database, now: Date): Promise<PlaylistRow[]> {
  return db
    .select()
    .from(playlists)
    .where(
      and(
        eq(playlists.status, 'pending_review'),
        isNotNull(playlists.reviewExpiresAt),
        lt(playlists.reviewExpiresAt, now),
      ),
    )
}

// Returns enabled playlists that have never been generated or whose last
// generation was more than 7 days ago. The scheduler does finer cron
// evaluation on top of this.
export async function getPlaylistsDueForGeneration(db: Database): Promise<PlaylistRow[]> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
  const rows = await db
    .select()
    .from(playlists)
    .where(
      and(
        eq(playlists.enabled, true),
        or(isNull(playlists.lastGeneratedAt), lt(playlists.lastGeneratedAt, sevenDaysAgo)),
      ),
    )
  return rows
}
