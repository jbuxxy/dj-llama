import { validatePublicServiceUrl } from '../../url-safety'
import { type PostResult, post } from '../transport'
import type { PushoverChannel, WebhookPayload } from '../types'

const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024
const FETCH_TIMEOUT_MS = 8_000

// The image URL comes from user-controlled request/recommendation data, so it
// gets the same public-URL + no-redirect treatment as the outbound SSRF guard
// in transport.ts before we ever fetch it server-side.
async function fetchImageAttachment(imageUrl: string): Promise<Blob | null> {
  const validation = await validatePublicServiceUrl(imageUrl, 'Image URL')
  if (!validation.ok) {
    console.warn(`Pushover attachment skipped: ${validation.message}`)
    return null
  }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(imageUrl, { signal: controller.signal, redirect: 'manual' })
    if (!res.ok || res.type === 'opaqueredirect') return null
    const contentType = res.headers.get('content-type') ?? ''
    if (!contentType.startsWith('image/')) return null
    const buf = await res.arrayBuffer()
    if (buf.byteLength > MAX_ATTACHMENT_BYTES) return null
    return new Blob([buf], { type: contentType })
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

async function sendWithAttachment(
  channel: PushoverChannel,
  payload: WebhookPayload,
  attachment: Blob,
): Promise<PostResult> {
  const form = new FormData()
  form.set('token', channel.token)
  form.set('user', channel.userKey)
  form.set('message', payload.message)
  if (channel.priority !== undefined) form.set('priority', String(channel.priority))
  form.set('attachment', attachment, 'image')

  try {
    const res = await fetch('https://api.pushover.net/1/messages.json', {
      method: 'POST',
      body: form,
    })
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` }
    return { ok: true, status: res.status }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'request failed' }
  }
}

function sendTextOnly(channel: PushoverChannel, payload: WebhookPayload): Promise<PostResult> {
  const body = new URLSearchParams({
    token: channel.token,
    user: channel.userKey,
    message: payload.message,
  })
  if (channel.priority !== undefined) body.set('priority', String(channel.priority))

  // Destination is always the fixed, public Pushover API host -- unlike the
  // other channel types, there's no user-supplied URL here, so the SSRF
  // private-target guard doesn't apply to this request.
  return post('https://api.pushover.net/1/messages.json', undefined, {
    rawBody: body.toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    redact: () => 'https://api.pushover.net/1/messages.json',
  })
}

export async function sendPushoverChannel(
  channel: PushoverChannel,
  payload: WebhookPayload,
): Promise<PostResult> {
  const imageUrl = 'imageUrl' in payload ? payload.imageUrl : undefined
  const attachment = imageUrl ? await fetchImageAttachment(imageUrl) : null
  if (attachment) return sendWithAttachment(channel, payload, attachment)
  return sendTextOnly(channel, payload)
}
