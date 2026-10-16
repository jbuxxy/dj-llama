import { sendAppriseChannel } from './channels/apprise'
import { sendNtfyChannel } from './channels/ntfy'
import { sendPushoverChannel } from './channels/pushover'
import { sendTelegramChannel } from './channels/telegram'
import { sendWebhookChannel } from './channels/webhook'
import type { PostResult } from './transport'
import type { NotificationChannel, NotificationEvent, WebhookPayload } from './types'

type Sender<C extends NotificationChannel> = (c: C, p: WebhookPayload) => Promise<PostResult>

export type SenderMap = {
  webhook: Sender<Extract<NotificationChannel, { type: 'webhook' }>>
  ntfy: Sender<Extract<NotificationChannel, { type: 'ntfy' }>>
  telegram: Sender<Extract<NotificationChannel, { type: 'telegram' }>>
  apprise: Sender<Extract<NotificationChannel, { type: 'apprise' }>>
  pushover: Sender<Extract<NotificationChannel, { type: 'pushover' }>>
}

export type DispatchResult = { id: string; type: string; ok: boolean; error?: string }

const defaultSenders: SenderMap = {
  webhook: sendWebhookChannel,
  ntfy: sendNtfyChannel,
  telegram: sendTelegramChannel,
  apprise: sendAppriseChannel,
  pushover: sendPushoverChannel,
}

function send(
  senders: SenderMap,
  channel: NotificationChannel,
  payload: WebhookPayload,
): Promise<PostResult> {
  switch (channel.type) {
    case 'webhook':
      return senders.webhook(channel, payload)
    case 'ntfy':
      return senders.ntfy(channel, payload)
    case 'telegram':
      return senders.telegram(channel, payload)
    case 'apprise':
      return senders.apprise(channel, payload)
    case 'pushover':
      return senders.pushover(channel, payload)
  }
}

export async function dispatch(
  channels: NotificationChannel[] | undefined,
  event: NotificationEvent,
  payload: WebhookPayload,
  opts: { senders?: Partial<SenderMap> } = {},
): Promise<DispatchResult[]> {
  const senders: SenderMap = { ...defaultSenders, ...opts.senders }
  const targets = (channels ?? []).filter((c) => c.enabled && c.events.includes(event))

  const settled = await Promise.allSettled(targets.map((c) => send(senders, c, payload)))

  return targets.map((channel, i) => {
    const res = settled[i]
    const base = { id: channel.id, type: channel.type }
    if (res?.status === 'fulfilled') {
      return { ...base, ok: res.value.ok, error: res.value.error }
    }
    return {
      ...base,
      ok: false,
      error: res?.status === 'rejected' ? String(res.reason) : 'no result',
    }
  })
}

// dispatch() never rejects -- per-channel failures (bad token, rate limit,
// network error) come back as ok:false entries in the resolved array, not
// thrown errors. Several call sites only did `dispatch(...).catch(...)` on
// the fire-and-forget promise, which only ever catches a fully unexpected
// throw; a real per-channel delivery failure was resolved successfully and
// silently discarded, with nothing logged and nothing surfaced to the admin.
export function logDispatchFailures(results: DispatchResult[]): void {
  const failed = results.filter((r) => !r.ok)
  if (failed.length > 0) {
    console.error(
      `Notification dispatch failed for ${failed.length}/${results.length} channel(s):`,
      failed,
    )
  }
}
