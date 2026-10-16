import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown } from 'lucide-react'
import { getUserPreferences, updateUserPreferences } from '@/web/lib/api'

type Capability = {
  serviceKey: string
  serviceLabel: string
  librarySync: string | null
  listeningHistory: string | null
  discovery: string | null
  playlists: string | null
  requests: string | null
  other: string | null
}

// Ordered by importance: how central the integration is to the app actually
// working, not alphabetically. Plex and Lidarr are the only real "connected
// account" integrations; the AI provider drives discovery. The streaming
// services below them need no account at all -- Spotify's OAuth is blocked for
// this app's credentials as of Feb 2026 (see core/clients/spotify.ts) and
// Deezer app registration is closed, so they're only used through their
// public catalog and playlist endpoints. Keep this in sync with what the code
// actually calls -- it's a user-facing claim.
const INTEGRATIONS: Capability[] = [
  {
    serviceKey: 'plex',
    serviceLabel: 'Plex',
    librarySync: 'Artists, Albums',
    listeningHistory: 'Plays, Ratings',
    discovery: 'Taste profile',
    playlists: 'Export, Track matching',
    requests: null,
    other: 'Sign-in',
  },
  {
    serviceKey: 'lidarr',
    serviceLabel: 'Lidarr',
    librarySync: 'Artists, Albums',
    listeningHistory: null,
    discovery: null,
    playlists: null,
    requests: 'Artists, Albums',
    other: 'Artwork',
  },
  {
    serviceKey: 'ai',
    serviceLabel: 'AI Provider',
    librarySync: null,
    listeningHistory: null,
    discovery: 'Recommendations, Mood, Quick Discover',
    playlists: 'AI playlists',
    requests: 'Original-album lookup',
    other: null,
  },
  {
    serviceKey: 'spotify',
    serviceLabel: 'Spotify',
    librarySync: null,
    listeningHistory: null,
    discovery: null,
    playlists: 'Import, Track matching',
    requests: null,
    other: 'Popular albums, Previews',
  },
  {
    serviceKey: 'deezer',
    serviceLabel: 'Deezer',
    librarySync: null,
    listeningHistory: null,
    discovery: null,
    playlists: 'Import, Seasonal, Track matching',
    requests: null,
    other: 'Top tracks',
  },
  {
    serviceKey: 'youtube_music',
    serviceLabel: 'YouTube Music',
    librarySync: null,
    listeningHistory: null,
    discovery: null,
    playlists: 'Import',
    requests: null,
    other: null,
  },
  {
    serviceKey: 'apple_music',
    serviceLabel: 'Apple Music',
    librarySync: null,
    listeningHistory: null,
    discovery: null,
    playlists: 'Import',
    requests: null,
    other: null,
  },
  {
    serviceKey: 'shazam',
    serviceLabel: 'Shazam',
    librarySync: null,
    listeningHistory: null,
    discovery: null,
    playlists: null,
    requests: null,
    other: 'Song ID',
  },
]

function Cell({ messageKey }: { messageKey: string | null }) {
  return <>{messageKey ? messageKey : '-'}</>
}

export function IntegrationCapabilities() {
  const queryClient = useQueryClient()
  const { data: prefs } = useQuery({
    queryKey: ['user-preferences'],
    queryFn: getUserPreferences,
    staleTime: 60_000,
  })
  const open = Boolean(
    (prefs as { integrationCapabilitiesExpanded?: boolean } | undefined)
      ?.integrationCapabilitiesExpanded,
  )

  async function toggle() {
    const next = !open
    queryClient.setQueryData(['user-preferences'], (old: Record<string, unknown> | undefined) => ({
      ...(old ?? {}),
      integrationCapabilitiesExpanded: next,
    }))
    try {
      await updateUserPreferences({ integrationCapabilitiesExpanded: next })
    } catch {
      // best-effort -- worst case the remembered state doesn't stick
    }
  }

  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 text-left"
      >
        <span className="text-sm font-medium text-text">Integration Capabilities</span>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-muted transition-transform ${open ? 'rotate-180' : ''}`}
          aria-hidden="true"
        />
      </button>
      {open && <IntegrationCapabilitiesTable />}
    </div>
  )
}

function IntegrationCapabilitiesTable() {
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="border-b border-border">
            <th className="text-left py-2 pr-3 text-muted font-medium">Service</th>
            <th className="text-left py-2 px-3 text-muted font-medium">Library Sync</th>
            <th className="text-left py-2 px-3 text-muted font-medium">Listening History</th>
            <th className="text-left py-2 px-3 text-muted font-medium">Discovery</th>
            <th className="text-left py-2 px-3 text-muted font-medium">Playlists</th>
            <th className="text-left py-2 px-3 text-muted font-medium">Requests</th>
            <th className="text-left py-2 px-3 text-muted font-medium">Other</th>
          </tr>
        </thead>
        <tbody>
          {INTEGRATIONS.map((row) => (
            <tr key={row.serviceKey} className="border-b border-border/50">
              <td className="py-2 pr-3 font-medium text-text">{row.serviceLabel}</td>
              <td className="py-2 px-3 text-muted">
                <Cell messageKey={row.librarySync} />
              </td>
              <td className="py-2 px-3 text-muted">
                <Cell messageKey={row.listeningHistory} />
              </td>
              <td className="py-2 px-3 text-muted">
                <Cell messageKey={row.discovery} />
              </td>
              <td className="py-2 px-3 text-muted">
                <Cell messageKey={row.playlists} />
              </td>
              <td className="py-2 px-3 text-muted">
                <Cell messageKey={row.requests} />
              </td>
              <td className="py-2 px-3 text-muted">
                <Cell messageKey={row.other} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
