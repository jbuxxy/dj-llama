import { type PostResult, post } from '../transport'
import type { AppriseChannel, WebhookPayload } from '../types'

export function sendAppriseChannel(
  channel: AppriseChannel,
  payload: WebhookPayload,
): Promise<PostResult> {
  const urls = channel.urls
    .split(/[\n,]/)
    .map((u) => u.trim())
    .filter(Boolean)
    .join(',')
  const imageUrl = 'imageUrl' in payload ? payload.imageUrl : undefined
  return post(
    channel.endpoint,
    {
      title: 'DJ Llama notification',
      body: payload.message,
      urls,
      type: 'info',
      // Apprise API resolves a remote URL itself; harmless no-op on servers
      // that don't support it.
      ...(imageUrl ? { attachment: imageUrl } : {}),
    },
    { allowPrivate: channel.allowPrivateTarget },
  )
}
