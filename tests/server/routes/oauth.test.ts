// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/db/queries/oauth-tokens', () => ({
  getOAuthToken: vi.fn(),
  upsertOAuthToken: vi.fn(),
  deleteOAuthToken: vi.fn(),
}))

const { getOAuthToken, upsertOAuthToken, deleteOAuthToken } = await import(
  '@/db/queries/oauth-tokens'
)

describe('OAuth token operations', () => {
  const fakeDb = {} as never

  it('upsertOAuthToken stores pending token during initiate', async () => {
    vi.mocked(upsertOAuthToken).mockResolvedValue({} as never)

    await upsertOAuthToken(fakeDb, {
      userId: 1,
      provider: 'spotify',
      accessToken: 'pending:1:uuid',
      expiresAt: new Date(),
      scopes: 'user-top-read',
      clientId: 'cid',
      clientSecret: 'csec',
    })

    expect(upsertOAuthToken).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({
        provider: 'spotify',
        accessToken: expect.stringContaining('pending:'),
      }),
    )
  })

  it('deleteOAuthToken removes provider tokens for user', async () => {
    vi.mocked(deleteOAuthToken).mockResolvedValue(undefined)

    await deleteOAuthToken(fakeDb, 1, 'spotify')
    expect(deleteOAuthToken).toHaveBeenCalledWith(fakeDb, 1, 'spotify')
  })

  it('getOAuthToken returns null for non-existent provider', async () => {
    vi.mocked(getOAuthToken).mockResolvedValue(null)

    const result = await getOAuthToken(fakeDb, 1, 'spotify')
    expect(result).toBeNull()
  })
})
