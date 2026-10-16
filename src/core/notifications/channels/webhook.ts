import { redactUrlForLog } from '../../clients/http'
import { type PostResult, post } from '../transport'
import type { WebhookChannel, WebhookPayload } from '../types'

function redactWebhookUrl(url: string): string {
  const redacted = redactUrlForLog(url)
  try {
    const parsed = new URL(redacted)
    const host = parsed.hostname
    const isDiscordHost = host.endsWith('discord.com') || host.endsWith('discordapp.com')
    const isSlackHost = host.endsWith('slack.com')
    if (!isDiscordHost && !isSlackHost) return redacted
    const segments = parsed.pathname.split('/')
    for (let i = segments.length - 1; i >= 0; i--) {
      if (segments[i] !== '') {
        segments[i] = '[REDACTED]'
        break
      }
    }
    return parsed.origin + segments.join('/') + parsed.search + parsed.hash
  } catch {
    return redacted
  }
}

function isDiscordWebhook(url: string): boolean {
  try {
    const u = new URL(url)
    return u.hostname.endsWith('discord.com') || u.hostname.endsWith('discordapp.com')
  } catch {
    return false
  }
}

export function formatDiscordPayload(payload: WebhookPayload): Record<string, unknown> {
  const accent = 0x7c3aed // accent purple
  const footer = { text: 'DJ Llama' }

  switch (payload.event) {
    case 'digest':
      return {
        embeds: [
          {
            title: 'Digest',
            description: payload.message,
            color: accent,
            fields: [
              { name: 'Discovered', value: String(payload.stats.discovered), inline: true },
              { name: 'Added', value: String(payload.stats.added), inline: true },
              { name: 'Runs', value: String(payload.stats.runs), inline: true },
            ],
            timestamp: payload.timestamp,
            footer,
          },
        ],
      }
    case 'batch_complete':
      return {
        embeds: [
          {
            title: 'Scan Complete',
            description: payload.message,
            color: accent,
            fields: [
              { name: 'Discovered', value: String(payload.stats.discovered), inline: true },
              { name: 'Added', value: String(payload.stats.added), inline: true },
              { name: 'Failed', value: String(payload.stats.failed), inline: true },
            ],
            timestamp: payload.timestamp,
            footer,
          },
        ],
      }
    case 'request_pending_approval':
      return {
        embeds: [
          {
            title: 'New Request Pending Approval',
            description: payload.message,
            color: accent,
            image: payload.imageUrl ? { url: payload.imageUrl } : undefined,
            timestamp: payload.timestamp,
            footer,
          },
        ],
      }
    case 'request_auto_approved':
      return {
        embeds: [
          {
            title:
              payload.status === 'failed'
                ? 'Request Auto-Approval Failed'
                : 'Request Auto-Approved',
            description: payload.message,
            color: payload.status === 'failed' ? 0xdc2626 : accent,
            image: payload.imageUrl ? { url: payload.imageUrl } : undefined,
            timestamp: payload.timestamp,
            footer,
          },
        ],
      }
    case 'recommendation_approved':
      return {
        embeds: [
          {
            title:
              payload.status === 'failed' ? 'Recommendation Approval Failed' : 'Sent to Lidarr',
            description: payload.message,
            color: payload.status === 'failed' ? 0xdc2626 : accent,
            image: payload.imageUrl ? { url: payload.imageUrl } : undefined,
            timestamp: payload.timestamp,
            footer,
          },
        ],
      }
    case 'recommendations_available':
      return {
        embeds: [
          {
            title: 'New Recommendations Available',
            description: payload.message,
            color: accent,
            timestamp: payload.timestamp,
            footer,
          },
        ],
      }
    case 'playlist_generated':
      return {
        embeds: [
          {
            title: 'Playlist Generated',
            description: payload.message,
            color: accent,
            timestamp: payload.timestamp,
            footer,
          },
        ],
      }
  }
}

export function sendWebhookChannel(
  channel: WebhookChannel,
  payload: WebhookPayload,
): Promise<PostResult> {
  const body = isDiscordWebhook(channel.url) ? formatDiscordPayload(payload) : payload
  return post(channel.url, body, {
    allowPrivate: channel.allowPrivateTarget,
    redact: redactWebhookUrl,
  })
}
