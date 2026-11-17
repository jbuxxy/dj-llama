// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import {
  deriveDispatchStatus,
  dispatchToTargets,
  targetTypeResolver,
} from '@/core/targets/dispatch'
import type { DestinationTarget } from '@/core/targets/types'

function target(
  id: string,
  type: DestinationTarget['type'],
  result: { success: boolean; externalId?: number; error?: string },
): DestinationTarget {
  const add = vi.fn().mockResolvedValue({ targetType: type, targetId: 1, ...result })
  return {
    id,
    name: id,
    type,
    capabilities: ['addArtist', 'addAlbum'],
    addArtist: add,
    addAlbum: add,
    testConnection: vi.fn(),
  }
}

describe('dispatchToTargets', () => {
  it('marks an artist added to Lidarr and keeps its artist id', async () => {
    const result = await dispatchToTargets(
      { kind: 'artist', mbid: 'm', name: 'A' },
      [target('lidarr-1', 'lidarr', { success: true, externalId: 7 })],
      {},
    )
    expect(result.status).toBe('added_to_lidarr')
    expect(result.lidarrArtistId).toBe(7)
  })

  it('never stores an album id as the Lidarr artist id', async () => {
    const result = await dispatchToTargets(
      { kind: 'album', artistMbid: 'm', artistName: 'A', releaseGroupMbid: 'rg' },
      [target('lidarr-1', 'lidarr', { success: true, externalId: 99 })],
      {},
    )
    expect(result.status).toBe('added_to_lidarr')
    expect(result.lidarrArtistId).toBeUndefined()
  })

  it('fails when Lidarr fails even if another target succeeds', async () => {
    const result = await dispatchToTargets(
      { kind: 'album', artistMbid: 'm', artistName: 'A', releaseGroupMbid: 'rg' },
      [
        target('lidarr-1', 'lidarr', { success: false, error: 'boom' }),
        target('export-1', 'export', { success: true }),
      ],
      {},
    )
    expect(result.status).toBe('add_failed')
    expect(result.lidarrError).toBe('boom')
  })

  it('approves an artist with no capable target and fails an album', async () => {
    const artist = await dispatchToTargets({ kind: 'artist', mbid: 'm', name: 'A' }, [], {})
    const album = await dispatchToTargets(
      { kind: 'album', artistMbid: 'm', artistName: 'A', releaseGroupMbid: 'rg' },
      [],
      {},
    )
    expect(artist.status).toBe('approved')
    expect(album.status).toBe('add_failed')
  })
})

describe('deriveDispatchStatus', () => {
  it('recognises stored Lidarr ids whose target is gone', () => {
    const resolve = targetTypeResolver([])
    expect(deriveDispatchStatus({ 'lidarr-3': { status: 'added' } }, resolve)).toBe(
      'added_to_lidarr',
    )
    expect(deriveDispatchStatus({ 'export-1': { status: 'added' } }, resolve)).toBe('approved')
  })
})
