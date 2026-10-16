import * as z from 'zod'
import type { NotificationChannel } from '@/core/notifications/types'

// Inner preferences object. Enforces numeric ranges where they exist and
// keeps every field optional so partial PATCH merges stay ergonomic. Strict
// shape (no passthrough) rejects unknown keys up front so a hostile or buggy
// admin client cannot inflate the preferences jsonb with arbitrary garbage.
// Every key here must stay in lockstep with Preferences in src/db/schema.ts.
const scoringWeightsSchema = z
  .object({
    consensus: z.number().min(0).max(1).optional(),
    similarity: z.number().min(0).max(1).optional(),
    genreOverlap: z.number().min(0).max(1).optional(),
    aiConfidence: z.number().min(0).max(1).optional(),
    feedbackBoost: z.number().min(0).max(1).optional(),
    popularity: z.number().min(0).max(1).optional(),
  })
  .strict()

// Notification channels. Secret string fields (telegram botToken, ntfy token,
// apprise urls, pushover token/userKey) stay plain z.string() so the masked
// '***' placeholder round-trips on save; only real URLs that are never masked
// get .url() validation.
const notificationEvent = z.enum([
  'batch_complete',
  'digest',
  'request_pending_approval',
  'request_auto_approved',
  'recommendation_approved',
  'recommendations_available',
  'playlist_generated',
])
const channelBase = {
  id: z.string().min(1),
  enabled: z.boolean(),
  events: z.array(notificationEvent),
  allowPrivateTarget: z.boolean().optional(),
}
export const notificationChannel = z.discriminatedUnion('type', [
  z.object({ ...channelBase, type: z.literal('webhook'), url: z.string().url() }),
  z.object({
    ...channelBase,
    type: z.literal('ntfy'),
    server: z.string().url(),
    topic: z.string().min(1),
    priority: z
      .union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)])
      .optional(),
    token: z.string().optional(),
  }),
  z.object({
    ...channelBase,
    type: z.literal('telegram'),
    botToken: z.string().min(1),
    chatId: z.string().min(1),
  }),
  z.object({
    ...channelBase,
    type: z.literal('apprise'),
    endpoint: z.string().url(),
    urls: z.string().min(1),
  }),
  z.object({
    ...channelBase,
    type: z.literal('pushover'),
    token: z.string().min(1),
    userKey: z.string().min(1),
    priority: z.union([z.literal(-2), z.literal(-1), z.literal(0), z.literal(1)]).optional(),
  }),
]) satisfies z.ZodType<NotificationChannel>

const preferencesSchema = z.object({
  qualityProfileId: z.number().int().optional(),
  metadataProfileId: z.number().int().optional(),
  rootFolderId: z.number().int().optional(),
  scheduleCron: z.string().optional(),
  digestCron: z.string().optional(),
  scoreThreshold: z.number().min(0).max(1).optional(),
  scoringWeights: scoringWeightsSchema.optional(),
  rejectionCooldownDays: z.number().int().min(0).optional(),
  topArtistsLimit: z.number().int().min(1).optional(),
  librarySeedRatio: z.number().min(0).max(1).optional(),
  webhookUrl: z.string().optional(),
  lidarrPublicUrl: z.string().optional(),
  autoApproveEnabled: z.boolean().optional(),
  autoApproveThreshold: z.number().min(0).max(1).optional(),
  autoApproveMonitorOption: z.enum(['recommended', 'all', 'new']).optional(),
  playlistSize: z.number().int().min(1).optional(),
  playlistSchedule: z.string().optional(),
  seasonalPlaylistsEnabled: z.boolean().optional(),
  reviewWindowDays: z.number().int().min(1).optional(),
  dismissedHints: z.array(z.string()).optional(),
  fanartApiKey: z.string().optional(),
  metadataFallbackUrl: z.string().optional(),
  channels: z.array(notificationChannel).optional(),
})
// Not .strict(): the client round-trips the whole stored preferences object
// on every save (see settings.tsx handleSave), and retired fields (e.g.
// dailyMixEnabled, playlistEnabled, subscriptionMode) can still be sitting
// in an existing install's settings row from before they were dropped from
// this schema. Strip unknown keys instead of rejecting the entire save.

// PATCH body for /api/settings. Every field optional - it's a partial update.
// Unknown top-level keys are silently stripped (matches the existing allowlist
// behavior). Per-field types prevent accidental string-where-number bugs from
// the UI or curl.
export const updateSettingsSchema = z.object({
  // Lidarr (global, admin-only in handler) -- required, never cleared via this route
  lidarrUrl: z.string().optional(),
  lidarrApiKey: z.string().optional(),
  skipTlsVerify: z.boolean().optional(),
  librarySyncIntervalHours: z.number().int().min(1).max(24).optional(),

  // AI (global, admin-only)
  aiProvider: z.string().optional(),
  aiApiKey: z.string().optional(),
  aiModel: z.string().optional(),
  aiBaseUrl: z.string().optional(),

  // Metadata enrichment (global)
  audiodbApiKey: z.string().nullable().optional(),
  lastfmApiKey: z.string().max(200).nullable().optional(),
  audiodbProxyImages: z.boolean().optional(),
  wikidataEnabled: z.boolean().optional(),

  // Preferences (nested)
  preferences: preferencesSchema.optional(),
})
