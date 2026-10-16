import { type PostResult, post } from '../transport'
import type { NtfyChannel, WebhookPayload } from '../types'

export function sendNtfyChannel(
  channel: NtfyChannel,
  payload: WebhookPayload,
): Promise<PostResult> {
  const url = `${channel.server.replace(/\/+$/, '')}/${channel.topic}`
  const headers: Record<string, string> = {
    'Content-Type': 'text/plain',
    Title: 'DJ Llama notification',
  }
  if (channel.priority) headers.Priority = String(channel.priority)
  if (channel.token) headers.Authorization = `Bearer ${channel.token}`
  // ntfy fetches the attachment itself given a URL -- no need to download/re-upload here.
  if ('imageUrl' in payload && payload.imageUrl) headers.Attach = payload.imageUrl
  return post(url, undefined, {
    allowPrivate: channel.allowPrivateTarget,
    headers,
    rawBody: payload.message,
  })
}
