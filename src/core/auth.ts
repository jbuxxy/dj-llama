import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

const SCRYPT_KEYLEN = 64
const SCRYPT_COST = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }

/** Returns `salt:hash` format. Works in both Bun and Node.js. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_COST).toString('hex')
  return `${salt}:${hash}`
}

/** Timing-safe comparison against a stored `salt:hash` string. */
export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':')
  if (!salt || !hash) return false
  // Try with current cost first, then fall back to default cost for pre-upgrade hashes
  const expected = Buffer.from(hash, 'hex')
  const computed = scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_COST)
  if (computed.byteLength === expected.byteLength && timingSafeEqual(computed, expected))
    return true
  const legacy = scryptSync(password, salt, SCRYPT_KEYLEN)
  if (legacy.byteLength !== expected.byteLength) return false
  return timingSafeEqual(legacy, expected)
}

export function generateSessionToken(): string {
  return randomBytes(32).toString('hex')
}
