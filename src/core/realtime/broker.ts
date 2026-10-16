import { EventEmitter } from 'node:events'

export type RealtimeEvent =
  // Something about this user's requests/recommendations/playlists changed
  // (library sync found a match, a missing track got auto-requested, etc.)
  // -- deliberately coarse: clients just refetch the relevant queries rather
  // than the server tracking exactly which one changed.
  | { type: 'library-updated' }
  // A request's fulfillment got confirmed -- the library sync found the
  // requested album/artist actually present (libraryConfirmedAt just got
  // stamped), distinct from its dispatch status changing.
  | { type: 'request-confirmed'; requestId: number }
  | { type: 'recommendation-confirmed'; recommendationId: number }
  // A request was created, approved, rejected, retried, or auto-dispatched
  // -- covers everything that changes what shows up in "My Requests" / the
  // admin pending queue, other than the library-confirmation case above.
  | { type: 'request-updated'; requestId: number }
  // A manually- or schedule-triggered playlist generation (custom, daily
  // mix/curated, or import) finished -- success or failure, so the button
  // that kicked it off knows to stop spinning either way.
  | { type: 'playlist-generated'; playlistId: number; status: 'success' | 'error' }
  // A Plex scrobble (completed play) just landed for this user -- see
  // server/routes/webhooks.ts's media.scrobble handler. Scoped deliberately
  // narrow (unlike library-updated's full invalidate) since this can fire
  // once per song.
  | { type: 'listening-updated' }
  // This user's recommendation activity feed changed -- an approve/reject
  // (single or bulk) just happened. Scan/subscription-run entries in that
  // same feed aren't wired to this yet; those still refresh on the existing
  // poll/focus cadence.
  | { type: 'activity-updated' }

/**
 * Minimal per-user pub/sub for pushing live updates to connected browser
 * tabs over SSE (see server/routes/realtime.ts). Deliberately not a
 * general-purpose event bus -- one EventEmitter per userId, created lazily
 * and dropped once nobody's listening, so this stays cheap even with many
 * users and no active connections.
 */
class RealtimeBroker {
  private readonly emitters = new Map<number, EventEmitter>()

  private emitterFor(userId: number): EventEmitter {
    let emitter = this.emitters.get(userId)
    if (!emitter) {
      emitter = new EventEmitter()
      emitter.setMaxListeners(50)
      this.emitters.set(userId, emitter)
    }
    return emitter
  }

  publish(userId: number, event: RealtimeEvent): void {
    this.emitters.get(userId)?.emit('event', event)
  }

  subscribe(userId: number, listener: (event: RealtimeEvent) => void): () => void {
    const emitter = this.emitterFor(userId)
    emitter.on('event', listener)
    return () => {
      emitter.off('event', listener)
      if (emitter.listenerCount('event') === 0) this.emitters.delete(userId)
    }
  }
}

export const realtimeBroker = new RealtimeBroker()
