// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { isSingleOwnerCollision, isUniqueViolation } from '@/core/db-errors'

function pgError(code: string, constraint: string): Error {
  return Object.assign(new Error('duplicate key value violates unique constraint'), {
    code,
    constraint,
  })
}

describe('isSingleOwnerCollision', () => {
  it('detects the users_single_owner partial-index violation', () => {
    expect(isSingleOwnerCollision(pgError('23505', 'users_single_owner'))).toBe(true)
  })

  it('rejects unrelated unique violations', () => {
    expect(isSingleOwnerCollision(pgError('23505', 'users_username_unique'))).toBe(false)
  })

  it('rejects non-unique-violation errors and non-error values', () => {
    expect(isSingleOwnerCollision(pgError('23503', 'users_single_owner'))).toBe(false)
    expect(isSingleOwnerCollision(null)).toBe(false)
    expect(isSingleOwnerCollision('nope')).toBe(false)
  })
})

describe('isUniqueViolation', () => {
  it('matches any 23505 when no constraint is given', () => {
    expect(isUniqueViolation(pgError('23505', 'anything'))).toBe(true)
  })

  it('scopes to a specific constraint when given', () => {
    expect(
      isUniqueViolation(pgError('23505', 'users_email_unique_idx'), 'users_email_unique_idx'),
    ).toBe(true)
    expect(isUniqueViolation(pgError('23505', 'other_constraint'), 'users_email_unique_idx')).toBe(
      false,
    )
  })
})
