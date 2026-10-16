// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { TargetRegistry } from '@/core/targets/registry'
import type { DestinationTarget } from '@/core/targets/types'

function makeTarget(overrides: Partial<DestinationTarget> = {}): DestinationTarget {
  return {
    id: 'test-1',
    name: 'Test Target',
    type: 'lidarr',
    capabilities: ['addArtist'],
    addArtist: async () => ({ success: true, targetType: 'lidarr', targetId: 1 }),
    testConnection: async () => ({ success: true, message: 'ok' }),
    ...overrides,
  }
}

describe('TargetRegistry', () => {
  it('registers and retrieves a target', () => {
    const reg = new TargetRegistry()
    const target = makeTarget({ id: 'lidarr-1' })
    reg.register(target)
    expect(reg.get('lidarr-1')).toBe(target)
  })

  it('returns undefined for unknown id', () => {
    const reg = new TargetRegistry()
    expect(reg.get('nope')).toBeUndefined()
  })

  it('lists all registered targets', () => {
    const reg = new TargetRegistry()
    reg.register(makeTarget({ id: 'a' }))
    reg.register(makeTarget({ id: 'b' }))
    expect(reg.all()).toHaveLength(2)
  })

  it('filters by capability', () => {
    const reg = new TargetRegistry()
    reg.register(makeTarget({ id: 'a', capabilities: ['addArtist'] }))
    reg.register(makeTarget({ id: 'b', capabilities: ['createPlaylist'] }))
    expect(reg.withCapability('addArtist')).toHaveLength(1)
    expect(reg.withCapability('addArtist')[0]?.id).toBe('a')
  })

  it('clears all targets', () => {
    const reg = new TargetRegistry()
    reg.register(makeTarget({ id: 'a' }))
    reg.clear()
    expect(reg.all()).toHaveLength(0)
  })

  it('overwrites target with same id', () => {
    const reg = new TargetRegistry()
    reg.register(makeTarget({ id: 'a', name: 'First' }))
    reg.register(makeTarget({ id: 'a', name: 'Second' }))
    expect(reg.all()).toHaveLength(1)
    expect(reg.get('a')?.name).toBe('Second')
  })

  it('filters by createPlaylist capability', () => {
    const reg = new TargetRegistry()
    reg.register(makeTarget({ id: 'a', capabilities: ['addArtist'] }))
    reg.register(makeTarget({ id: 'b', capabilities: ['createPlaylist'] }))
    reg.register(makeTarget({ id: 'c', capabilities: ['createPlaylist'] }))
    expect(reg.withCapability('createPlaylist')).toHaveLength(2)
  })
})
