import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Activity,
  CalendarClock,
  ChartColumn,
  Check,
  ChevronDown,
  HeartPulse,
  Plug,
  ShieldCheck,
  Sparkles,
  Users,
  X,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import type { NotificationChannel, NotificationEvent } from '@/core/notifications/types'
import { DEFAULT_PREFERENCES, type Preferences } from '@/db/schema'
import { AdministrationTab } from '../components/admin/administration-tab'
import { AiModelField } from '../components/ai-model-field'
import { setAudiodbProxyFlag } from '../components/artist-thumb'
import { CollapsibleCard } from '../components/collapsible-card'
import { CronPicker } from '../components/cron-picker'
import { Field } from '../components/field'
import { Hint } from '../components/hint'
import { IntegrationCapabilities } from '../components/integration-capabilities'
import { PlexAdminControls } from '../components/plex-admin-controls'
import { ServiceCard } from '../components/service-card'
import { AiProviderIcon, LidarrIcon, PlexIcon, WebhookIcon } from '../components/service-icons'
import { SettingsNav, type SettingsNavGroup } from '../components/settings-nav'
import { SystemHealthCard } from '../components/system-health-card'
import { Toggle } from '../components/toggle'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card'
import { Input } from '../components/ui/input'
import { Select } from '../components/ui/select'
import { Skeleton } from '../components/ui/skeleton'
import {
  ApiError,
  getCurrentUser,
  getLidarrMetadataProfiles,
  getLidarrProfiles,
  getLidarrRootFolders,
  getPlexServerName,
  getSettings,
  getUserPreferences,
  testNotificationChannel,
  testService,
  updateSettings,
  updateUserPreferences,
} from '../lib/api'
import { AnalyticsPage } from './analytics'
import JobHistoryPage from './job-history'
import { LibraryHealthPage } from './library-health'
import { UserManagementPage } from './user-management'

type Settings = {
  lidarrUrl?: string
  lidarrApiKey?: string
  skipTlsVerify?: boolean
  aiProvider?: string
  aiApiKey?: string
  aiModel?: string
  aiBaseUrl?: string
  audiodbApiKey?: string
  lastfmApiKey?: string
  audiodbProxyImages?: boolean
  wikidataEnabled?: boolean
  plexUrl?: string
  plexToken?: string
  plexSectionId?: string
  librarySyncIntervalHours?: number
  preferences?: Partial<Preferences>
  setupComplete?: boolean
}

type Tab =
  | 'connections'
  | 'discovery'
  | 'schedule'
  | 'users'
  | 'administration'
  | 'system-health'
  | 'library-health'
  | 'analytics'

type NavGroup = SettingsNavGroup<Tab>

// Form-style tabs read better at a narrower measure; the embedded admin pages
// (tables, stat grids) get the full content column.
const NARROW_TABS: ReadonlySet<Tab> = new Set(['connections', 'discovery', 'schedule'])

// Keep old bookmarks working: `recommendations` was renamed to `discovery`,
// Job History moved into System Health, and Reconciliation into Library Health.
function parseTab(raw: string | null): Tab | null {
  if (raw === 'recommendations') return 'discovery'
  if (raw === 'jobs') return 'system-health'
  if (raw === 'reconciliation') return 'library-health'
  return raw as Tab | null
}

function useSettingsNav(isAdmin: boolean): NavGroup[] {
  const groups: NavGroup[] = [
    {
      label: 'You',
      items: [
        {
          id: 'connections',
          label: 'Connections',
          description: 'Plex, Lidarr, AI and your accounts',
          icon: Plug,
        },
        {
          id: 'discovery',
          label: 'Discovery',
          description: 'What gets recommended and how',
          icon: Sparkles,
        },
      ],
    },
  ]
  if (isAdmin) {
    groups.push({
      label: 'Server',
      items: [
        {
          id: 'schedule',
          label: 'Schedule',
          description: 'When discovery and library sync run',
          icon: CalendarClock,
        },
        { id: 'users', label: 'Users', description: 'Accounts and access', icon: Users },
        {
          id: 'administration',
          label: 'Administration',
          description: 'System info, backups and maintenance',
          icon: ShieldCheck,
        },
        {
          id: 'system-health',
          label: 'System Health',
          description: 'Service status and job history',
          icon: Activity,
        },
        {
          id: 'library-health',
          label: 'Library Health',
          description: 'Gaps, problems and unmatched items',
          icon: HeartPulse,
        },
        {
          id: 'analytics',
          label: 'Analytics',
          description: 'Approval rates and discovery trends',
          icon: ChartColumn,
        },
      ],
    })
  }
  return groups
}

// One label/help/control line inside a card's `divide-y` list -- the settings
// counterpart of the Playlists page's toggle rows.
function SettingRow({
  label,
  help,
  htmlFor,
  children,
}: {
  label: string
  help?: React.ReactNode
  htmlFor?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="min-w-0">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="text-sm text-text">
            {label}
          </label>
        ) : (
          <p className="text-sm text-text">{label}</p>
        )}
        {help && <p className="text-xs text-muted mt-0.5">{help}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

function Segmented<T extends string | number>({
  label,
  options,
  value,
  onChange,
}: {
  label: string
  options: { value: T; label: string }[]
  value: T
  onChange: (v: T) => void
}) {
  return (
    <fieldset className="flex items-center gap-1 bg-bg border border-border rounded-lg p-1 w-full sm:w-fit">
      <legend className="sr-only">{label}</legend>
      {options.map((option) => {
        const selected = option.value === value
        return (
          <button
            key={String(option.value)}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(option.value)}
            className={`flex-1 sm:flex-none px-3 py-1.5 rounded text-sm font-medium transition-colors ${
              selected ? 'bg-accent text-accent-fg' : 'text-muted hover:text-text'
            }`}
          >
            {option.label}
          </button>
        )
      })}
    </fieldset>
  )
}

type ServiceTestState = 'idle' | 'testing' | 'ok' | 'error'

const LOCAL_AI_DEFAULT_BASE_URLS: Record<string, string> = {
  ollama: 'http://localhost:11434',
  'openai-compatible': 'http://localhost:8080',
}

// True when the configured endpoint clearly points back to this machine or a local mDNS host.
// The privacy badge must follow the actual endpoint, not only the selected provider name.
function isLocalAiProvider(provider: string, baseUrl: string): boolean {
  const defaultBaseUrl = LOCAL_AI_DEFAULT_BASE_URLS[provider]
  if (!defaultBaseUrl) return false
  const effectiveBaseUrl = baseUrl.trim() || defaultBaseUrl
  try {
    const host = new URL(effectiveBaseUrl).hostname.toLowerCase()
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '0.0.0.0' ||
      host === '[::1]' ||
      host.endsWith('.local')
    )
  } catch {
    return false
  }
}

const CHANNEL_TYPES = ['webhook', 'ntfy', 'telegram', 'apprise', 'pushover'] as const
type ChannelType = (typeof CHANNEL_TYPES)[number]

const CHANNEL_TYPE_LABEL: Record<ChannelType, string> = {
  webhook: 'Webhook',
  ntfy: 'ntfy',
  telegram: 'Telegram',
  apprise: 'Apprise',
  pushover: 'Pushover',
}

const NOTIFICATION_EVENTS: NotificationEvent[] = [
  'batch_complete',
  'digest',
  'request_pending_approval',
  'request_auto_approved',
  'recommendation_approved',
]

// recommendations_available/playlist_generated are per-user-only events (dispatched
// straight to a user's own preferences.channels, not the global settings row -- see
// server/routes/auth.ts's /api/v1/auth/me/preferences and pipeline/orchestrator.ts) --
// deliberately absent from NOTIFICATION_EVENTS above so they don't show as a pickable
// option for a global/admin channel here. Still need a label since EVENT_LABEL must
// cover every NotificationEvent for any channel whose events[] already contains one.
const EVENT_LABEL: Record<NotificationEvent, string> = {
  batch_complete: 'Scan complete',
  digest: 'Digest',
  request_pending_approval: 'New request pending approval',
  request_auto_approved: 'Request auto-approved',
  recommendation_approved: 'Recommendation approved',
  recommendations_available: 'New recommendations available',
  playlist_generated: 'Playlist generated',
}

function makeChannel(type: ChannelType): NotificationChannel {
  const id =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `ch_${Date.now()}_${Math.random().toString(36).slice(2)}`
  const base = { id, enabled: true, events: [...NOTIFICATION_EVENTS] }
  switch (type) {
    case 'webhook':
      return { ...base, type, url: '' }
    case 'ntfy':
      return { ...base, type, server: '', topic: '' }
    case 'telegram':
      return { ...base, type, botToken: '', chatId: '' }
    case 'apprise':
      return { ...base, type, endpoint: '', urls: '' }
    case 'pushover':
      return { ...base, type, token: '', userKey: '' }
  }
}

const textareaClass =
  'flex min-h-[5rem] w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text shadow-sm placeholder:text-muted focus:outline-none focus:ring-1 focus:ring-accent font-mono'

// Per-type secret fields, mirroring the backend's CHANNEL_SECRET_FIELDS.
const CHANNEL_SECRET_FIELDS: Record<ChannelType, readonly string[]> = {
  webhook: [],
  ntfy: ['token'],
  telegram: ['botToken'],
  apprise: ['urls'],
  pushover: ['token', 'userKey'],
}

function secretKey(channelId: string, field: string): string {
  return `${channelId}:${field}`
}

// The API returns set secrets masked as '***'. Strip them to empty inputs (like the
// sibling connection fields do for lidarrApiKey etc.) and remember which were set.
function stripSecrets(channels: NotificationChannel[]): NotificationChannel[] {
  return channels.map((channel) => {
    const copy = { ...channel } as Record<string, unknown>
    for (const f of CHANNEL_SECRET_FIELDS[channel.type]) {
      if (copy[f] === '***') copy[f] = ''
    }
    return copy as NotificationChannel
  })
}

function computeHadSecret(channels: NotificationChannel[]): Record<string, boolean> {
  const had: Record<string, boolean> = {}
  for (const channel of channels) {
    for (const f of CHANNEL_SECRET_FIELDS[channel.type]) {
      if ((channel as Record<string, unknown>)[f] === '***') had[secretKey(channel.id, f)] = true
    }
  }
  return had
}

// Rebuild outgoing secrets before Save/Test: a blank input on a channel that already
// had a stored secret round-trips as '***' (backend restores the stored ciphertext);
// a non-empty input sends the new plaintext; a blank input on a brand-new channel
// stays blank. This avoids appending to the '***' placeholder (apprise multiline).
function applyStoredSecrets(
  channel: NotificationChannel,
  hadSecret: Record<string, boolean>,
): NotificationChannel {
  const copy = { ...channel } as Record<string, unknown>
  for (const f of CHANNEL_SECRET_FIELDS[channel.type]) {
    if (copy[f] === '' && hadSecret[secretKey(channel.id, f)]) copy[f] = '***'
  }
  return copy as NotificationChannel
}

function ChannelFields({
  channel,
  onPatch,
  hadSecret,
}: {
  channel: NotificationChannel
  onPatch: (patch: Record<string, unknown>) => void
  hadSecret: Record<string, boolean>
}) {
  const keepPlaceholder = (field: string) =>
    hadSecret[secretKey(channel.id, field)] ? 'Leave blank to keep the saved value' : undefined
  switch (channel.type) {
    case 'webhook':
      return (
        <Field label="Webhook URL" id={`ch-${channel.id}-url`}>
          <Input
            id={`ch-${channel.id}-url`}
            type="url"
            placeholder="https://example.com/djllama-webhook"
            value={channel.url}
            onChange={(e) => onPatch({ url: e.target.value })}
          />
        </Field>
      )
    case 'ntfy':
      return (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Server" id={`ch-${channel.id}-server`}>
            <Input
              id={`ch-${channel.id}-server`}
              type="url"
              placeholder="https://ntfy.sh"
              value={channel.server}
              onChange={(e) => onPatch({ server: e.target.value })}
            />
          </Field>
          <Field label="Topic" id={`ch-${channel.id}-topic`}>
            <Input
              id={`ch-${channel.id}-topic`}
              value={channel.topic}
              onChange={(e) => onPatch({ topic: e.target.value })}
            />
          </Field>
          <Field label="Priority" id={`ch-${channel.id}-priority`}>
            <Select
              id={`ch-${channel.id}-priority`}
              value={channel.priority != null ? String(channel.priority) : ''}
              onChange={(e) =>
                onPatch({ priority: e.target.value ? Number(e.target.value) : undefined })
              }
            >
              <option value="">—</option>
              {[1, 2, 3, 4, 5].map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Access token" id={`ch-${channel.id}-token`}>
            <Input
              id={`ch-${channel.id}-token`}
              type="password"
              placeholder={keepPlaceholder('token')}
              value={channel.token ?? ''}
              onChange={(e) => onPatch({ token: e.target.value })}
            />
          </Field>
        </div>
      )
    case 'telegram':
      return (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Bot token" id={`ch-${channel.id}-bot`}>
            <Input
              id={`ch-${channel.id}-bot`}
              type="password"
              placeholder={keepPlaceholder('botToken')}
              value={channel.botToken}
              onChange={(e) => onPatch({ botToken: e.target.value })}
            />
          </Field>
          <Field label="Chat ID" id={`ch-${channel.id}-chat`}>
            <Input
              id={`ch-${channel.id}-chat`}
              value={channel.chatId}
              onChange={(e) => onPatch({ chatId: e.target.value })}
            />
          </Field>
        </div>
      )
    case 'apprise':
      return (
        <div className="space-y-3">
          <Field label="Apprise API endpoint" id={`ch-${channel.id}-endpoint`}>
            <Input
              id={`ch-${channel.id}-endpoint`}
              type="url"
              placeholder="https://apprise.example.com/notify"
              value={channel.endpoint}
              onChange={(e) => onPatch({ endpoint: e.target.value })}
            />
          </Field>
          <Field label="Notification URLs" id={`ch-${channel.id}-urls`}>
            <textarea
              id={`ch-${channel.id}-urls`}
              className={textareaClass}
              placeholder={keepPlaceholder('urls')}
              value={channel.urls}
              onChange={(e) => onPatch({ urls: e.target.value })}
            />
          </Field>
          <p className="text-xs text-muted">One Apprise URL per line.</p>
        </div>
      )
    case 'pushover':
      return (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="API token" id={`ch-${channel.id}-token`}>
            <Input
              id={`ch-${channel.id}-token`}
              type="password"
              placeholder={keepPlaceholder('token')}
              value={channel.token}
              onChange={(e) => onPatch({ token: e.target.value })}
            />
          </Field>
          <Field label="User key" id={`ch-${channel.id}-userkey`}>
            <Input
              id={`ch-${channel.id}-userkey`}
              type="password"
              placeholder={keepPlaceholder('userKey')}
              value={channel.userKey}
              onChange={(e) => onPatch({ userKey: e.target.value })}
            />
          </Field>
          <Field label="Priority" id={`ch-${channel.id}-priority`}>
            <Select
              id={`ch-${channel.id}-priority`}
              value={channel.priority != null ? String(channel.priority) : ''}
              onChange={(e) =>
                onPatch({ priority: e.target.value ? Number(e.target.value) : undefined })
              }
            >
              <option value="">—</option>
              <option value="-2">Lowest (no notification)</option>
              <option value="-1">Low (quiet)</option>
              <option value="0">Normal</option>
              <option value="1">High (bypasses quiet hours)</option>
            </Select>
          </Field>
        </div>
      )
    default: {
      const _exhaustive: never = channel
      return _exhaustive
    }
  }
}

function NotificationChannelsCard({
  settings,
  isAdmin,
  onSaved,
}: {
  settings: Settings
  isAdmin: boolean
  onSaved: () => void
}) {
  const [channels, setChannels] = useState<NotificationChannel[]>(() =>
    stripSecrets((settings.preferences?.channels ?? []) as NotificationChannel[]),
  )
  const [hadSecret] = useState<Record<string, boolean>>(() =>
    computeHadSecret((settings.preferences?.channels ?? []) as NotificationChannel[]),
  )
  const [digestEnabled, setDigestEnabled] = useState(!!settings.preferences?.digestCron)
  const [digestCron, setDigestCron] = useState(settings.preferences?.digestCron || '0 6 * * 1')
  const [addType, setAddType] = useState<ChannelType>('webhook')
  const [saving, setSaving] = useState(false)
  const [testingId, setTestingId] = useState<string | null>(null)

  function patchChannel(id: string, patch: Record<string, unknown>) {
    setChannels((prev) =>
      prev.map((c) => (c.id === id ? ({ ...c, ...patch } as NotificationChannel) : c)),
    )
  }

  function toggleEvent(id: string, event: NotificationEvent) {
    setChannels((prev) =>
      prev.map((c) => {
        if (c.id !== id) return c
        const has = c.events.includes(event)
        return { ...c, events: has ? c.events.filter((e) => e !== event) : [...c.events, event] }
      }),
    )
  }

  async function handleSave() {
    setSaving(true)
    try {
      await updateSettings({
        preferences: {
          ...(settings.preferences ?? {}),
          channels: channels.map((c) => applyStoredSecrets(c, hadSecret)),
          digestCron: digestEnabled ? digestCron : undefined,
        },
      })
      toast.success('Notifications saved')
      onSaved()
    } catch {
      toast.error('Failed to save notifications')
    } finally {
      setSaving(false)
    }
  }

  async function handleTest(channel: NotificationChannel) {
    setTestingId(channel.id)
    try {
      await testNotificationChannel(applyStoredSecrets(channel, hadSecret))
      toast.success('Test notification sent')
    } catch (err) {
      let detail = ''
      if (err instanceof ApiError && err.data && typeof err.data === 'object') {
        const d = (err.data as Record<string, unknown>).detail
        if (typeof d === 'string' && d.trim()) detail = d.trim()
      }
      toast.error(`Test failed: ${detail || 'Unknown error'}`)
    } finally {
      setTestingId(null)
    }
  }

  // The backend strips channels from GET and 403s Save/Test for non-admins, so an
  // editable card would be dead. Render nothing for them (the outer tab already
  // shows an admin-only notice).
  if (!isAdmin) return null

  return (
    <ServiceCard
      name="Notifications"
      description="Send scan-complete and digest notifications to one or more channels."
      status={channels.length > 0 ? 'connected' : 'not_configured'}
      icon={<WebhookIcon />}
    >
      {channels.length === 0 && <p className="text-sm text-muted">No channels configured yet.</p>}

      <div className="space-y-4">
        {channels.map((channel) => (
          <div key={channel.id} className="rounded-md border border-border p-3 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <Badge variant="outline">{CHANNEL_TYPE_LABEL[channel.type]}</Badge>
              <div className="flex items-center gap-3">
                <Toggle
                  checked={channel.enabled}
                  onChange={(enabled) => patchChannel(channel.id, { enabled })}
                  label="Enabled"
                />
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setChannels((prev) => prev.filter((c) => c.id !== channel.id))}
                >
                  Remove
                </Button>
              </div>
            </div>

            <ChannelFields
              channel={channel}
              hadSecret={hadSecret}
              onPatch={(patch) => patchChannel(channel.id, patch)}
            />

            <div className="space-y-1.5">
              <span className="text-sm text-muted">Events</span>
              <div className="flex flex-wrap gap-1.5">
                {NOTIFICATION_EVENTS.map((event) => {
                  const on = channel.events.includes(event)
                  return (
                    <button
                      key={event}
                      type="button"
                      aria-pressed={on}
                      onClick={() => toggleEvent(channel.id, event)}
                      className={`px-2.5 py-1 rounded-full border text-xs transition-colors ${
                        on
                          ? 'bg-accent/15 border-accent/40 text-accent'
                          : 'border-border text-muted hover:text-text'
                      }`}
                    >
                      {EVENT_LABEL[event]}
                    </button>
                  )
                })}
              </div>
            </div>

            {isAdmin && channel.type !== 'pushover' && (
              <SettingRow
                label="Allow private network targets"
                help={
                  channel.allowPrivateTarget && (
                    <span className="text-amber-600 dark:text-amber-400">
                      Permits delivery to private/LAN addresses. Cloud metadata and link-local
                      ranges stay blocked.
                    </span>
                  )
                }
              >
                <Toggle
                  checked={channel.allowPrivateTarget ?? false}
                  onChange={(allowPrivateTarget) =>
                    patchChannel(channel.id, { allowPrivateTarget })
                  }
                  label="Allow private network targets"
                />
              </SettingRow>
            )}

            <div className="flex justify-end">
              <Button
                size="sm"
                variant="outline"
                onClick={() => handleTest(channel)}
                disabled={testingId === channel.id}
              >
                {testingId === channel.id ? 'Sending...' : 'Test'}
              </Button>
            </div>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <Field label="Type" id="add-channel-type">
          <Select
            id="add-channel-type"
            value={addType}
            onChange={(e) => setAddType(e.target.value as ChannelType)}
            className="w-auto"
          >
            {CHANNEL_TYPES.map((type) => (
              <option key={type} value={type}>
                {CHANNEL_TYPE_LABEL[type]}
              </option>
            ))}
          </Select>
        </Field>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setChannels((prev) => [...prev, makeChannel(addType)])}
        >
          Add channel
        </Button>
      </div>

      <div className="space-y-3 border-t border-border pt-3">
        <SettingRow
          label="Send a periodic digest"
          help="Send a periodic summary of recent activity to your webhook, on the schedule below."
        >
          <Toggle
            checked={digestEnabled}
            onChange={setDigestEnabled}
            label="Send a periodic digest"
          />
        </SettingRow>
        {digestEnabled && <CronPicker value={digestCron} onChange={setDigestCron} />}
      </div>

      <div className="flex justify-end pt-1">
        <Button size="sm" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving...' : 'Save'}
        </Button>
      </div>
    </ServiceCard>
  )
}

// Plex's direct-connect hostnames encode the LAN IP as e.g.
// "192-168-1-20.<cert-hash>.plex.direct" so the browser can get a valid TLS
// cert while talking straight to a local address. That's meaningless noise
// to a human -- decode it back to the plain "192.168.1.20:32400" the user
// actually recognizes. Falls back to the raw URL for anything else (a
// non-plex.direct hostname, a malformed value, etc).
function formatPlexServerUrl(url: string): string {
  try {
    const parsed = new URL(url)
    const match = parsed.hostname.match(
      /^(\d{1,3}-\d{1,3}-\d{1,3}-\d{1,3})\.[0-9a-f]+\.plex\.direct$/i,
    )
    const dashedIp = match?.[1]
    if (!dashedIp) return url
    const ip = dashedIp.replace(/-/g, '.')
    return `${ip}${parsed.port ? `:${parsed.port}` : ''}`
  } catch {
    return url
  }
}

// Plex is the only login method and its connection is resolved automatically
// at login (auth-plex.ts) -- there is nothing here for a user to configure,
// so this is read-only and starts collapsed, unlike the editable cards below.
function PlexConnectionCard({ settings, isAdmin }: { settings: Settings; isAdmin: boolean }) {
  const [open, setOpen] = useState(false)
  const connected = Boolean(settings.plexUrl)
  const { data: serverInfo } = useQuery({
    queryKey: ['plex-server-name'],
    queryFn: getPlexServerName,
    enabled: connected,
    staleTime: 5 * 60_000,
  })

  return (
    <Card>
      <CardHeader className="pt-3 pb-3">
        <div className="flex items-center justify-between gap-3">
          <CardTitle>
            <span className="flex items-center gap-2">
              <PlexIcon />
              Plex
            </span>
          </CardTitle>
          <div className="flex items-center gap-3">
            <span
              className={`flex items-center gap-1.5 text-xs ${connected ? 'text-approve' : 'text-muted'}`}
            >
              <span
                className={`inline-block h-2 w-2 rounded-full ${connected ? 'bg-approve' : 'bg-muted'}`}
              />
              {connected ? 'Connected' : 'Not configured'}
            </span>
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              aria-label={`${open ? 'Collapse' : 'Expand'} Plex`}
              className="text-muted hover:text-text"
            >
              <ChevronDown className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`} />
            </button>
          </div>
        </div>
      </CardHeader>
      {open && (
        <CardContent className="pt-3 pb-4 space-y-2 text-sm">
          <div className="flex items-center gap-3">
            {serverInfo?.name && <span className="text-text truncate">{serverInfo.name}</span>}
            <span
              className="text-xs text-muted font-mono truncate text-right ml-auto"
              title={settings.plexUrl || undefined}
            >
              {settings.plexUrl ? formatPlexServerUrl(settings.plexUrl) : '—'}
            </span>
          </div>
          {isAdmin ? (
            <PlexAdminControls />
          ) : (
            <p className="text-xs text-muted">Managed by your Plex admin.</p>
          )}
          {connected && (
            <div className="pt-2 border-t border-border space-y-1.5">
              <p className="text-xs font-medium text-text">Plex Webhook (optional)</p>
              <p className="text-xs text-muted">
                {
                  'Paste this URL into Plex Settings > Webhooks (requires Plex Pass on the Plex side) so recently-played tracks reach DJ Llama instantly, and newly-added media triggers an immediate library re-sync -- requests and recommendations get their "In Library" confirmation within seconds instead of waiting for the next periodic sync. Plex has no webhook event for removed media, so deletions still rely on the periodic sync. Other connected services (Spotify) have no webhook equivalent and stay poll-based.'
                }
              </p>
              <div className="flex gap-1.5">
                <input
                  type="text"
                  readOnly
                  value={`${window.location.origin}/api/v1/webhooks/plex`}
                  onFocus={(e) => e.currentTarget.select()}
                  className="flex-1 min-w-0 px-2.5 py-1.5 text-xs font-mono bg-bg border border-border rounded text-text"
                />
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard
                      .writeText(`${window.location.origin}/api/v1/webhooks/plex`)
                      .then(() => toast.success('Copied to clipboard'))
                  }}
                  className="px-2.5 py-1.5 text-xs border border-border rounded text-text hover:bg-bg"
                >
                  Copy
                </button>
              </div>
            </div>
          )}
        </CardContent>
      )}
    </Card>
  )
}

// Artist images and bios. The AudioDB/Wikidata switches are global (admin);
// the fanart.tv key and metadata fallback are per-user preferences.
function ArtworkCard({ settings, isAdmin }: { settings: Settings; isAdmin: boolean }) {
  const { data: prefs } = useQuery({
    queryKey: ['user-preferences'],
    queryFn: getUserPreferences,
  })

  useEffect(() => {
    if (typeof settings.audiodbProxyImages === 'boolean') {
      setAudiodbProxyFlag(settings.audiodbProxyImages)
    }
  }, [settings.audiodbProxyImages])

  if (!prefs) return null
  return <ArtworkCardInner settings={settings} prefs={prefs} isAdmin={isAdmin} />
}

function ArtworkCardInner({
  settings,
  prefs,
  isAdmin,
}: {
  settings: Settings
  prefs: Record<string, unknown>
  isAdmin: boolean
}) {
  const queryClient = useQueryClient()
  const fanartSaved = prefs.fanartApiKey === '***'
  const [fanartApiKey, setFanartApiKey] = useState(
    fanartSaved ? '' : String(prefs.fanartApiKey ?? ''),
  )
  const [metadataFallbackUrl, setMetadataFallbackUrl] = useState(
    String(prefs.metadataFallbackUrl ?? ''),
  )
  const [audiodbApiKey, setAudiodbApiKey] = useState(
    settings.audiodbApiKey === '***' ? '' : (settings.audiodbApiKey ?? ''),
  )
  const [audiodbProxyImages, setAudiodbProxyImages] = useState(Boolean(settings.audiodbProxyImages))
  const [wikidataEnabled, setWikidataEnabled] = useState(settings.wikidataEnabled !== false)
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    setSaving(true)
    try {
      await updateUserPreferences({
        // Blank keeps the stored key (the API only ever returns it masked).
        fanartApiKey: fanartApiKey || undefined,
        metadataFallbackUrl: metadataFallbackUrl || undefined,
      })
      if (isAdmin) {
        await updateSettings({
          audiodbApiKey: audiodbApiKey || (settings.audiodbApiKey === '***' ? undefined : null),
          audiodbProxyImages,
          wikidataEnabled,
        })
        setAudiodbProxyFlag(audiodbProxyImages)
      }
      queryClient.invalidateQueries({ queryKey: ['user-preferences'] })
      queryClient.invalidateQueries({ queryKey: ['settings'] })
      toast.success('Artwork settings saved')
    } catch {
      toast.error('Failed to save artwork settings')
    } finally {
      setSaving(false)
    }
  }

  return (
    <CollapsibleCard
      defaultCollapsed
      title="Artwork & Metadata"
      subtitle="Artist images come from TheAudioDB first, then Lidarr, fanart.tv, and an optional self-hosted metadata server."
    >
      <div className="space-y-3">
        {isAdmin && (
          <Field label="TheAudioDB premium API key (optional)" id="audiodb-api-key">
            <Input
              id="audiodb-api-key"
              type="password"
              value={audiodbApiKey}
              onChange={(e) => setAudiodbApiKey(e.target.value)}
              placeholder={
                settings.audiodbApiKey === '***'
                  ? `(saved)`
                  : 'Leave blank to use the free public key'
              }
            />
          </Field>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Fanart.tv API key (optional)" id="fanart-api-key">
            <Input
              id="fanart-api-key"
              type="password"
              value={fanartApiKey}
              onChange={(e) => setFanartApiKey(e.target.value)}
              placeholder={fanartSaved ? `(saved)` : undefined}
            />
          </Field>
          <Field label="Metadata fallback URL (optional)" id="metadata-fallback-url">
            <Input
              id="metadata-fallback-url"
              value={metadataFallbackUrl}
              onChange={(e) => setMetadataFallbackUrl(e.target.value)}
              placeholder="https://hearring-aid.example.com"
            />
          </Field>
        </div>
        <p className="text-xs text-muted">
          Last-resort artist image source: the URL of a self-hosted hearring-aid
          (SkyHook-compatible) server. Leave blank to skip it -- the public api.musicinfo.pro is
          offline.
        </p>
      </div>
      {isAdmin && (
        <div className="divide-y divide-border border-t border-border pt-3">
          <SettingRow
            label="Proxy images through DJ Llama"
            help="Hides your IP from the TheAudioDB CDN by routing image requests through this server."
          >
            <Toggle
              checked={audiodbProxyImages}
              onChange={setAudiodbProxyImages}
              label="Proxy images through DJ Llama"
            />
          </SettingRow>
          <SettingRow
            label="Wikidata enrichment"
            help="Show artist bio and external links on recommendation cards"
          >
            <Toggle
              checked={wikidataEnabled}
              onChange={setWikidataEnabled}
              label="Wikidata enrichment"
            />
          </SettingRow>
        </div>
      )}
      <div className="flex justify-end">
        <Button size="sm" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving...' : 'Save'}
        </Button>
      </div>
    </CollapsibleCard>
  )
}

function ConnectionsTab({ settings, onSaved }: { settings: Settings; onSaved: () => void }) {
  const { data: currentUser } = useQuery({ queryKey: ['currentUser'], queryFn: getCurrentUser })
  const isAdmin = currentUser?.isAdmin ?? false
  const prefs = settings.preferences ?? {}
  const [lidarrUrl, setLidarrUrl] = useState(settings.lidarrUrl ?? '')
  const [lidarrPublicUrl, setLidarrPublicUrl] = useState(prefs.lidarrPublicUrl ?? '')
  const [lidarrApiKey, setLidarrApiKey] = useState(
    settings.lidarrApiKey === '***' ? '' : (settings.lidarrApiKey ?? ''),
  )
  const [skipTlsVerify, setSkipTlsVerify] = useState<boolean>(Boolean(settings.skipTlsVerify))
  // Admin-only global defaults applied to every user's Lidarr requests -- see
  // withGlobalLidarrDefaults in server/helpers/preferences.ts for why these
  // live here (global settings) rather than per-user.
  const [qualityProfileId, setQualityProfileId] = useState(String(prefs.qualityProfileId ?? 1))
  const [metadataProfileId, setMetadataProfileId] = useState(String(prefs.metadataProfileId ?? 1))
  const [rootFolderId, setRootFolderId] = useState(
    prefs.rootFolderId != null ? String(prefs.rootFolderId) : '',
  )
  // Lidarr is required app-wide and can't be toggled off, so unlike every
  // other card, saving it for the first time (or after it's been broken)
  // requires a passing connection test first -- a typo'd URL should never
  // silently "save" into a state that then gates the whole app. Once a
  // working connection is already persisted, routine edits (e.g. the public
  // URL field) don't need re-testing every time.
  const lidarrPersisted = Boolean(settings.lidarrUrl && settings.lidarrApiKey)
  const { data: lidarrQualityProfiles } = useQuery({
    queryKey: ['lidarrProfiles'],
    queryFn: getLidarrProfiles,
    enabled: lidarrPersisted,
  })
  const { data: lidarrMetadataProfiles } = useQuery({
    queryKey: ['lidarrMetadataProfiles'],
    queryFn: getLidarrMetadataProfiles,
    enabled: lidarrPersisted,
  })
  const { data: lidarrRootFolders } = useQuery({
    queryKey: ['lidarrRootFolders'],
    queryFn: getLidarrRootFolders,
    enabled: lidarrPersisted,
  })
  // Snap selectors to the first real Lidarr option when none is set or the
  // stored id no longer exists among the loaded options. Otherwise the browser
  // can visibly select the first option while React state still holds stale id 1.
  useEffect(() => {
    if (!lidarrQualityProfiles || lidarrQualityProfiles.length === 0) return
    const first = lidarrQualityProfiles[0]
    if (first && !lidarrQualityProfiles.some((p) => String(p.id) === qualityProfileId)) {
      setQualityProfileId(String(first.id))
    }
  }, [lidarrQualityProfiles, qualityProfileId])
  useEffect(() => {
    if (!lidarrMetadataProfiles || lidarrMetadataProfiles.length === 0) return
    const first = lidarrMetadataProfiles[0]
    if (first && !lidarrMetadataProfiles.some((p) => String(p.id) === metadataProfileId)) {
      setMetadataProfileId(String(first.id))
    }
  }, [lidarrMetadataProfiles, metadataProfileId])
  useEffect(() => {
    if (!lidarrRootFolders || lidarrRootFolders.length === 0) return
    const first = lidarrRootFolders[0]
    if (first && !lidarrRootFolders.some((f) => String(f.id) === rootFolderId)) {
      setRootFolderId(String(first.id))
    }
  }, [lidarrRootFolders, rootFolderId])

  const [aiProvider, setAiProvider] = useState<string>(settings.aiProvider ?? 'anthropic')
  const [aiModel, setAiModel] = useState(settings.aiModel ?? '')
  const [aiApiKey, setAiApiKey] = useState(
    settings.aiApiKey === '***' ? '' : (settings.aiApiKey ?? ''),
  )
  const [aiBaseUrl, setAiBaseUrl] = useState(settings.aiBaseUrl ?? '')

  const [tests, setTests] = useState<Record<string, ServiceTestState>>({})
  const [saving, setSaving] = useState<Record<string, boolean>>({})

  const aiProviderLabel = 'AI Provider'

  function formatLabelMessage(key: string, label: string) {
    return key.replace('{0}', label)
  }

  function setTest(key: string, val: ServiceTestState) {
    setTests((prev) => ({ ...prev, [key]: val }))
  }
  function setSave(key: string, val: boolean) {
    setSaving((prev) => ({ ...prev, [key]: val }))
  }

  const configuredServices: Record<string, boolean> = {
    lidarr: Boolean(settings.lidarrUrl && settings.lidarrApiKey),
    ai: Boolean(settings.aiProvider && settings.aiModel),
  }

  // Toggle-card open/collapsed state, seeded from whether the connection is
  // already configured -- once a user flips a toggle, it stays as they left
  // it for the rest of this page visit (does not re-derive from `settings`
  // on every render, which would fight the user's own click).
  const [aiOpen, setAiOpen] = useState(configuredServices.ai)

  function serviceStatus(key: string): 'connected' | 'not_configured' | 'error' | 'testing' {
    const t = tests[key]
    if (t === 'testing') return 'testing'
    if (t === 'ok') return 'connected'
    if (t === 'error') return 'error'
    // If no test has been run but the service has saved credentials, show as connected
    if (configuredServices[key]) return 'connected'
    return 'not_configured'
  }

  function probeFailureDetail(err: unknown): string | null {
    if (err instanceof ApiError && err.data && typeof err.data === 'object') {
      const detail = (err.data as Record<string, unknown>).detail
      if (typeof detail === 'string' && detail.trim()) return detail.trim()
    }
    return null
  }

  function createTester(key: string, label: string, testFn: () => Promise<{ message: string }>) {
    return async () => {
      setTest(key, 'testing')
      try {
        await testFn()
        setTest(key, 'ok')
        toast.success(formatLabelMessage('{0} connected', label))
      } catch (err) {
        setTest(key, 'error')
        const base = formatLabelMessage('Could not reach {0}', label)
        const detail = probeFailureDetail(err)
        toast.error(detail ? `${base}: ${detail}` : base)
      }
    }
  }

  function createSaver(key: string, label: string, saveFn: () => Promise<unknown>) {
    return async () => {
      setSave(key, true)
      try {
        await saveFn()
        toast.success(formatLabelMessage('{0} settings saved', label))
        onSaved()
      } catch {
        toast.error(formatLabelMessage('Failed to save {0} settings', label))
      } finally {
        setSave(key, false)
      }
    }
  }

  // Turning a card's toggle off clears the underlying connection immediately
  // (not just a UI collapse) -- the rest of the app (AI-feature gating,
  // discovery pipeline source selection) reads directly from settings/user
  // connections, so "off" has to actually mean unset.
  function createClearer(key: string, label: string, clearFn: () => Promise<unknown>) {
    return async () => {
      setSave(key, true)
      try {
        await clearFn()
        toast.success(formatLabelMessage('{0} disconnected', label))
        onSaved()
      } catch {
        toast.error(formatLabelMessage('Failed to save {0} settings', label))
      } finally {
        setSave(key, false)
      }
    }
  }

  const testLidarr = createTester('lidarr', 'Lidarr', () =>
    testService('lidarr', { url: lidarrUrl, apiKey: lidarrApiKey }),
  )
  const saveLidarr = createSaver('lidarr', 'Lidarr', () =>
    updateSettings({
      lidarrUrl,
      lidarrApiKey: lidarrApiKey || undefined,
      skipTlsVerify,
      preferences: {
        ...prefs,
        lidarrPublicUrl: lidarrPublicUrl || undefined,
        qualityProfileId: parseInt(qualityProfileId, 10) || 1,
        metadataProfileId: parseInt(metadataProfileId, 10) || 1,
        rootFolderId: rootFolderId ? parseInt(rootFolderId, 10) : undefined,
      },
    }),
  )

  const testAi = createTester('ai', aiProviderLabel, () => {
    const config: Record<string, string> = { provider: aiProvider, model: aiModel }
    if (aiProvider !== 'ollama' && aiProvider !== 'openai-compatible') config.apiKey = aiApiKey
    if (aiProvider === 'openai-compatible' && aiApiKey) config.apiKey = aiApiKey
    if (aiProvider === 'ollama' || aiProvider === 'openai-compatible') config.baseUrl = aiBaseUrl
    return testService('ai', config)
  })
  const saveAi = createSaver('ai', aiProviderLabel, () =>
    updateSettings({
      aiProvider,
      aiModel: aiModel || undefined,
      aiApiKey: aiApiKey || undefined,
      aiBaseUrl: aiBaseUrl || undefined,
    }),
  )
  const clearAi = createClearer('ai', aiProviderLabel, () =>
    updateSettings({ aiProvider: '', aiModel: '', aiApiKey: '', aiBaseUrl: '' }),
  )
  function handleAiToggle(next: boolean) {
    if (next) {
      setAiOpen(true)
      return
    }
    setAiOpen(false)
    setAiProvider('anthropic')
    setAiModel('')
    setAiApiKey('')
    setAiBaseUrl('')
    void clearAi()
  }

  const isLidarrConfigured = !!(lidarrUrl || settings.lidarrUrl)
  // Blocked when broken (an explicit test just failed, even if a previously
  // working connection was persisted before this edit) or when never
  // verified yet for a brand-new connection -- either way, a bad Lidarr
  // config should never silently save into a state that gates the whole app.
  const lidarrSaveBlocked = tests.lidarr === 'error' || (!lidarrPersisted && tests.lidarr !== 'ok')
  const isAiConfigured = !!(aiModel || settings.aiModel)
  const aiPersisted = Boolean(settings.aiProvider && settings.aiModel)
  const aiSaveBlocked = tests.ai === 'error' || (!aiPersisted && tests.ai !== 'ok')

  return (
    <div className="space-y-4">
      {/* Reference table for what each integration actually does -- useful
          context before diving into individual connections, so it leads even
          before Plex. Remembered collapsed/expanded per user (see
          integration-capabilities.tsx), not a one-time dismissable hint. */}
      <IntegrationCapabilities />

      {/* Plex -- the account everyone actually signed in with, so it leads
          the tab rather than sitting buried under per-user connections. */}
      <PlexConnectionCard settings={settings} isAdmin={isAdmin} />

      {/* Non-admins see the shared server connections read-only. */}
      {!isAdmin ? (
        <>
          <ServiceCard
            name="Lidarr"
            status={settings.lidarrUrl ? 'connected' : 'not_configured'}
            icon={<LidarrIcon />}
          >
            <p className="text-sm text-muted">Only admins can modify global settings.</p>
          </ServiceCard>
          <ServiceCard
            name={aiProviderLabel}
            status={settings.aiModel ? 'connected' : 'not_configured'}
            icon={<AiProviderIcon provider={settings.aiProvider ?? 'anthropic'} />}
          >
            {settings.aiModel && (
              <p className="text-sm text-text">
                {settings.aiProvider} / {settings.aiModel}
              </p>
            )}
            <p className="text-sm text-muted">Only admins can modify global settings.</p>
          </ServiceCard>
        </>
      ) : (
        <>
          {/* Lidarr -- required, no toggle: the app has nothing to dispatch
              requests/recommendations to without it. */}
          <div>
            <ServiceCard
              name="Lidarr"
              description={
                <span>
                  Music library manager - required for adding artists.{' '}
                  <a
                    href="https://wiki.servarr.com/lidarr/settings#security"
                    target="_blank"
                    rel="noreferrer"
                    className="text-accent underline"
                  >
                    Get API key
                  </a>
                </span>
              }
              status={serviceStatus('lidarr')}
              icon={<LidarrIcon />}
            >
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field label="URL" id="lidarr-url">
                  <Input
                    id="lidarr-url"
                    type="url"
                    placeholder="http://localhost:8686"
                    value={lidarrUrl}
                    onChange={(e) => setLidarrUrl(e.target.value)}
                  />
                </Field>
                <Field label="API Key" id="lidarr-apikey">
                  <Input
                    id="lidarr-apikey"
                    type="password"
                    placeholder={settings.lidarrApiKey === '***' ? `(saved)` : 'API Key'}
                    value={lidarrApiKey}
                    onChange={(e) => setLidarrApiKey(e.target.value)}
                  />
                </Field>
              </div>
              <Field label="Public URL (optional)" id="lidarr-public-url">
                <Input
                  id="lidarr-public-url"
                  type="url"
                  placeholder="https://lidarr.example.com"
                  value={lidarrPublicUrl}
                  onChange={(e) => setLidarrPublicUrl(e.target.value)}
                />
                <p className="text-xs text-muted mt-1">
                  Browser-accessible URL for linking to Lidarr artist pages. Leave empty if the API
                  URL is already reachable from your browser.
                </p>
              </Field>
              <SettingRow
                label="Skip TLS certificate verification"
                help="Only enable this if Lidarr uses a self-signed certificate you trust. Disables certificate validation for requests to Lidarr."
              >
                <Toggle
                  checked={skipTlsVerify}
                  onChange={setSkipTlsVerify}
                  label="Skip TLS certificate verification"
                />
              </SettingRow>
              <div className="flex items-center justify-end gap-2 pt-1">
                {tests.lidarr === 'ok' && (
                  <span className="flex items-center gap-1 text-xs text-approve">
                    <Check size={14} aria-hidden="true" />
                    Test passed
                  </span>
                )}
                {tests.lidarr === 'error' && (
                  <span className="flex items-center gap-1 text-xs text-reject">
                    <X size={14} aria-hidden="true" />
                    Test failed
                  </span>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={testLidarr}
                  disabled={tests.lidarr === 'testing'}
                >
                  {tests.lidarr === 'testing' ? 'Testing...' : 'Test Connection'}
                </Button>
              </div>

              <div className="border-t border-border pt-3 space-y-3">
                <div>
                  <h4 className="text-sm font-medium text-text">
                    {'Default Profile & Root Folder'}
                  </h4>
                  <p className="text-xs text-muted mt-0.5">
                    {lidarrPersisted
                      ? 'Applied to every album/artist request across all users.'
                      : 'Test and save the server connection above first.'}
                  </p>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <Field label="Quality Profile" id="global-quality-profile">
                    <Select
                      id="global-quality-profile"
                      value={qualityProfileId}
                      disabled={!lidarrPersisted}
                      onChange={(e) => setQualityProfileId(e.target.value)}
                    >
                      {lidarrQualityProfiles ? (
                        lidarrQualityProfiles.map((p) => (
                          <option key={p.id} value={String(p.id)}>
                            {p.name}
                          </option>
                        ))
                      ) : (
                        <option value={qualityProfileId}>Loading...</option>
                      )}
                    </Select>
                  </Field>
                  <Field label="Metadata Profile" id="global-metadata-profile">
                    <Select
                      id="global-metadata-profile"
                      value={metadataProfileId}
                      disabled={!lidarrPersisted}
                      onChange={(e) => setMetadataProfileId(e.target.value)}
                    >
                      {lidarrMetadataProfiles ? (
                        lidarrMetadataProfiles.map((p) => (
                          <option key={p.id} value={String(p.id)}>
                            {p.name}
                          </option>
                        ))
                      ) : (
                        <option value={metadataProfileId}>Loading...</option>
                      )}
                    </Select>
                  </Field>
                  <Field label="Root Folder" id="global-root-folder">
                    <Select
                      id="global-root-folder"
                      value={rootFolderId}
                      disabled={!lidarrPersisted}
                      onChange={(e) => setRootFolderId(e.target.value)}
                    >
                      {lidarrRootFolders ? (
                        lidarrRootFolders.map((f) => (
                          <option key={f.id} value={String(f.id)}>
                            {f.path}
                          </option>
                        ))
                      ) : (
                        <option value={rootFolderId}>Loading...</option>
                      )}
                    </Select>
                  </Field>
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-1">
                <Button
                  size="sm"
                  onClick={saveLidarr}
                  disabled={saving.lidarr || lidarrSaveBlocked}
                  title={
                    lidarrSaveBlocked
                      ? 'Test the connection successfully before saving.'
                      : undefined
                  }
                  data-testid="lidarr-save"
                >
                  {saving.lidarr ? 'Saving...' : isLidarrConfigured ? 'Save' : 'Configure'}
                </Button>
              </div>
              {lidarrSaveBlocked && (
                <p className="text-xs text-muted text-right">
                  Test the connection successfully before saving.
                </p>
              )}
            </ServiceCard>
          </div>

          {/* AI Provider */}
          <Hint id="settings-ai-tip" type="inline">
            Choose an AI provider to power recommendations. Ollama runs locally for free. Cloud
            providers (Claude, GPT, Gemini) need API keys.
          </Hint>
          <div>
            <ServiceCard
              name={aiProviderLabel}
              description={
                <span>
                  Generates music recommendations.{' '}
                  {aiProvider === 'anthropic' && (
                    <a
                      href="https://console.anthropic.com/settings/keys"
                      target="_blank"
                      rel="noreferrer"
                      className="text-accent underline"
                    >
                      Get API key
                    </a>
                  )}
                  {aiProvider === 'openai' && (
                    <a
                      href="https://platform.openai.com/api-keys"
                      target="_blank"
                      rel="noreferrer"
                      className="text-accent underline"
                    >
                      Get API key
                    </a>
                  )}
                  {aiProvider === 'gemini' && (
                    <a
                      href="https://aistudio.google.com/apikey"
                      target="_blank"
                      rel="noreferrer"
                      className="text-accent underline"
                    >
                      Get API key
                    </a>
                  )}
                  {aiProvider === 'ollama' && (
                    <a
                      href="https://ollama.com/library"
                      target="_blank"
                      rel="noreferrer"
                      className="text-accent underline"
                    >
                      Browse models
                    </a>
                  )}
                </span>
              }
              status={serviceStatus('ai')}
              icon={<AiProviderIcon provider={aiProvider} />}
              enabled={aiOpen}
              onEnabledChange={handleAiToggle}
            >
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field label="Provider" id="ai-provider">
                  <Select
                    id="ai-provider"
                    value={aiProvider}
                    onChange={(e) => setAiProvider(e.target.value)}
                  >
                    <option value="anthropic">Anthropic</option>
                    <option value="openai">OpenAI</option>
                    <option value="gemini">Google Gemini</option>
                    <option value="ollama">Ollama</option>
                    <option value="openai-compatible">OpenAI-Compatible</option>
                  </Select>
                </Field>
                <Field label="Model" id="ai-model">
                  <AiModelField
                    id="ai-model"
                    provider={aiProvider}
                    model={aiModel}
                    baseUrl={aiBaseUrl}
                    onModelChange={setAiModel}
                  />
                </Field>
              </div>
              {aiProvider !== 'ollama' && (
                <Field
                  label={aiProvider === 'openai-compatible' ? 'API Key (optional)' : 'API Key'}
                  id="ai-apikey"
                >
                  <Input
                    id="ai-apikey"
                    type="password"
                    placeholder={settings.aiApiKey === '***' ? `(saved)` : 'API Key'}
                    value={aiApiKey}
                    onChange={(e) => setAiApiKey(e.target.value)}
                  />
                </Field>
              )}
              {(aiProvider === 'ollama' || aiProvider === 'openai-compatible') && (
                <Field label="Base URL" id="ai-baseurl">
                  <Input
                    id="ai-baseurl"
                    type="url"
                    placeholder={
                      aiProvider === 'openai-compatible'
                        ? 'http://localhost:8080'
                        : 'http://localhost:11434'
                    }
                    value={aiBaseUrl}
                    onChange={(e) => setAiBaseUrl(e.target.value)}
                  />
                </Field>
              )}
              {aiProvider === 'openai-compatible' && (
                <p className="text-xs text-muted">
                  Works with Groq, OpenRouter, LiteLLM, LocalAI, and any OpenAI-compatible endpoint.
                  API key is optional for local services.
                </p>
              )}
              {(() => {
                const local = isLocalAiProvider(aiProvider, aiBaseUrl)
                return (
                  <div className="flex flex-col gap-1.5 sm:flex-row sm:items-start sm:gap-3 pt-1">
                    <Badge
                      variant={local ? 'success' : 'info'}
                      className="self-start whitespace-nowrap"
                    >
                      {local ? 'Fully local' : 'Data leaves your server'}
                    </Badge>
                    <p className="text-xs text-muted">
                      {local
                        ? 'Discovery prompts stay on your server.'
                        : 'Discovery prompts are sent to your chosen provider under their terms. Use Ollama on localhost or a local OpenAI-compatible endpoint to keep them on your server.'}
                    </p>
                  </div>
                )
              })()}
              <div className="flex items-center justify-end gap-2 pt-1">
                {tests.ai === 'ok' && (
                  <span className="flex items-center gap-1 text-xs text-approve">
                    <Check size={14} aria-hidden="true" />
                    Test passed
                  </span>
                )}
                {tests.ai === 'error' && (
                  <span className="flex items-center gap-1 text-xs text-reject">
                    <X size={14} aria-hidden="true" />
                    Test failed
                  </span>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={testAi}
                  disabled={tests.ai === 'testing'}
                >
                  {tests.ai === 'testing' ? 'Testing...' : 'Test Connection'}
                </Button>
              </div>
              <div className="flex justify-end gap-2 pt-1">
                <Button
                  size="sm"
                  onClick={saveAi}
                  disabled={saving.ai || aiSaveBlocked}
                  title={
                    aiSaveBlocked ? 'Test the connection successfully before saving.' : undefined
                  }
                  data-testid="ai-save"
                >
                  {saving.ai ? 'Saving...' : isAiConfigured ? 'Save' : 'Configure'}
                </Button>
              </div>
              {aiSaveBlocked && (
                <p className="text-xs text-muted text-right">
                  Test the connection successfully before saving.
                </p>
              )}
            </ServiceCard>
          </div>

          {/* Notification channels */}
          <NotificationChannelsCard settings={settings} isAdmin={isAdmin} onSaved={onSaved} />
        </>
      )}

      <ArtworkCard settings={settings} isAdmin={isAdmin} />
    </div>
  )
}

// Plain-language presets over the pipeline's raw 0-1 knobs. A stored value
// from the old slider UI snaps to the nearest preset on load.
const PICKINESS_PRESETS = [
  {
    value: 0.35,
    label: 'Relaxed',
    help: 'More variety, including a few longer shots.',
  },
  {
    value: 0.5,
    label: 'Balanced',
    help: 'A mix of safe bets and surprises.',
  },
  {
    value: 0.65,
    label: 'Strict',
    help: 'Only close matches to what you already love.',
  },
] as const satisfies readonly { value: number; label: string; help: string }[]

const AUTO_APPROVE_PRESETS = [
  { value: 0.8, label: 'Confident' },
  { value: 0.9, label: 'Very confident' },
] as const satisfies readonly { value: number; label: string }[]

function nearestPreset(presets: readonly { value: number }[], value: number): number {
  let best = presets[0]?.value ?? value
  for (const preset of presets) {
    if (Math.abs(preset.value - value) < Math.abs(best - value)) best = preset.value
  }
  return best
}

function DiscoveryTab({ settings, isAdmin }: { settings: Settings; isAdmin: boolean }) {
  const { data: prefs, isLoading } = useQuery({
    queryKey: ['user-preferences'],
    queryFn: getUserPreferences,
  })

  if (isLoading || !prefs) {
    return <div className="text-sm text-muted">Loading preferences...</div>
  }

  return <DiscoveryTabInner prefs={prefs} settings={settings} isAdmin={isAdmin} />
}

// Server-wide similar-track sources. ListenBrainz needs nothing; Last.fm turns
// on once an admin saves a (free) API key. Saved separately from the per-user
// preferences below because it applies to everyone's discovery runs.
function SimilaritySourcesCard({ settings, isAdmin }: { settings: Settings; isAdmin: boolean }) {
  const queryClient = useQueryClient()
  const saved = settings.lastfmApiKey === '***'
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState<'test' | 'save' | 'remove' | null>(null)

  async function save(value: string | null) {
    setBusy(value === null ? 'remove' : 'save')
    try {
      await updateSettings({ lastfmApiKey: value })
      setApiKey('')
      queryClient.invalidateQueries({ queryKey: ['settings'] })
      toast.success(value === null ? 'Last.fm turned off' : 'Last.fm turned on')
    } catch {
      toast.error("Couldn't save the Last.fm key")
    } finally {
      setBusy(null)
    }
  }

  async function test() {
    setBusy('test')
    try {
      const res = await testService('lastfm', { apiKey })
      toast.success(res.message)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Last.fm key test failed')
    } finally {
      setBusy(null)
    }
  }

  return (
    <CollapsibleCard
      title="Similar-track sources"
      subtitle="Services that find tracks similar to the ones you like and play. The albums those tracks are on become your recommendations, alongside AI picks."
    >
      <div className="divide-y divide-border">
        <div className="flex items-start justify-between gap-4 pb-3">
          <div className="min-w-0">
            <p className="text-sm text-text">ListenBrainz</p>
            <p className="text-xs text-muted mt-0.5">
              Free and always on. Finds well-known tracks by artists similar to the ones you play.
            </p>
          </div>
          <span className="shrink-0 text-xs font-medium text-approve">On</span>
        </div>
        <div className="py-3 last:pb-0 space-y-2">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm text-text">Last.fm</p>
              <p className="text-xs text-muted mt-0.5">
                {saved ? (
                  'Finds tracks Last.fm listeners play alongside yours. Tracks both services agree on rank higher.'
                ) : (
                  <>
                    Add a free{' '}
                    <a
                      href="https://www.last.fm/api/account/create"
                      target="_blank"
                      rel="noreferrer"
                      className="text-accent underline"
                    >
                      Last.fm API key
                    </a>{' '}
                    to turn it on. No Last.fm account history is used.
                  </>
                )}
              </p>
            </div>
            <span
              className={`shrink-0 text-xs font-medium ${saved ? 'text-approve' : 'text-muted'}`}
            >
              {saved ? 'On' : 'Off'}
            </span>
          </div>
          {isAdmin ? (
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                id="lastfm-api-key"
                type="password"
                aria-label="Last.fm API key"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={saved ? 'Saved. Paste a new key to replace it' : 'Last.fm API key'}
                autoComplete="off"
                spellCheck={false}
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={test}
                  disabled={busy !== null || (!apiKey && !saved)}
                >
                  {busy === 'test' ? 'Testing...' : 'Test'}
                </Button>
                <Button
                  size="sm"
                  aria-label="Save Last.fm key"
                  onClick={() => save(apiKey.trim())}
                  disabled={busy !== null || !apiKey.trim()}
                >
                  {busy === 'save' ? 'Saving...' : 'Save'}
                </Button>
                {saved && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => save(null)}
                    disabled={busy !== null}
                  >
                    {busy === 'remove' ? 'Removing...' : 'Remove'}
                  </Button>
                )}
              </div>
            </div>
          ) : (
            !saved && <p className="text-xs text-muted">An admin can turn this on.</p>
          )}
        </div>
      </div>
    </CollapsibleCard>
  )
}

function DiscoveryTabInner({
  prefs,
  settings,
  isAdmin,
}: {
  prefs: Record<string, unknown>
  settings: Settings
  isAdmin: boolean
}) {
  const queryClient = useQueryClient()
  const storedSeedRatio =
    (prefs.librarySeedRatio as number | undefined) ?? DEFAULT_PREFERENCES.librarySeedRatio
  const storedCooldown =
    (prefs.rejectionCooldownDays as number | undefined) ?? DEFAULT_PREFERENCES.rejectionCooldownDays

  const [scoreThreshold, setScoreThreshold] = useState(() =>
    nearestPreset(
      PICKINESS_PRESETS,
      (prefs.scoreThreshold as number | undefined) ?? DEFAULT_PREFERENCES.scoreThreshold,
    ),
  )
  const [libraryMix, setLibraryMix] = useState(storedSeedRatio > 0)
  const historySourcesEnabled =
    (prefs.historySourcesEnabled as Preferences['historySourcesEnabled']) ?? {}
  const [plexHistoryEnabled, setPlexHistoryEnabled] = useState(historySourcesEnabled.plex !== false)
  const [rejectionCooldown, setRejectionCooldown] = useState(String(storedCooldown))
  const [autoApproveEnabled, setAutoApproveEnabled] = useState(
    (prefs.autoApproveEnabled as boolean | undefined) ?? false,
  )
  const [autoApproveThreshold, setAutoApproveThreshold] = useState(() =>
    nearestPreset(
      AUTO_APPROVE_PRESETS,
      (prefs.autoApproveThreshold as number | undefined) ??
        DEFAULT_PREFERENCES.autoApproveThreshold ??
        0.8,
    ),
  )
  const [autoApproveMonitorOption, setAutoApproveMonitorOption] = useState<string>(
    // Legacy 'none' (artist added unmonitored) is no longer offered.
    prefs.autoApproveMonitorOption === 'all' || prefs.autoApproveMonitorOption === 'new'
      ? prefs.autoApproveMonitorOption
      : 'recommended',
  )
  const [saving, setSaving] = useState(false)

  const pickiness =
    PICKINESS_PRESETS.find((p) => p.value === scoreThreshold) ?? PICKINESS_PRESETS[1]

  async function handleSave() {
    setSaving(true)
    const cooldownDays = Number.parseInt(rejectionCooldown, 10)
    try {
      await updateUserPreferences({
        scoreThreshold,
        // The per-signal weight sliders are gone; reset any old custom tuning
        // so nothing invisible keeps skewing the ranking.
        scoringWeights: DEFAULT_PREFERENCES.scoringWeights,
        rejectionCooldownDays: Number.isNaN(cooldownDays)
          ? storedCooldown
          : Math.max(0, cooldownDays),
        librarySeedRatio: libraryMix
          ? storedSeedRatio > 0
            ? storedSeedRatio
            : DEFAULT_PREFERENCES.librarySeedRatio
          : 0,
        autoApproveEnabled,
        autoApproveThreshold,
        autoApproveMonitorOption: autoApproveMonitorOption as 'recommended' | 'all' | 'new',
        historySourcesEnabled: { plex: plexHistoryEnabled },
      })
      queryClient.invalidateQueries({ queryKey: ['user-preferences'] })
      toast.success('Discovery preferences saved')
    } catch {
      toast.error('Failed to save discovery preferences')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      <CollapsibleCard
        title="How picky should DJ Llama be?"
        subtitle="How strong a match has to be before it shows up on Discover."
      >
        <Segmented
          label="How picky should DJ Llama be?"
          options={PICKINESS_PRESETS.map((p) => ({ value: p.value, label: p.label }))}
          value={scoreThreshold}
          onChange={setScoreThreshold}
        />
        <p className="text-xs text-muted">{pickiness.help}</p>
      </CollapsibleCard>

      <CollapsibleCard
        title="What to draw from"
        subtitle="Where DJ Llama looks for artists you might like."
      >
        <div className="divide-y divide-border">
          <SettingRow
            label="Plex listening history"
            help="Find artists similar to what you actually play."
          >
            <Toggle
              checked={plexHistoryEnabled}
              onChange={setPlexHistoryEnabled}
              label="Plex listening history"
            />
          </SettingRow>
          <SettingRow
            label="Mix in your library"
            help="Also seed discovery from artists you already own, not just what you listen to."
          >
            <Toggle checked={libraryMix} onChange={setLibraryMix} label="Mix in your library" />
          </SettingRow>
          <SettingRow
            label="Hide rejected artists for"
            help="Once you reject an artist, they won't be suggested again for this long."
            htmlFor="rejection-cooldown"
          >
            <div className="flex items-center gap-2">
              <Input
                id="rejection-cooldown"
                type="number"
                min={0}
                value={rejectionCooldown}
                onChange={(e) => setRejectionCooldown(e.target.value)}
                className="w-20 text-right"
              />
              <span className="text-sm text-muted">days</span>
            </div>
          </SettingRow>
        </div>
      </CollapsibleCard>

      <SimilaritySourcesCard settings={settings} isAdmin={isAdmin} />

      <CollapsibleCard
        title="Auto-Request"
        subtitle="Send the strongest recommendations straight to Lidarr after each scan, no swiping needed."
        headerExtra={
          <Toggle
            checked={autoApproveEnabled}
            onChange={setAutoApproveEnabled}
            label="Enable auto-request"
          />
        }
      >
        <div className={`divide-y divide-border ${autoApproveEnabled ? '' : 'opacity-50'}`}>
          <SettingRow label="Only when DJ Llama is">
            <Segmented
              label="Only when DJ Llama is"
              options={AUTO_APPROVE_PRESETS.map((p) => ({ value: p.value, label: p.label }))}
              value={autoApproveThreshold}
              onChange={setAutoApproveThreshold}
            />
          </SettingRow>
          <SettingRow label="Monitor mode" htmlFor="auto-approve-monitor">
            <Select
              id="auto-approve-monitor"
              value={autoApproveMonitorOption}
              onChange={(e) => setAutoApproveMonitorOption(e.target.value)}
              className="sm:w-auto"
            >
              <option value="recommended">Just the recommended album</option>
              <option value="all">Whole artist: all albums</option>
              <option value="new">Whole artist: future releases only</option>
            </Select>
          </SettingRow>
        </div>
      </CollapsibleCard>

      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={saving}>
          {saving ? 'Saving...' : 'Save'}
        </Button>
      </div>
    </div>
  )
}

const LIBRARY_SYNC_HOURS = [1, 2, 3, 4, 6, 8, 12, 24]

// Keeps a previously saved off-list value (the API accepts any 1-24) selectable.
function librarySyncOptions(current: string): number[] {
  const n = Number.parseInt(current, 10)
  return Number.isNaN(n) || LIBRARY_SYNC_HOURS.includes(n)
    ? LIBRARY_SYNC_HOURS
    : [...LIBRARY_SYNC_HOURS, n].sort((a, b) => a - b)
}

function ScheduleTab({ settings }: { settings: Settings }) {
  const prefs = settings.preferences ?? {}
  const [cron, setCron] = useState(prefs.scheduleCron ?? '0 0 * * *')
  const [librarySyncIntervalHours, setLibrarySyncIntervalHours] = useState(
    String(settings.librarySyncIntervalHours ?? 6),
  )
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    setSaving(true)
    try {
      await updateSettings({
        preferences: { ...prefs, scheduleCron: cron },
        librarySyncIntervalHours: Number.parseInt(librarySyncIntervalHours, 10) || 6,
      })
      toast.success('Schedule saved')
    } catch {
      toast.error('Failed to save schedule')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      <Hint id="settings-schedule-tip" type="inline">
        Choose when DJ Llama looks for new music on its own. Once a week (say, Monday morning) is a
        popular choice.
      </Hint>

      <CollapsibleCard
        title="Discovery schedule"
        subtitle="When the discovery pipeline runs on its own."
      >
        <CronPicker value={cron} onChange={setCron} />
      </CollapsibleCard>

      <CollapsibleCard
        title="Library sync"
        subtitle="How often DJ Llama re-checks your music library and reruns library health scans."
      >
        <SettingRow label="Refresh" htmlFor="library-sync-interval-hours">
          <Select
            id="library-sync-interval-hours"
            value={librarySyncIntervalHours}
            onChange={(e) => setLibrarySyncIntervalHours(e.target.value)}
            className="sm:w-56"
          >
            {librarySyncOptions(librarySyncIntervalHours).map((h) => (
              <option key={h} value={String(h)}>
                {h === 1 ? 'Every hour' : h === 24 ? 'Once a day' : `Every ${h} hours`}
              </option>
            ))}
          </Select>
        </SettingRow>
      </CollapsibleCard>

      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={saving}>
          {saving ? 'Saving...' : 'Save'}
        </Button>
      </div>
    </div>
  )
}

function SettingsHeader() {
  return (
    <div>
      <h1 className="text-2xl font-display tracking-wide text-text">Settings</h1>
      <p className="text-xs text-muted mt-0.5">
        Your connections and discovery preferences, plus server administration.
      </p>
    </div>
  )
}

const settingsLayoutClass =
  'md:grid md:grid-cols-[13rem_minmax(0,1fr)] md:gap-8 space-y-6 md:space-y-0'

function SettingsSkeleton() {
  return (
    <div className={settingsLayoutClass}>
      <div className="space-y-1.5">
        {[1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className="h-8 w-full rounded-md" />
        ))}
      </div>
      <div className="space-y-4">
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-28 w-full rounded-lg" />
        ))}
      </div>
    </div>
  )
}

export function SettingsPage() {
  const queryClient = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()
  const initialTab = parseTab(searchParams.get('tab'))
  const [tab, setTab] = useState<Tab>(initialTab ?? 'connections')
  const { data: currentUser } = useQuery({ queryKey: ['currentUser'], queryFn: getCurrentUser })
  const isAdmin = currentUser?.isAdmin ?? false
  const navGroups = useSettingsNav(isAdmin)
  const {
    data,
    isLoading: loading,
    error,
  } = useQuery({
    queryKey: ['settings'],
    queryFn: getSettings,
  })

  function refetch() {
    queryClient.invalidateQueries({ queryKey: ['settings'] })
  }

  useEffect(() => {
    if (initialTab && initialTab !== tab) {
      setTab(initialTab)
    }
  }, [initialTab, tab])

  function handleTabChange(nextTab: Tab) {
    setTab(nextTab)
    const nextParams = new URLSearchParams(searchParams)
    nextParams.set('tab', nextTab)
    setSearchParams(nextParams, { replace: true })
  }

  if (loading) {
    return (
      <div className="p-6 space-y-6 max-w-6xl mx-auto">
        <SettingsHeader />
        <SettingsSkeleton />
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="p-6 max-w-6xl mx-auto text-reject">
        <p>Something went wrong: {error?.message ?? 'Unknown error'}</p>
        <Button variant="outline" size="sm" onClick={refetch} className="mt-3">
          Try again
        </Button>
      </div>
    )
  }

  return (
    <div className="p-6 space-y-6 max-w-6xl mx-auto pb-24 md:pb-6">
      <SettingsHeader />
      <div className={settingsLayoutClass}>
        <SettingsNav groups={navGroups} active={tab} onChange={handleTabChange} />
        <div className={`min-w-0 ${NARROW_TABS.has(tab) ? 'max-w-3xl' : ''}`}>
          {tab === 'connections' && <ConnectionsTab settings={data} onSaved={refetch} />}
          {tab === 'discovery' && <DiscoveryTab settings={data} isAdmin={isAdmin} />}
          {tab === 'schedule' && <ScheduleTab settings={data} />}
          {tab === 'users' && <UserManagementPage embedded />}
          {tab === 'administration' && <AdministrationTab />}
          {tab === 'system-health' && (
            <div className="space-y-8">
              <SystemHealthCard embedded />
              <JobHistoryPage embedded />
            </div>
          )}
          {tab === 'library-health' && <LibraryHealthPage embedded />}
          {tab === 'analytics' && <AnalyticsPage embedded />}
        </div>
      </div>
    </div>
  )
}
