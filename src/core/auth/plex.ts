// Plex OAuth (PIN flow) -- the only login method in this fork. There is no
// local username/password registration; every account (admin and regular
// users alike) is created by signing in with Plex. Design rationale:
// one admin-owned server token does data access, per-user tokens are used
// wherever Plex itself scopes a response by token (library sections), and
// a user only gets an account if their own resolved token can see the
// configured Music library section.

const PLEX_API_BASE = 'https://plex.tv'
// Any stable string works here -- Plex doesn't require a real UUID, just
// something consistent per install (Singarr, elsewhere in this stack, uses
// the literal string "singarr" for the same header).
const CLIENT_IDENTIFIER = 'dj-llama'
const PRODUCT = 'DJ Llama'

function plexHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    Accept: 'application/json',
    'X-Plex-Client-Identifier': CLIENT_IDENTIFIER,
    'X-Plex-Product': PRODUCT,
    ...extra,
  }
}

export interface PlexPin {
  id: number
  code: string
}

export async function createPlexPin(): Promise<PlexPin> {
  const res = await fetch(`${PLEX_API_BASE}/api/v2/pins?strong=true`, {
    method: 'POST',
    headers: plexHeaders(),
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) throw new Error(`Plex pin creation failed: ${res.status}`)
  const data = (await res.json()) as { id: number; code: string }
  return { id: data.id, code: data.code }
}

export function buildPlexAuthAppUrl(pinCode: string, forwardUrl: string): string {
  const params = new URLSearchParams({
    clientID: CLIENT_IDENTIFIER,
    code: pinCode,
    'context[device][product]': PRODUCT,
    forwardUrl,
  })
  return `https://app.plex.tv/auth#?${params.toString()}`
}

/** Returns null while the user hasn't finished the app.plex.tv flow yet. */
export async function checkPlexPin(pinId: number): Promise<string | null> {
  const res = await fetch(`${PLEX_API_BASE}/api/v2/pins/${pinId}`, {
    headers: plexHeaders(),
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) throw new Error(`Plex pin check failed: ${res.status}`)
  const data = (await res.json()) as { authToken: string | null }
  return data.authToken || null
}

export interface PlexAccount {
  id: number
  username: string
  email: string | null
  thumb: string | null
}

export async function getPlexAccount(token: string): Promise<PlexAccount> {
  const res = await fetch(`${PLEX_API_BASE}/api/v2/user`, {
    headers: plexHeaders({ 'X-Plex-Token': token }),
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) throw new Error(`Plex account lookup failed: ${res.status}`)
  const data = (await res.json()) as {
    id: number
    username: string
    email?: string
    thumb?: string
  }
  return {
    id: data.id,
    username: data.username,
    email: data.email ?? null,
    thumb: data.thumb ?? null,
  }
}

interface PlexConnection {
  uri: string
  local: boolean
  relay: boolean
}

interface PlexResource {
  name: string
  provides: string
  owned: boolean
  clientIdentifier: string
  accessToken: string
  connections: PlexConnection[]
}

async function getPlexResources(token: string): Promise<PlexResource[]> {
  const res = await fetch(`${PLEX_API_BASE}/api/v2/resources?includeHttps=1&includeRelay=1`, {
    headers: plexHeaders({ 'X-Plex-Token': token }),
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) throw new Error(`Plex resource lookup failed: ${res.status}`)
  const data = (await res.json()) as Array<{
    name: string
    provides: string
    owned: boolean
    clientIdentifier: string
    accessToken: string
    connections?: Array<{ uri: string; local: boolean; relay: boolean }>
  }>
  return data
    .filter((d) => d.provides.split(',').includes('server'))
    .map((d) => ({
      name: d.name,
      provides: d.provides,
      owned: d.owned,
      clientIdentifier: d.clientIdentifier,
      accessToken: d.accessToken,
      connections: (d.connections ?? []).map((c) => ({
        uri: c.uri,
        local: c.local,
        relay: c.relay,
      })),
    }))
}

export interface OwnedPlexServer {
  name: string
  machineIdentifier: string
}

/**
 * Servers this Plex identity actually owns (not just has access to) --
 * used at bootstrap to verify the person completing setup is the real
 * server owner, and to list choices if they own more than one. Deliberately
 * skips the connection-liveness probing `resolvePlexServerConnection` does;
 * that only matters once a specific server has been chosen.
 */
export async function listOwnedPlexServers(identityToken: string): Promise<OwnedPlexServer[]> {
  const resources = await getPlexResources(identityToken)
  return resources
    .filter((r) => r.owned)
    .map((r) => ({ name: r.name, machineIdentifier: r.clientIdentifier }))
}

export interface ResolvedPlexServer {
  url: string
  accessToken: string
  machineIdentifier: string
}

/**
 * Resolves a Plex identity's own access to a specific server (or, when
 * `machineIdentifier` is omitted, the identity's own first owned server --
 * used only for the very first admin login, before any server is configured).
 * Returns null if the identity has no access to that server at all.
 *
 * Connection preference: local first (lowest latency, works without internet
 * if the box is on the LAN), then a direct remote URI, then Plex's relay as
 * a last resort. Each candidate is verified live with a short-timeout probe
 * rather than trusted blindly, since Plex lists connections it can't always
 * currently reach (e.g. a local URI from outside the LAN).
 */
export async function resolvePlexServerConnection(
  identityToken: string,
  machineIdentifier?: string,
): Promise<ResolvedPlexServer | null> {
  const resources = await getPlexResources(identityToken)
  const candidates = machineIdentifier
    ? resources.filter((r) => r.clientIdentifier === machineIdentifier)
    : resources.filter((r) => r.owned)
  const server = candidates[0]
  if (!server) return null

  const ordered = [...server.connections].sort((a, b) => {
    const rank = (c: PlexConnection) => (c.local ? 0 : c.relay ? 2 : 1)
    return rank(a) - rank(b)
  })

  for (const conn of ordered) {
    try {
      const res = await fetch(`${conn.uri}/identity`, {
        headers: plexHeaders({ 'X-Plex-Token': server.accessToken }),
        signal: AbortSignal.timeout(4000),
      })
      if (res.ok) {
        return {
          url: conn.uri,
          accessToken: server.accessToken,
          machineIdentifier: server.clientIdentifier,
        }
      }
    } catch {
      // Try the next connection candidate (e.g. local URI unreachable from
      // outside the LAN) -- only fail resolution if none of them work.
    }
  }
  return null
}

export interface PlexLibrarySection {
  id: string
  title: string
  type: string
}

export async function getPlexLibrarySections(
  serverUrl: string,
  token: string,
): Promise<PlexLibrarySection[]> {
  const res = await fetch(`${serverUrl}/library/sections`, {
    headers: plexHeaders({ 'X-Plex-Token': token }),
    signal: AbortSignal.timeout(5000),
  })
  if (!res.ok) throw new Error(`Plex library sections lookup failed: ${res.status}`)
  const data = (await res.json()) as {
    MediaContainer?: { Directory?: Array<{ key: string; title: string; type: string }> }
  }
  return (data.MediaContainer?.Directory ?? []).map((d) => ({
    id: d.key,
    title: d.title,
    type: d.type,
  }))
}

export interface PlexServerUser {
  accountId: number
  username: string
  email: string | null
  hasMusicAccess: boolean
}

function unescapeXmlAttr(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&')
}

function parseXmlAttrs(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const re = /(\w+)="([^"]*)"/g
  let m: RegExpExecArray | null
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex-exec-loop idiom
  while ((m = re.exec(tag))) {
    attrs[m[1] ?? ''] = unescapeXmlAttr(m[2] ?? '')
  }
  return attrs
}

/**
 * Everyone Plex has ever shared this server with -- used to proactively
 * mirror server access into DJ Llama accounts, not just lazily on login.
 * The server owner (accountID 1) never appears in this list (it's *shared*
 * users, not the owner) and is handled separately by the bootstrap flow.
 *
 * This is one of Plex's legacy XML-only endpoints (no JSON variant exists).
 * Response shape verified live against a real server: one <SharedServer> per
 * user, each listing every library section on the server with a `shared`
 * flag -- presence in the list does NOT imply access, only `shared="1"` does.
 * `key` on <Section> is the short per-server section number (matches
 * getPlexLibrarySections' `id`), not the long global `id` attribute.
 */
export async function getPlexServerSharedUsers(
  adminToken: string,
  machineIdentifier: string,
  musicSectionIds: string[],
): Promise<PlexServerUser[]> {
  const res = await fetch(`${PLEX_API_BASE}/api/servers/${machineIdentifier}/shared_servers`, {
    headers: plexHeaders({ 'X-Plex-Token': adminToken }),
    signal: AbortSignal.timeout(10000),
  })
  if (!res.ok) throw new Error(`Plex shared-users lookup failed: ${res.status}`)
  const xml = await res.text()

  const musicKeys = new Set(musicSectionIds)
  const users: PlexServerUser[] = []
  const sharedServerRe = /<SharedServer\b([^>]*)>([\s\S]*?)<\/SharedServer>/g
  let m: RegExpExecArray | null
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex-exec-loop idiom
  while ((m = sharedServerRe.exec(xml))) {
    const attrs = parseXmlAttrs(m[1] ?? '')
    const accountId = Number(attrs.userID)
    if (!attrs.userID || Number.isNaN(accountId)) continue

    let hasMusicAccess = false
    const sectionRe = /<Section\b([^>]*)\/>/g
    let sm: RegExpExecArray | null
    // biome-ignore lint/suspicious/noAssignInExpressions: standard regex-exec-loop idiom
    while ((sm = sectionRe.exec(m[2] ?? ''))) {
      const sAttrs = parseXmlAttrs(sm[1] ?? '')
      if (sAttrs.shared === '1' && musicKeys.has(sAttrs.key ?? '')) hasMusicAccess = true
    }

    users.push({
      accountId,
      username: attrs.username || attrs.email || `plex-${accountId}`,
      email: attrs.email || null,
      hasMusicAccess,
    })
  }
  return users
}
