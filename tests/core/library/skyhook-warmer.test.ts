import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SkyHookWarmer } from '@/core/library/skyhook-warmer'

describe('SkyHookWarmer', () => {
  let warmer: SkyHookWarmer
  let lookupArtist: ReturnType<typeof vi.fn<(term: string) => Promise<unknown[]>>>

  beforeEach(() => {
    lookupArtist = vi.fn<(term: string) => Promise<unknown[]>>(async () => [
      { id: 1, artistName: 'Test' },
    ])
    warmer = new SkyHookWarmer({ lookupArtist })
  })

  it('starts with unknown status', () => {
    expect(warmer.getStatus('mbid-123')).toBe('unknown')
  })

  it('transitions to warm after successful lookup', async () => {
    await warmer.warm('mbid-123')
    expect(warmer.getStatus('mbid-123')).toBe('warm')
    expect(lookupArtist).toHaveBeenCalledWith('lidarr:mbid-123')
  })

  it('does not re-warm already warm MBIDs', async () => {
    await warmer.warm('mbid-123')
    await warmer.warm('mbid-123')
    expect(lookupArtist).toHaveBeenCalledTimes(1)
  })

  it('resets to unknown on lookup failure', async () => {
    lookupArtist.mockRejectedValueOnce(new Error('503'))
    await warmer.warm('mbid-fail')
    expect(warmer.getStatus('mbid-fail')).toBe('unknown')
  })

  it('isWarm returns boolean', async () => {
    expect(warmer.isWarm('mbid-123')).toBe(false)
    await warmer.warm('mbid-123')
    expect(warmer.isWarm('mbid-123')).toBe(true)
  })

  it('warmBatch warms multiple MBIDs', async () => {
    await warmer.warmBatch(['mbid-1', 'mbid-2', 'mbid-3'])
    expect(lookupArtist).toHaveBeenCalledTimes(3)
    expect(warmer.isWarm('mbid-1')).toBe(true)
    expect(warmer.isWarm('mbid-2')).toBe(true)
    expect(warmer.isWarm('mbid-3')).toBe(true)
  })

  it('warmBatch skips already warm MBIDs', async () => {
    await warmer.warm('mbid-1')
    lookupArtist.mockClear()
    await warmer.warmBatch(['mbid-1', 'mbid-2'])
    expect(lookupArtist).toHaveBeenCalledTimes(1)
  })

  it('warmBatch deduplicates input', async () => {
    await warmer.warmBatch(['mbid-1', 'mbid-1', 'mbid-1'])
    expect(lookupArtist).toHaveBeenCalledTimes(1)
  })

  it('evicts warm entries when map exceeds 5000', async () => {
    // Pre-populate 5000 warm entries by directly setting internal state
    const statusMap = (warmer as unknown as { status: Map<string, string> }).status
    for (let i = 0; i < 5000; i++) {
      statusMap.set(`seed-${i}`, 'warm')
    }
    // Warming one more should trigger eviction of 'warm' entries
    await warmer.warm('mbid-trigger')
    expect(warmer.isWarm('mbid-trigger')).toBe(true)
    // All seed entries should be evicted
    expect(statusMap.get('seed-0')).toBeUndefined()
    // Map should be much smaller now
    expect(statusMap.size).toBeLessThan(5000)
  })
})
