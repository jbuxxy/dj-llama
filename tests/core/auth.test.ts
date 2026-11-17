import { describe, expect, it } from 'vitest'
import { generateSessionToken, unusablePasswordHash } from '@/core/auth'

describe('auth helpers', () => {
  // scrypt N=2^17 takes ~2-4s per hash - raise timeout for the full suite
  describe('unusablePasswordHash', () => {
    it('is random and never in salt:hash form', () => {
      const a = unusablePasswordHash()
      expect(a).not.toBe(unusablePasswordHash())
      expect(a.startsWith('!')).toBe(true)
      expect(a).not.toContain(':')
    })
  })

  describe('generateSessionToken', () => {
    it('returns a 64-char hex string', () => {
      const token = generateSessionToken()
      expect(token).toHaveLength(64)
      expect(token).toMatch(/^[0-9a-f]+$/)
    })

    it('generates unique tokens', () => {
      const tokens = new Set(Array.from({ length: 10 }, () => generateSessionToken()))
      expect(tokens.size).toBe(10)
    })
  })
})
