import { and, count, desc, eq, isNotNull, isNull, or } from 'drizzle-orm'
import type { RequestHistoryEntry } from '@/core/pipeline/track-taste'
import type { Database } from '@/db'
import { requests, users } from '@/db/schema'

type RequestRow = typeof requests.$inferSelect

export type RequestKind = 'artist' | 'album'
export type RequestStatus = 'pending' | 'dispatched' | 'failed' | 'rejected'

export type CreateRequestInput = {
  requestedByUserId: number
  kind: RequestKind
  artistMbid: string
  artistName: string
  releaseGroupMbid?: string
  albumTitle?: string
  coverUrl?: string
  sourcePlaylistId?: number
}

export async function createRequest(db: Database, data: CreateRequestInput): Promise<RequestRow> {
  const [row] = await db.insert(requests).values(data).returning()
  if (!row) throw new Error('createRequest: no row returned')
  return row
}

export async function getRequestById(db: Database, id: number): Promise<RequestRow | null> {
  const rows = await db.select().from(requests).where(eq(requests.id, id)).limit(1)
  return rows[0] ?? null
}

// Finds any prior request (regardless of status) for this album, so the
// playlist auto-request path can retry/update a failed or never-dispatched
// attempt in place instead of always inserting a fresh duplicate row on
// every playlist re-sync (see index.ts's autoRequestMissingPlaylistTracks).
export async function findRequestForAlbum(
  db: Database,
  userId: number,
  releaseGroupMbid: string,
): Promise<RequestRow | null> {
  const rows = await db
    .select()
    .from(requests)
    .where(
      and(eq(requests.requestedByUserId, userId), eq(requests.releaseGroupMbid, releaseGroupMbid)),
    )
    .orderBy(desc(requests.createdAt))
    .limit(1)
  return rows[0] ?? null
}

export type ListRequestsForUserResult = {
  items: RequestRow[]
  total: number
  // Failed rows across the whole Open Requests set (not just this page), so
  // the page can offer "Retry failed" even when they're on another page.
  // Only computed for libraryStatus 'open'.
  failedCount?: number
}

// excludeDismissed defaults to false so existing non-UI callers (taste-profile
// signal via getRequestHistoryForUser, playlist taste weighting via
// strategy-deps.ts) are unaffected by a user dismissing a row from their My
// Requests view -- dismiss only changes what that page shows, not what counts
// toward taste/playlist signal.
export async function listRequestsForUser(
  db: Database,
  userId: number,
  options?: {
    limit?: number
    offset?: number
    excludeDismissed?: boolean
    // undefined = no filter (default, used by taste/playlist callers below);
    // 'open' / 'in_library' drive the My Requests page's tab split server-side
    // so each tab pages through its own full set instead of a client-side
    // filter over one shared page.
    libraryStatus?: 'open' | 'in_library'
  },
): Promise<ListRequestsForUserResult> {
  const conditions = [eq(requests.requestedByUserId, userId)]
  if (options?.excludeDismissed) conditions.push(isNull(requests.dismissedAt))
  if (options?.libraryStatus === 'open') conditions.push(isNull(requests.libraryConfirmedAt))
  if (options?.libraryStatus === 'in_library')
    conditions.push(isNotNull(requests.libraryConfirmedAt))
  const where = and(...conditions)

  const [items, countRows, failedRows] = await Promise.all([
    db
      .select()
      .from(requests)
      .where(where)
      .orderBy(desc(requests.createdAt))
      .limit(options?.limit ?? 50)
      .offset(options?.offset ?? 0),
    db.select({ total: count() }).from(requests).where(where),
    options?.libraryStatus === 'open'
      ? db
          .select({ total: count() })
          .from(requests)
          .where(and(where, eq(requests.status, 'failed')))
      : Promise.resolve(undefined),
  ])

  return {
    items,
    total: countRows[0]?.total ?? 0,
    ...(failedRows && { failedCount: failedRows[0]?.total ?? 0 }),
  }
}

/** Every failed, still-open, undismissed request -- the "Retry failed" set. */
export async function listFailedOpenRequests(db: Database, userId: number): Promise<RequestRow[]> {
  return db
    .select()
    .from(requests)
    .where(
      and(
        eq(requests.requestedByUserId, userId),
        eq(requests.status, 'failed'),
        isNull(requests.dismissedAt),
        isNull(requests.libraryConfirmedAt),
      ),
    )
    .orderBy(desc(requests.createdAt))
}

/** Ownership is baked into the WHERE clause so a user can't dismiss another user's request. */
export async function dismissRequest(db: Database, id: number, userId: number): Promise<boolean> {
  const result = await db
    .update(requests)
    .set({ dismissedAt: new Date() })
    .where(and(eq(requests.id, id), eq(requests.requestedByUserId, userId)))
    .returning({ id: requests.id })
  return result.length > 0
}

/**
 * Bulk "Clear all" -- a single atomic UPDATE rather than looping
 * dismissRequest per id, since (unlike bulk approve/reject) there's no
 * external side effect per row to fail independently on. Only called for the
 * Added to Library tab today (see server/routes/requests.ts) -- Open
 * Requests is intentionally individual-dismiss-only so a still-in-flight
 * request can't be bulk-cleared without noticing each one.
 */
export async function dismissAllRequests(
  db: Database,
  userId: number,
  libraryStatus: 'open' | 'in_library',
): Promise<number> {
  const result = await db
    .update(requests)
    .set({ dismissedAt: new Date() })
    .where(
      and(
        eq(requests.requestedByUserId, userId),
        isNull(requests.dismissedAt),
        libraryStatus === 'open'
          ? isNull(requests.libraryConfirmedAt)
          : isNotNull(requests.libraryConfirmedAt),
      ),
    )
    .returning({ id: requests.id })
  return result.length
}

// Shared by index.ts's orchestrator (track-discovery branch) and
// strategy-deps.ts's getTrackTasteWeightedArtists -- both fed every request
// regardless of status into buildTrackTasteProfile, so a request an admin
// explicitly rejected, or one that failed to dispatch, counted the same
// toward "taste" as one that actually went through. Only pending/dispatched
// requests reflect something the requester still wants or got.
const TASTE_SIGNAL_STATUSES: ReadonlySet<RequestStatus> = new Set(['pending', 'dispatched'])

export function toRequestHistoryEntries(rows: RequestRow[]): RequestHistoryEntry[] {
  return rows
    .filter((r) => TASTE_SIGNAL_STATUSES.has(r.status as RequestStatus))
    .map((r) => ({
      artistName: r.artistName,
      albumTitle: r.albumTitle ?? undefined,
      createdAt: r.createdAt,
    }))
}

export type PendingRequestRow = RequestRow & { requestedByUsername: string }

export async function listPendingRequests(
  db: Database,
  options?: { limit?: number; offset?: number },
): Promise<PendingRequestRow[]> {
  const rows = await db
    .select({
      request: requests,
      requestedByUsername: users.username,
    })
    .from(requests)
    .innerJoin(users, eq(requests.requestedByUserId, users.id))
    .where(
      and(
        eq(requests.status, 'pending'),
        // Album-kind requests from an admin/owner/auto-approved user
        // auto-dispatch on creation (see POST /api/v1/requests) -- a
        // 'pending' row from one of them is always mid-dispatch, not
        // something waiting on a decision, and typically resolves within
        // seconds. Surfacing it here anyway invited a real race: an admin
        // could see it, click Approve, and kick off a second concurrent
        // dispatchRequest() call for the same request. Artist-kind (whole-
        // discography) requests always need a real decision regardless of
        // trust level, so those still show.
        or(
          eq(requests.kind, 'artist'),
          and(
            eq(users.isAdmin, false),
            eq(users.isOwner, false),
            eq(users.autoApproveRequests, false),
          ),
        ),
      ),
    )
    .orderBy(desc(requests.createdAt))
    .limit(options?.limit ?? 50)
    .offset(options?.offset ?? 0)

  return rows.map((r) => ({ ...r.request, requestedByUsername: r.requestedByUsername }))
}

export async function resolveRequest(
  db: Database,
  id: number,
  data: {
    status: RequestStatus
    decidedByUserId?: number
    rejectionReason?: string
    targetActions?: Record<string, unknown>
  },
): Promise<void> {
  await db
    .update(requests)
    .set({
      status: data.status,
      decidedByUserId: data.decidedByUserId,
      rejectionReason: data.rejectionReason,
      targetActions: data.targetActions,
      decidedAt: new Date(),
    })
    .where(eq(requests.id, id))
}

/** Only transitions rows still 'pending' -- a stale double-click on an already-decided request is a no-op. */
export async function resolvePendingRequest(
  db: Database,
  id: number,
  data: {
    status: RequestStatus
    decidedByUserId?: number
    rejectionReason?: string
    targetActions?: Record<string, unknown>
  },
): Promise<boolean> {
  const result = await db
    .update(requests)
    .set({
      status: data.status,
      decidedByUserId: data.decidedByUserId,
      rejectionReason: data.rejectionReason,
      targetActions: data.targetActions,
      decidedAt: new Date(),
    })
    .where(and(eq(requests.id, id), eq(requests.status, 'pending')))
    .returning({ id: requests.id })
  return result.length > 0
}
