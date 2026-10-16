import { type PostResult, post } from '../transport'
import type { TelegramChannel, WebhookPayload } from '../types'

export function sendTelegramChannel(
  channel: TelegramChannel,
  payload: WebhookPayload,
): Promise<PostResult> {
  // The bot token lives in the URL path; the default log redactor only masks
  // query strings, so mask the /bot<token>/ segment to keep it out of logs.
  const redact = (u: string) => u.replace(/\/bot[^/]+\//, '/bot[REDACTED]/')
  const imageUrl = 'imageUrl' in payload ? payload.imageUrl : undefined

  // Telegram accepts a remote image URL directly in sendPhoto -- it fetches
  // it server-side, no need to download/re-upload here.
  if (imageUrl) {
    const url = `https://api.telegram.org/bot${channel.botToken}/sendPhoto`
    return post(
      url,
      { chat_id: channel.chatId, photo: imageUrl, caption: payload.message },
      { allowPrivate: channel.allowPrivateTarget, redact },
    )
  }

  const url = `https://api.telegram.org/bot${channel.botToken}/sendMessage`
  return post(
    url,
    { chat_id: channel.chatId, text: payload.message },
    { allowPrivate: channel.allowPrivateTarget, redact },
  )
}
