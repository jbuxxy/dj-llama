import { describe, expect, it } from 'vitest'
import { ListeningSessions } from '@/core/listening/sessions'

const track = (ratingKey: string, durationMs = 200_000) => ({
  ratingKey,
  artistName: 'Artist',
  trackName: `Track ${ratingKey}`,
  durationMs,
})

function clock(start = 1_000_000) {
  let t = start
  return { now: () => t, advance: (ms: number) => (t += ms) }
}

describe('ListeningSessions', () => {
  it('records a scrobble as a completed play and swallows the trailing stop', () => {
    const c = clock()
    const s = new ListeningSessions(c.now)
    expect(s.handle(1, 'media.play', track('a'))).toEqual([])
    c.advance(180_000)
    const scrobbled = s.handle(1, 'media.scrobble', track('a'))
    expect(scrobbled).toHaveLength(1)
    expect(scrobbled[0]).toMatchObject({ ratingKey: 'a', completed: true, skipped: false })
    expect(scrobbled[0]?.playedAt.getTime()).toBe(1_000_000)
    c.advance(20_000)
    expect(s.handle(1, 'media.stop', track('a'))).toEqual([])
  })

  it('marks a stop before 30s as a skip', () => {
    const c = clock()
    const s = new ListeningSessions(c.now)
    s.handle(1, 'media.play', track('a'))
    c.advance(10_000)
    const [play] = s.handle(1, 'media.stop', track('a'))
    expect(play).toMatchObject({ completed: false, skipped: true, listenedMs: 10_000 })
  })

  it('marks a stop past 30% but before the scrobble as a partial play, not a skip', () => {
    const c = clock()
    const s = new ListeningSessions(c.now)
    s.handle(1, 'media.play', track('a', 200_000))
    c.advance(100_000)
    const [play] = s.handle(1, 'media.stop', track('a', 200_000))
    expect(play).toMatchObject({ completed: false, skipped: false, listenedMs: 100_000 })
  })

  it('treats a long track stopped under 30% as a skip even after 30s', () => {
    const c = clock()
    const s = new ListeningSessions(c.now)
    s.handle(1, 'media.play', track('a', 600_000))
    c.advance(60_000)
    expect(s.handle(1, 'media.stop', track('a', 600_000))[0]?.skipped).toBe(true)
  })

  it('closes the previous track as a skip when the next one starts without a stop', () => {
    const c = clock()
    const s = new ListeningSessions(c.now)
    s.handle(1, 'media.play', track('a'))
    c.advance(5_000)
    const closed = s.handle(1, 'media.play', track('b'))
    expect(closed).toHaveLength(1)
    expect(closed[0]).toMatchObject({ ratingKey: 'a', skipped: true })
  })

  it('prefers the reported viewOffset and excludes paused time from wall-clock listening', () => {
    const c = clock()
    const s = new ListeningSessions(c.now)
    s.handle(1, 'media.play', track('a'))
    c.advance(20_000)
    s.handle(1, 'media.pause', track('a'))
    c.advance(600_000)
    s.handle(1, 'media.resume', track('a'))
    c.advance(5_000)
    expect(s.handle(1, 'media.stop', track('a'))[0]?.listenedMs).toBe(25_000)

    s.handle(1, 'media.play', track('b'))
    c.advance(5_000)
    expect(s.handle(1, 'media.stop', track('b'), 150_000)[0]).toMatchObject({
      listenedMs: 150_000,
      skipped: false,
    })
  })

  it('keeps accounts independent', () => {
    const c = clock()
    const s = new ListeningSessions(c.now)
    s.handle(1, 'media.play', track('a'))
    s.handle(2, 'media.play', track('b'))
    c.advance(5_000)
    expect(s.handle(2, 'media.stop', track('b'))[0]?.ratingKey).toBe('b')
    expect(s.handle(1, 'media.stop', track('a'))[0]?.ratingKey).toBe('a')
  })

  it('a stop with no open session records nothing', () => {
    const s = new ListeningSessions()
    expect(s.handle(1, 'media.stop', track('a'))).toEqual([])
  })
})
