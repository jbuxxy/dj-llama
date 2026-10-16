// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getPlexServerSharedUsers, resolvePlexServerConnection } from '@/core/auth/plex'

afterEach(() => {
  vi.unstubAllGlobals()
})

function sharedServersXml(inner: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><MediaContainer size="1">${inner}</MediaContainer>`
}

describe('getPlexServerSharedUsers', () => {
  it('parses accountId, username, and email from a SharedServer entry', async () => {
    const xml = sharedServersXml(
      `<SharedServer id="1" username="alice" userID="111" email="alice@example.com"></SharedServer>`,
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(xml, { status: 200 })),
    )

    const users = await getPlexServerSharedUsers('admin-token', 'machine-id', ['1'])

    expect(users).toEqual([
      { accountId: 111, username: 'alice', email: 'alice@example.com', hasMusicAccess: false },
    ])
  })

  it('marks hasMusicAccess true only when a shared Section key is in musicSectionIds', async () => {
    const xml = sharedServersXml(
      `<SharedServer id="1" username="bob" userID="222">
         <Section key="1" shared="1" />
         <Section key="2" shared="0" />
       </SharedServer>`,
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(xml, { status: 200 })),
    )

    const users = await getPlexServerSharedUsers('admin-token', 'machine-id', ['1'])

    expect(users[0]?.hasMusicAccess).toBe(true)
  })

  it('does not grant hasMusicAccess for a shared section outside musicSectionIds', async () => {
    const xml = sharedServersXml(
      `<SharedServer id="1" username="bob" userID="222">
         <Section key="9" shared="1" />
       </SharedServer>`,
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(xml, { status: 200 })),
    )

    const users = await getPlexServerSharedUsers('admin-token', 'machine-id', ['1'])

    expect(users[0]?.hasMusicAccess).toBe(false)
  })

  it('does not grant hasMusicAccess for an unshared (shared="0") music section', async () => {
    const xml = sharedServersXml(
      `<SharedServer id="1" username="bob" userID="222">
         <Section key="1" shared="0" />
       </SharedServer>`,
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(xml, { status: 200 })),
    )

    const users = await getPlexServerSharedUsers('admin-token', 'machine-id', ['1'])

    expect(users[0]?.hasMusicAccess).toBe(false)
  })

  it('falls back to email, then a synthetic name, when username is missing', async () => {
    const xml = sharedServersXml(
      `<SharedServer id="1" userID="333" email="carol@example.com"></SharedServer>` +
        `<SharedServer id="2" userID="444"></SharedServer>`,
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(xml, { status: 200 })),
    )

    const users = await getPlexServerSharedUsers('admin-token', 'machine-id', [])

    expect(users[0]?.username).toBe('carol@example.com')
    expect(users[1]?.username).toBe('plex-444')
  })

  it('skips entries with no userID attribute', async () => {
    const xml = sharedServersXml(`<SharedServer id="1" username="noid"></SharedServer>`)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(xml, { status: 200 })),
    )

    const users = await getPlexServerSharedUsers('admin-token', 'machine-id', [])

    expect(users).toEqual([])
  })

  it('unescapes XML entities in username and email', async () => {
    const xml = sharedServersXml(
      `<SharedServer id="1" userID="555" username="Bob &amp; Alice" email="a&lt;b&gt;@x.com"></SharedServer>`,
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(xml, { status: 200 })),
    )

    const users = await getPlexServerSharedUsers('admin-token', 'machine-id', [])

    expect(users[0]?.username).toBe('Bob & Alice')
    expect(users[0]?.email).toBe('a<b>@x.com')
  })

  it('parses multiple SharedServer entries independently', async () => {
    const xml = sharedServersXml(
      `<SharedServer id="1" userID="1" username="a"><Section key="1" shared="1" /></SharedServer>` +
        `<SharedServer id="2" userID="2" username="b"><Section key="1" shared="0" /></SharedServer>`,
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(xml, { status: 200 })),
    )

    const users = await getPlexServerSharedUsers('admin-token', 'machine-id', ['1'])

    expect(users).toHaveLength(2)
    expect(users[0]).toMatchObject({ accountId: 1, hasMusicAccess: true })
    expect(users[1]).toMatchObject({ accountId: 2, hasMusicAccess: false })
  })

  it('throws when the Plex API responds with a non-OK status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 401 })),
    )

    await expect(getPlexServerSharedUsers('bad-token', 'machine-id', [])).rejects.toThrow(
      'Plex shared-users lookup failed: 401',
    )
  })
})

describe('resolvePlexServerConnection', () => {
  function resourcesResponse(
    resources: Array<{
      owned: boolean
      clientIdentifier: string
      provides?: string
      connections: Array<{ uri: string; local: boolean; relay: boolean }>
    }>,
  ) {
    return new Response(
      JSON.stringify(
        resources.map((r) => ({
          name: 'server',
          provides: r.provides ?? 'server',
          owned: r.owned,
          clientIdentifier: r.clientIdentifier,
          accessToken: 'tok',
          connections: r.connections,
        })),
      ),
      { status: 200 },
    )
  }

  it('returns null when the identity owns no matching server', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => resourcesResponse([])),
    )
    const result = await resolvePlexServerConnection('identity-token')
    expect(result).toBeNull()
  })

  it('prefers a local connection over a direct or relay one', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/resources')) {
        return resourcesResponse([
          {
            owned: true,
            clientIdentifier: 'm1',
            connections: [
              { uri: 'https://relay.example', local: false, relay: true },
              { uri: 'https://direct.example', local: false, relay: false },
              { uri: 'http://192.168.1.5:32400', local: true, relay: false },
            ],
          },
        ])
      }
      return new Response('', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await resolvePlexServerConnection('identity-token')

    expect(result).toEqual({
      url: 'http://192.168.1.5:32400',
      accessToken: 'tok',
      machineIdentifier: 'm1',
    })
  })

  it('falls through to the next candidate connection when the first is unreachable', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/resources')) {
        return resourcesResponse([
          {
            owned: true,
            clientIdentifier: 'm1',
            connections: [
              { uri: 'http://unreachable.local', local: true, relay: false },
              { uri: 'https://relay.example', local: false, relay: true },
            ],
          },
        ])
      }
      if (url.startsWith('http://unreachable.local')) {
        throw new Error('connection refused')
      }
      return new Response('', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await resolvePlexServerConnection('identity-token')

    expect(result?.url).toBe('https://relay.example')
  })

  it('returns null when every connection candidate fails', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/resources')) {
        return resourcesResponse([
          {
            owned: true,
            clientIdentifier: 'm1',
            connections: [{ uri: 'http://dead.local', local: true, relay: false }],
          },
        ])
      }
      return new Response('', { status: 500 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await resolvePlexServerConnection('identity-token')

    expect(result).toBeNull()
  })

  it('filters to the specific machineIdentifier when one is given, ignoring owned servers', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/resources')) {
        return resourcesResponse([
          { owned: true, clientIdentifier: 'owned-1', connections: [] },
          {
            owned: false,
            clientIdentifier: 'shared-1',
            connections: [{ uri: 'https://shared.example', local: false, relay: false }],
          },
        ])
      }
      return new Response('', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await resolvePlexServerConnection('identity-token', 'shared-1')

    expect(result?.machineIdentifier).toBe('shared-1')
  })

  it('excludes resources that do not provide "server"', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/resources')) {
        return resourcesResponse([
          {
            owned: true,
            clientIdentifier: 'not-a-server',
            provides: 'player',
            connections: [{ uri: 'https://x.example', local: false, relay: false }],
          },
        ])
      }
      return new Response('', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await resolvePlexServerConnection('identity-token')

    expect(result).toBeNull()
  })
})
