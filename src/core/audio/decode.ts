// Decodes a short excerpt of a Plex track to mono float PCM with ffmpeg.
//
// ffmpeg never sees the Plex token: it reads from a one-shot URL on a
// loopback-only proxy inside this process, and the proxy adds the token when
// it forwards to Plex. Range requests pass through, so `-ss` seeks without
// downloading the start of the file -- only the excerpt (plus container
// headers) crosses the network.

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { SAMPLE_RATE } from './features'

export type PlexAudioSource = { plexUrl: string; token: string; partKey: string }

const EXCERPT_SECONDS = 45
const DECODE_TIMEOUT_MS = 60_000
const TICKET_TTL_MS = 2 * 60_000

type Ticket = { url: string; token: string; expires: number }
const tickets = new Map<string, Ticket>()
let server: Promise<number> | null = null

/** Starts the loopback proxy once; resolves to its port. */
function proxyPort(): Promise<number> {
  if (server) return server
  server = new Promise<number>((resolve, reject) => {
    const srv = createServer(async (req, res) => {
      const id = (req.url ?? '/').slice(1)
      const ticket = tickets.get(id)
      if (!ticket || ticket.expires < Date.now()) {
        res.writeHead(410).end()
        return
      }
      try {
        const headers: Record<string, string> = { 'X-Plex-Token': ticket.token }
        if (typeof req.headers.range === 'string') headers.Range = req.headers.range
        const upstream = await fetch(ticket.url, { method: req.method, headers })
        const out: Record<string, string> = {}
        for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
          const v = upstream.headers.get(h)
          if (v) out[h] = v
        }
        res.writeHead(upstream.status, out)
        if (!upstream.body || req.method === 'HEAD') {
          res.end()
          return
        }
        const reader = upstream.body.getReader()
        res.on('close', () => void reader.cancel().catch(() => {}))
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (!res.write(value)) await new Promise((r) => res.once('drain', r))
        }
        res.end()
      } catch {
        if (!res.headersSent) res.writeHead(502)
        res.end()
      }
    })
    srv.on('error', (err) => {
      server = null
      reject(err)
    })
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (addr && typeof addr === 'object') resolve(addr.port)
      else reject(new Error('audio proxy has no port'))
    })
    // Never keeps the process alive on its own.
    srv.unref()
  })
  return server
}

/** The ffmpeg argument list for one excerpt -- exported so tests can prove no secret is in it. */
export function ffmpegArgs(inputUrl: string, startSeconds: number): string[] {
  return [
    'ffmpeg',
    '-hide_banner',
    '-loglevel',
    'error',
    '-ss',
    String(Math.max(0, Math.floor(startSeconds))),
    '-t',
    String(EXCERPT_SECONDS),
    '-i',
    inputUrl,
    '-vn',
    '-ac',
    '1',
    '-ar',
    String(SAMPLE_RATE),
    '-f',
    'f32le',
    'pipe:1',
  ]
}

/** Excerpt start: 30% in (past intros), or 30s when the length is unknown. */
export function excerptStart(durationMs?: number | null): number {
  if (!durationMs || durationMs <= 0) return 30
  const secs = durationMs / 1000
  return Math.max(0, Math.min(secs * 0.3, secs - EXCERPT_SECONDS - 1))
}

export async function decodeExcerpt(
  source: PlexAudioSource,
  durationMs?: number | null,
): Promise<Float32Array> {
  const port = await proxyPort()
  const id = randomBytes(16).toString('hex')
  tickets.set(id, {
    url: `${source.plexUrl.replace(/\/+$/, '')}${source.partKey}`,
    token: source.token,
    expires: Date.now() + TICKET_TTL_MS,
  })
  try {
    const [cmd, ...args] = ffmpegArgs(`http://127.0.0.1:${port}/${id}`, excerptStart(durationMs))
    const pcm = await new Promise<Buffer>((resolve, reject) => {
      const proc = spawn(cmd as string, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      const chunks: Buffer[] = []
      let err = ''
      const timer = setTimeout(() => proc.kill('SIGKILL'), DECODE_TIMEOUT_MS)
      proc.stdout.on('data', (c: Buffer) => chunks.push(c))
      proc.stderr.on('data', (c: Buffer) => {
        if (err.length < 2000) err += c.toString()
      })
      proc.on('error', (e) => {
        clearTimeout(timer)
        reject(e)
      })
      proc.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0) resolve(Buffer.concat(chunks))
        else reject(new Error(`ffmpeg exited ${code}: ${err.trim().slice(0, 200)}`))
      })
    })
    // Copy into an aligned buffer: Buffer.concat can return an offset view.
    const aligned = new Float32Array(Math.floor(pcm.byteLength / 4))
    new Uint8Array(aligned.buffer).set(pcm.subarray(0, aligned.length * 4))
    return aligned
  } finally {
    tickets.delete(id)
    for (const [k, t] of tickets) if (t.expires < Date.now()) tickets.delete(k)
  }
}
