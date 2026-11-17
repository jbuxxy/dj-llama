import { type RealtimeEvent, realtimeBroker } from '@/core/realtime/broker'

/**
 * Tells each affected user's open tabs that a write just landed. The write
 * functions in db/queries call this themselves, so a route or job that
 * changes a request or recommendation can't forget to -- other tabs would
 * otherwise sit stale with no error anywhere.
 */
export function notifyUsers(
  userIds: Iterable<number | null | undefined>,
  event: RealtimeEvent,
): void {
  for (const id of new Set(userIds)) {
    if (id != null) realtimeBroker.publish(id, event)
  }
}
