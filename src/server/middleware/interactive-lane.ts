import type { Context, Next } from 'hono'
import { runInteractive } from '@/core/clients/musicbrainz'

/**
 * Routes a person is actively waiting on: their MusicBrainz lookups go to the
 * front of the shared rate-limited queue (see core/clients/musicbrainz.ts).
 * Long-running background work (scans, syncs, gap-fill) is never mounted
 * behind this, so it keeps the normal lane.
 */
export function interactiveLane(c: Context, next: Next): Promise<void> {
  void c
  return runInteractive(() => next())
}
