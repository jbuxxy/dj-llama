// @vitest-environment node

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createTestApp } from '../helpers/test-app'

// Hash of index.html's inline pre-mount theme script, computed from the real
// file so the CSP allowance can't silently drift when the script is edited
// (a stale hard-coded hash once blocked it in every browser).
function inlineThemeScriptHash(): string {
  const html = readFileSync(resolve(__dirname, '../../index.html'), 'utf8')
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1]
  if (script === undefined) throw new Error('index.html has no inline <script>')
  return `sha256-${createHash('sha256').update(script).digest('base64')}`
}

function directive(policy: string, name: string): string | undefined {
  return policy
    .split(';')
    .map((value) => value.trim())
    .find((value) => value.startsWith(`${name} `))
}

describe('content security policy', () => {
  it('keeps remote scripts out of the authenticated application document', async () => {
    const { app } = createTestApp()

    const response = await app.request('/api/v1/auth/status')
    const policy = response.headers.get('content-security-policy') ?? ''

    expect(directive(policy, 'script-src')).toBe(`script-src 'self' '${inlineThemeScriptHash()}'`)
    expect(policy).toContain("frame-src 'self' https://open.spotify.com")
    expect(response.headers.get('x-frame-options')).toBe('DENY')
  })

  it('scopes Spotify controller access to the same-origin bridge page', async () => {
    const { app } = createTestApp()

    const response = await app.request('/spotify-embed-bridge.html')
    const policy = response.headers.get('content-security-policy') ?? ''

    expect(directive(policy, 'script-src')).toBe(
      "script-src 'self' https://open.spotify.com/embed/iframe-api/v1 https://embed-cdn.spotifycdn.com/_next/static/",
    )
    expect(directive(policy, 'frame-src')).toBe('frame-src https://open.spotify.com')
    expect(directive(policy, 'frame-ancestors')).toBe("frame-ancestors 'self'")
    expect(response.headers.get('x-frame-options')).toBe('SAMEORIGIN')
  })
})
