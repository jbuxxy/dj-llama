// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { clearImageFailures } from '@/core/ops/hygiene'

function makeUpdateDb(rowCount: number) {
  return {
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue({ rowCount }),
      }),
    }),
    delete: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue({ rowCount }),
    }),
  }
}

describe('clearImageFailures', () => {
  it('resets imageFailedAt on all artists', async () => {
    const db = makeUpdateDb(42)
    const result = await clearImageFailures(db as never)
    expect(result).toEqual({ tool: 'clear-image-failures', cleared: 42 })
  })
})
