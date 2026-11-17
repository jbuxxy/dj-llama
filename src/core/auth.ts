import { randomBytes } from 'node:crypto'

/**
 * Value for users.password_hash, which is NOT NULL but never checked: every
 * account signs in with Plex and there is no local password login. This
 * isn't in salt:hash form, so nothing could ever verify against it.
 */
export function unusablePasswordHash(): string {
  return `!${randomBytes(32).toString('hex')}`
}

export function generateSessionToken(): string {
  return randomBytes(32).toString('hex')
}
