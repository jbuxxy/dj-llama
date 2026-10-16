// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { SourceRegistry } from '@/core/plugins/registry'
import type { DiscoverySource, SourceCapability } from '@/core/plugins/types'

function makeFakeSource(
  id: string,
  name: string,
  capabilities: SourceCapability[] = [],
): DiscoverySource {
  return {
    id,
    name,
    capabilities,
    getTopArtists: vi.fn().mockResolvedValue([]),
    getSimilarArtists: vi.fn().mockResolvedValue([]),
    testConnection: vi.fn().mockResolvedValue({ success: true, message: 'ok' }),
  }
}

describe('SourceRegistry', () => {
  it('registers and retrieves a source by id', () => {
    const registry = new SourceRegistry()
    const source = makeFakeSource('test', 'Test Source')
    registry.register(source)

    expect(registry.get('test')).toBe(source)
  })

  it('returns undefined for unregistered id', () => {
    const registry = new SourceRegistry()
    expect(registry.get('nope')).toBeUndefined()
  })

  it('returns all registered sources', () => {
    const registry = new SourceRegistry()
    const a = makeFakeSource('a', 'Source A')
    const b = makeFakeSource('b', 'Source B')
    registry.register(a)
    registry.register(b)

    const all = registry.all()
    expect(all).toHaveLength(2)
    expect(all).toContain(a)
    expect(all).toContain(b)
  })

  it('overwrites existing source with same id', () => {
    const registry = new SourceRegistry()
    const v1 = makeFakeSource('x', 'Version 1')
    const v2 = makeFakeSource('x', 'Version 2')
    registry.register(v1)
    registry.register(v2)

    expect(registry.get('x')).toBe(v2)
    expect(registry.all()).toHaveLength(1)
  })

  it('clear() removes all sources', () => {
    const registry = new SourceRegistry()
    registry.register(makeFakeSource('a', 'A'))
    registry.register(makeFakeSource('b', 'B'))
    registry.clear()

    expect(registry.all()).toHaveLength(0)
    expect(registry.get('a')).toBeUndefined()
  })

  it('returns empty array when no sources registered', () => {
    const registry = new SourceRegistry()
    expect(registry.all()).toEqual([])
  })

  describe('withCapability()', () => {
    it('returns sources that have the requested capability', () => {
      const registry = new SourceRegistry()
      const lbz = makeFakeSource('listenbrainz', 'ListenBrainz', [
        'topArtists',
        'similarArtists',
        'listeningActivity',
      ])
      const lfm = makeFakeSource('lastfm', 'Last.fm', [
        'topArtists',
        'similarArtists',
        'genreArtists',
      ])
      registry.register(lbz)
      registry.register(lfm)

      const topArtistSources = registry.withCapability('topArtists')
      expect(topArtistSources).toHaveLength(2)
      expect(topArtistSources).toContain(lbz)
      expect(topArtistSources).toContain(lfm)
    })

    it('filters to only sources with the requested capability', () => {
      const registry = new SourceRegistry()
      const lbz = makeFakeSource('listenbrainz', 'ListenBrainz', [
        'topArtists',
        'similarArtists',
        'listeningActivity',
      ])
      const lfm = makeFakeSource('lastfm', 'Last.fm', [
        'topArtists',
        'similarArtists',
        'genreArtists',
      ])
      registry.register(lbz)
      registry.register(lfm)

      const genreSources = registry.withCapability('genreArtists')
      expect(genreSources).toHaveLength(1)
      expect(genreSources).toContain(lfm)
      expect(genreSources).not.toContain(lbz)

      const activitySources = registry.withCapability('listeningActivity')
      expect(activitySources).toHaveLength(1)
      expect(activitySources).toContain(lbz)
      expect(activitySources).not.toContain(lfm)
    })

    it('returns empty array when no sources have the capability', () => {
      const registry = new SourceRegistry()
      registry.register(makeFakeSource('a', 'A', ['topArtists']))
      registry.register(makeFakeSource('b', 'B', ['similarArtists']))

      expect(registry.withCapability('recentListening')).toEqual([])
    })

    it('returns empty array when registry is empty', () => {
      const registry = new SourceRegistry()
      expect(registry.withCapability('topArtists')).toEqual([])
    })

    it('handles source with no capabilities', () => {
      const registry = new SourceRegistry()
      registry.register(makeFakeSource('empty', 'Empty', []))

      expect(registry.withCapability('topArtists')).toEqual([])
    })
  })
})
