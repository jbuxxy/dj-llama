// Turns Plex's webhook event stream (play / pause / resume / scrobble / stop)
// into one record per play: completed, partial, or skipped. Plex only sends
// `media.scrobble` once a track passes ~90%, so a skip is the absence of a
// scrobble before the session ends -- a `media.stop`, or the next track's
// `media.play` (Plexamp often skips straight to the next track without a stop).
//
// State is per Plex account and in memory: a restart mid-track loses at most
// that one play's skip/partial signal (the scrobble, if it comes, still lands).

export type PlexPlayEvent =
  | 'media.play'
  | 'media.pause'
  | 'media.resume'
  | 'media.stop'
  | 'media.scrobble'

export type TrackRef = {
  ratingKey: string
  artistName: string
  trackName: string
  albumName?: string | null
  durationMs?: number | null
}

export type ClosedPlay = TrackRef & {
  completed: boolean
  skipped: boolean
  listenedMs: number | null
  playedAt: Date
}

type Session = {
  track: TrackRef
  startedAt: number
  pausedAt: number | null
  pausedMs: number
  scrobbled: boolean
  lastSeen: number
}

/** A stop under this much listening -- or under SKIP_FRACTION of the track -- counts as a skip. */
export const SKIP_MAX_MS = 30_000
export const SKIP_FRACTION = 0.3
// Sessions with no events for this long are dropped (a client that vanished
// without a stop). Long enough for any single track plus pauses.
const STALE_MS = 6 * 60 * 60 * 1000

export class ListeningSessions {
  private sessions = new Map<number, Session>()

  constructor(private now: () => number = Date.now) {}

  /**
   * Feeds one webhook event. Returns the plays it closed (0, 1 or 2 -- a
   * scrobble closes nothing but marks the session; a new `play` can close the
   * previous track), each ready to be written as a listening event.
   */
  handle(
    accountId: number,
    event: PlexPlayEvent,
    track: TrackRef,
    viewOffsetMs?: number | null,
  ): ClosedPlay[] {
    const now = this.now()
    this.sweep(now)
    const closed: ClosedPlay[] = []
    let s = this.sessions.get(accountId)

    // Any event for a different track ends the previous session.
    if (s && s.track.ratingKey !== track.ratingKey) {
      const prev = this.close(s, now, null)
      if (prev) closed.push(prev)
      this.sessions.delete(accountId)
      s = undefined
    }

    switch (event) {
      case 'media.play':
      case 'media.resume': {
        if (!s) {
          this.sessions.set(accountId, newSession(track, now, viewOffsetMs))
        } else if (s.pausedAt != null) {
          s.pausedMs += now - s.pausedAt
          s.pausedAt = null
        }
        break
      }
      case 'media.pause': {
        if (!s) {
          s = newSession(track, now, viewOffsetMs)
          this.sessions.set(accountId, s)
        }
        s.pausedAt ??= now
        break
      }
      case 'media.scrobble': {
        // Recorded as a completed play right away, so a missing stop never
        // loses it; the session stays open only to swallow the trailing stop.
        if (!s) {
          s = newSession(track, now, viewOffsetMs)
          this.sessions.set(accountId, s)
        }
        if (!s.scrobbled) {
          s.scrobbled = true
          closed.push({
            ...mergeTrack(s.track, track),
            completed: true,
            skipped: false,
            listenedMs: viewOffsetMs ?? listened(s, now),
            playedAt: new Date(s.startedAt),
          })
        }
        break
      }
      case 'media.stop': {
        if (s) {
          const play = this.close(s, now, viewOffsetMs ?? null, track)
          if (play) closed.push(play)
          this.sessions.delete(accountId)
        }
        break
      }
    }
    const live = this.sessions.get(accountId)
    if (live) live.lastSeen = now
    return closed
  }

  /** Ends an unscrobbled session as a skip or partial play; a scrobbled one is already recorded. */
  private close(
    s: Session,
    now: number,
    viewOffsetMs: number | null,
    latest?: TrackRef,
  ): ClosedPlay | null {
    if (s.scrobbled) return null
    const track = latest ? mergeTrack(s.track, latest) : s.track
    const ms = viewOffsetMs ?? listened(s, now)
    const duration = track.durationMs ?? null
    const skipped =
      ms < SKIP_MAX_MS || (duration != null && duration > 0 && ms < duration * SKIP_FRACTION)
    return { ...track, completed: false, skipped, listenedMs: ms, playedAt: new Date(s.startedAt) }
  }

  private sweep(now: number) {
    for (const [id, s] of this.sessions) if (now - s.lastSeen > STALE_MS) this.sessions.delete(id)
  }
}

function newSession(track: TrackRef, now: number, viewOffsetMs?: number | null): Session {
  // A play that starts mid-track (resumed from another device) backdates the
  // start so wall-clock listening still lines up with the position.
  return {
    track,
    startedAt: now - (viewOffsetMs ?? 0),
    pausedAt: null,
    pausedMs: 0,
    scrobbled: false,
    lastSeen: now,
  }
}

function listened(s: Session, now: number): number {
  const pausedNow = s.pausedAt != null ? now - s.pausedAt : 0
  return Math.max(0, now - s.startedAt - s.pausedMs - pausedNow)
}

function mergeTrack(a: TrackRef, b: TrackRef): TrackRef {
  return {
    ratingKey: a.ratingKey,
    artistName: a.artistName || b.artistName,
    trackName: a.trackName || b.trackName,
    albumName: a.albumName ?? b.albumName ?? null,
    durationMs: a.durationMs ?? b.durationMs ?? null,
  }
}
