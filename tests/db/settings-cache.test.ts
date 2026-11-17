// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'
import type { Database } from '@/db'
import {
  getSettings,
  invalidateSettingsCache,
  isSetupComplete,
  updateSettings,
} from '@/db/queries/settings'

function fakeDb(row: Record<string, unknown>) {
  const state = { row: { ...row } }
  const limit = vi.fn(async () => [{ ...state.row }])
  const db = {
    select: vi.fn(() => ({ from: () => ({ limit }) })),
    insert: vi.fn(() => ({
      values: (v: Record<string, unknown>) => ({
        onConflictDoUpdate: async () => {
          state.row = { ...state.row, ...v }
        },
      }),
    })),
  }
  return { db: db as unknown as Database, limit, state }
}

describe('settings cache', () => {
  it('reuses one read across calls and hands out independent copies', async () => {
    const { db, limit } = fakeDb({ id: 1, aiModel: 'm1', preferences: { a: 1 } })
    const prefsOf = (row: Awaited<ReturnType<typeof getSettings>>) =>
      (row?.preferences ?? {}) as Record<string, unknown>
    const first = await getSettings(db)
    const second = await getSettings(db)
    expect(limit).toHaveBeenCalledTimes(1)
    prefsOf(first).a = 99
    expect(prefsOf(second).a).toBe(1)
    expect(prefsOf(await getSettings(db)).a).toBe(1)
  })

  it('re-reads after an update', async () => {
    const { db, limit } = fakeDb({ id: 1, aiModel: 'm1' })
    await getSettings(db)
    await updateSettings(db, { aiModel: 'm2' })
    expect((await getSettings(db))?.aiModel).toBe('m2')
    expect(limit).toHaveBeenCalledTimes(2)
  })

  it('remembers setup-complete once true until invalidated', async () => {
    const { db, limit, state } = fakeDb({ id: 1, setupComplete: true })
    expect(await isSetupComplete(db)).toBe(true)
    state.row.setupComplete = false
    expect(await isSetupComplete(db)).toBe(true)
    expect(limit).toHaveBeenCalledTimes(1)
    invalidateSettingsCache(db)
    expect(await isSetupComplete(db)).toBe(false)
  })
})
