// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/core/auth', () => ({
  hashPassword: vi.fn(() => 'hashed-random'),
}))
vi.mock('@/core/auth/plex', () => ({
  getPlexServerSharedUsers: vi.fn(),
}))
vi.mock('@/db/queries/settings', () => ({
  getSettings: vi.fn(),
}))
vi.mock('@/db/queries/users', () => ({
  createUser: vi.fn(),
  getUserByPlexAccountId: vi.fn(),
  listPlexLinkedUsers: vi.fn(),
  updateUser: vi.fn(),
}))

import { getPlexServerSharedUsers } from '@/core/auth/plex'
import { syncPlexServerUsers } from '@/core/auth/plex-user-sync'
import { getSettings } from '@/db/queries/settings'
import {
  createUser,
  getUserByPlexAccountId,
  listPlexLinkedUsers,
  updateUser,
} from '@/db/queries/users'

const mockGetSettings = vi.mocked(getSettings)
const mockGetPlexServerSharedUsers = vi.mocked(getPlexServerSharedUsers)
const mockCreateUser = vi.mocked(createUser)
const mockGetUserByPlexAccountId = vi.mocked(getUserByPlexAccountId)
const mockListPlexLinkedUsers = vi.mocked(listPlexLinkedUsers)
const mockUpdateUser = vi.mocked(updateUser)

const db = {} as never

function configuredSettings(overrides = {}) {
  return {
    plexAdminToken: 'admin-token',
    plexMachineIdentifier: 'machine-1',
    plexMusicSectionIds: ['1'],
    ...overrides,
  } as never
}

describe('syncPlexServerUsers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockListPlexLinkedUsers.mockResolvedValue([])
  })

  it('returns an error without calling Plex when the admin connection is not configured', async () => {
    mockGetSettings.mockResolvedValue(null)

    const result = await syncPlexServerUsers(db)

    expect(result).toEqual({
      added: 0,
      updated: 0,
      revoked: 0,
      error: 'Plex admin connection not configured yet',
    })
    expect(mockGetPlexServerSharedUsers).not.toHaveBeenCalled()
  })

  it('returns an error when the Plex API call fails', async () => {
    mockGetSettings.mockResolvedValue(configuredSettings())
    mockGetPlexServerSharedUsers.mockRejectedValue(
      new Error('Plex shared-users lookup failed: 401'),
    )

    const result = await syncPlexServerUsers(db)

    expect(result.error).toBe('Plex shared-users lookup failed: 401')
    expect(result).toMatchObject({ added: 0, updated: 0, revoked: 0 })
  })

  it('creates a new local account for a Plex user not yet known, with a random unusable password', async () => {
    mockGetSettings.mockResolvedValue(configuredSettings())
    mockGetPlexServerSharedUsers.mockResolvedValue([
      { accountId: 111, username: 'alice', email: 'alice@example.com', hasMusicAccess: true },
    ])
    mockGetUserByPlexAccountId.mockResolvedValue(null)

    const result = await syncPlexServerUsers(db)

    expect(result.added).toBe(1)
    expect(mockCreateUser).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        username: 'alice',
        passwordHash: 'hashed-random',
        isAdmin: false,
        email: 'alice@example.com',
        plexAccountId: 111,
        authProvider: 'plex',
        hasMusicAccess: true,
      }),
    )
  })

  it('updates an existing user when their music access, username, or revoked status changed', async () => {
    mockGetSettings.mockResolvedValue(configuredSettings())
    mockGetPlexServerSharedUsers.mockResolvedValue([
      { accountId: 111, username: 'alice2', email: null, hasMusicAccess: true },
    ])
    mockGetUserByPlexAccountId.mockResolvedValue({
      id: 5,
      username: 'alice',
      hasMusicAccess: false,
      plexAccessRevokedAt: null,
    } as never)

    const result = await syncPlexServerUsers(db)

    expect(result.updated).toBe(1)
    expect(result.added).toBe(0)
    expect(mockUpdateUser).toHaveBeenCalledWith(db, 5, {
      username: 'alice2',
      hasMusicAccess: true,
      plexAccessRevokedAt: null,
    })
  })

  it('un-revokes a previously revoked user who reappears in the shared-users list', async () => {
    mockGetSettings.mockResolvedValue(configuredSettings())
    mockGetPlexServerSharedUsers.mockResolvedValue([
      { accountId: 111, username: 'alice', email: null, hasMusicAccess: true },
    ])
    mockGetUserByPlexAccountId.mockResolvedValue({
      id: 5,
      username: 'alice',
      hasMusicAccess: true,
      plexAccessRevokedAt: new Date('2026-01-01'),
    } as never)

    const result = await syncPlexServerUsers(db)

    expect(result.updated).toBe(1)
    expect(mockUpdateUser).toHaveBeenCalledWith(
      db,
      5,
      expect.objectContaining({ plexAccessRevokedAt: null }),
    )
  })

  it('does not touch a user whose username/access/revoked status are all already in sync', async () => {
    mockGetSettings.mockResolvedValue(configuredSettings())
    mockGetPlexServerSharedUsers.mockResolvedValue([
      { accountId: 111, username: 'alice', email: null, hasMusicAccess: true },
    ])
    mockGetUserByPlexAccountId.mockResolvedValue({
      id: 5,
      username: 'alice',
      hasMusicAccess: true,
      plexAccessRevokedAt: null,
    } as never)

    const result = await syncPlexServerUsers(db)

    expect(result).toMatchObject({ added: 0, updated: 0, revoked: 0 })
    expect(mockUpdateUser).not.toHaveBeenCalled()
  })

  it('revokes access for a Plex-linked user no longer in the shared-users list', async () => {
    mockGetSettings.mockResolvedValue(configuredSettings())
    mockGetPlexServerSharedUsers.mockResolvedValue([])
    mockListPlexLinkedUsers.mockResolvedValue([
      { id: 9, isOwner: false, plexAccountId: 222, plexAccessRevokedAt: null },
    ] as never)

    const result = await syncPlexServerUsers(db)

    expect(result.revoked).toBe(1)
    expect(mockUpdateUser).toHaveBeenCalledWith(
      db,
      9,
      expect.objectContaining({ plexAccessRevokedAt: expect.any(Date) }),
    )
  })

  it('never revokes the server owner even if they are absent from the shared-users list', async () => {
    mockGetSettings.mockResolvedValue(configuredSettings())
    mockGetPlexServerSharedUsers.mockResolvedValue([])
    mockListPlexLinkedUsers.mockResolvedValue([
      { id: 1, isOwner: true, plexAccountId: 999, plexAccessRevokedAt: null },
    ] as never)

    const result = await syncPlexServerUsers(db)

    expect(result.revoked).toBe(0)
    expect(mockUpdateUser).not.toHaveBeenCalled()
  })

  it('does not re-revoke a user who is already revoked', async () => {
    mockGetSettings.mockResolvedValue(configuredSettings())
    mockGetPlexServerSharedUsers.mockResolvedValue([])
    mockListPlexLinkedUsers.mockResolvedValue([
      { id: 9, isOwner: false, plexAccountId: 222, plexAccessRevokedAt: new Date('2026-01-01') },
    ] as never)

    const result = await syncPlexServerUsers(db)

    expect(result.revoked).toBe(0)
    expect(mockUpdateUser).not.toHaveBeenCalled()
  })

  it('skips revocation for a linked user with no plexAccountId', async () => {
    mockGetSettings.mockResolvedValue(configuredSettings())
    mockGetPlexServerSharedUsers.mockResolvedValue([])
    mockListPlexLinkedUsers.mockResolvedValue([
      { id: 9, isOwner: false, plexAccountId: null, plexAccessRevokedAt: null },
    ] as never)

    const result = await syncPlexServerUsers(db)

    expect(result.revoked).toBe(0)
    expect(mockUpdateUser).not.toHaveBeenCalled()
  })

  it('keeps a user present in the current shared-users list from being revoked', async () => {
    mockGetSettings.mockResolvedValue(configuredSettings())
    mockGetPlexServerSharedUsers.mockResolvedValue([
      { accountId: 222, username: 'still-here', email: null, hasMusicAccess: true },
    ])
    mockGetUserByPlexAccountId.mockResolvedValue({
      id: 9,
      username: 'still-here',
      hasMusicAccess: true,
      plexAccessRevokedAt: null,
    } as never)
    mockListPlexLinkedUsers.mockResolvedValue([
      { id: 9, isOwner: false, plexAccountId: 222, plexAccessRevokedAt: null },
    ] as never)

    const result = await syncPlexServerUsers(db)

    expect(result.revoked).toBe(0)
  })
})
