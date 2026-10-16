import { describe, expect, it } from 'vitest'
import { albumTitleFromPath } from '@/core/playlists/local-path'

describe('albumTitleFromPath', () => {
  it('strips a leading (year) prefix from the album folder', () => {
    expect(albumTitleFromPath('/music/TLC/(1999) FanMail/TLC_FanMail_05_No Scrubs.mp3')).toBe(
      'FanMail',
    )
  })

  it('handles "year - title" and trailing (year) folder names', () => {
    expect(albumTitleFromPath('/music/Beck/2002 - Sea Change/01.flac')).toBe('Sea Change')
    expect(albumTitleFromPath('/music/Beck/Odelay (1996)/01.flac')).toBe('Odelay')
  })

  it('returns null without a usable path', () => {
    expect(albumTitleFromPath(null)).toBeNull()
    expect(albumTitleFromPath('track.mp3')).toBeNull()
  })
})
