export type NotificationEvent =
  | 'batch_complete'
  | 'digest'
  | 'request_pending_approval'
  | 'request_auto_approved'
  | 'recommendation_approved'
  | 'recommendations_available'
  | 'playlist_generated'

export type WebhookPayload =
  | {
      event: 'batch_complete'
      batchId: number
      stats: { discovered: number; added: number; failed: number }
      message: string
      timestamp: string
    }
  | {
      event: 'digest'
      window: string
      stats: { discovered: number; added: number; runs: number }
      message: string
      timestamp: string
    }
  | {
      event: 'request_pending_approval'
      requestId: number
      requesterName: string
      subjectTitle: string
      imageUrl?: string
      message: string
      timestamp: string
    }
  | {
      event: 'request_auto_approved'
      requestId: number
      requesterName: string
      subjectTitle: string
      imageUrl?: string
      status: 'dispatched' | 'failed'
      message: string
      timestamp: string
    }
  | {
      event: 'recommendation_approved'
      recommendationId: number
      artistName: string
      subjectTitle?: string
      imageUrl?: string
      status: 'dispatched' | 'failed'
      message: string
      timestamp: string
    }
  | {
      event: 'recommendations_available'
      batchId: number
      count: number
      message: string
      timestamp: string
    }
  | {
      event: 'playlist_generated'
      playlistId: number
      playlistName: string
      message: string
      timestamp: string
    }

type ChannelBase = {
  id: string
  enabled: boolean
  events: NotificationEvent[]
  allowPrivateTarget?: boolean
}

export type WebhookChannel = ChannelBase & { type: 'webhook'; url: string }
export type NtfyChannel = ChannelBase & {
  type: 'ntfy'
  server: string
  topic: string
  priority?: 1 | 2 | 3 | 4 | 5
  token?: string
}
export type TelegramChannel = ChannelBase & { type: 'telegram'; botToken: string; chatId: string }
export type AppriseChannel = ChannelBase & { type: 'apprise'; endpoint: string; urls: string }
export type PushoverChannel = ChannelBase & {
  type: 'pushover'
  token: string
  userKey: string
  priority?: -2 | -1 | 0 | 1
}

export type NotificationChannel =
  | WebhookChannel
  | NtfyChannel
  | TelegramChannel
  | AppriseChannel
  | PushoverChannel
