#!/usr/bin/env bun

/**
 * Capture documentation screenshots from a running DJ Llama instance.
 *
 * Usage:
 *   DJLLAMA_URL=https://example.com \
 *   DJLLAMA_SESSION=<djllama_session cookie value> \
 *   bun scripts/capture-screenshots.ts
 *
 * Login is Plex-only, so the script borrows an existing browser session:
 * copy the `djllama_session` cookie from a signed-in admin browser.
 *
 * Optional:
 *   OUT_DIR=docs/screenshots      # default
 *   VIEWPORT_WIDTH=1280            # default
 *   VIEWPORT_HEIGHT=800            # default
 *   DEVICE_SCALE=2                 # default (retina-crisp PNGs)
 *   ONLY=library-sources,settings  # restrict to specific files
 *
 * The script loads the session, applies the light/dark theme, sanitizes the DOM to remove
 * the logged-in username, email addresses, and the instance hostname from any
 * visible text, masks URL / token / password / labelled-credential input
 * values, and saves PNGs to OUT_DIR.
 *
 * The script keeps credentials out of the repo - everything comes from env.
 */

import { mkdir } from 'node:fs/promises'
import { chromium, type Page } from '@playwright/test'

const BASE_URL = process.env.DJLLAMA_URL
const SESSION = process.env.DJLLAMA_SESSION
const OUT_DIR = process.env.OUT_DIR ?? 'docs/screenshots'
const VIEWPORT_WIDTH = Number(process.env.VIEWPORT_WIDTH ?? '1280')
const VIEWPORT_HEIGHT = Number(process.env.VIEWPORT_HEIGHT ?? '800')
const DEVICE_SCALE = Number(process.env.DEVICE_SCALE ?? '2')
const ONLY = process.env.ONLY?.split(',').map((s) => s.trim()) ?? null

if (!BASE_URL || !SESSION) {
  console.error('Missing env: DJLLAMA_URL, DJLLAMA_SESSION')
  process.exit(1)
}

type PageSpec = {
  file: string
  /** Navigate to this path. If `onPage` is set, navigation is skipped. */
  path?: string
  theme: 'dark' | 'light'
  /** Phone-sized viewport instead of the desktop one. */
  mobile?: boolean
  /** Optional hook to run after navigation and before screenshot. */
  onPage?: (page: Page) => Promise<void>
}

// Expands the accordion section whose header contains `title`.
const expand =
  (title: string): PageSpec['onPage'] =>
  async (page) => {
    await page.getByText(title, { exact: true }).first().click()
    await waitForContent()
  }

// Types a query into the first search box and waits for results.
const search =
  (query: string): PageSpec['onPage'] =>
  async (page) => {
    await page.locator('input[type="search"], input[placeholder*="Search"]').first().fill(query)
    // Results come from MusicBrainz; wait until the loading skeletons are gone.
    await page
      .waitForFunction(() => !document.querySelector('.animate-pulse'), { timeout: 20000 })
      .catch(() => {})
    await waitForContent()
  }

const specs: PageSpec[] = [
  { path: '/', file: 'dashboard-dark.png', theme: 'dark' },
  { path: '/', file: 'dashboard-light.png', theme: 'light' },
  { path: '/discover', file: 'discover.png', theme: 'dark' },
  { path: '/requests', file: 'requests.png', theme: 'dark' },
  { path: '/requests', file: 'search.png', theme: 'dark', onPage: search('Radiohead') },
  {
    path: '/playlists',
    file: 'curated-playlists.png',
    theme: 'dark',
    onPage: expand('Curated Playlists'),
  },
  { path: '/settings?tab=analytics', file: 'analytics.png', theme: 'dark' },
  { path: '/settings?tab=library-health', file: 'library-health.png', theme: 'dark' },
  { path: '/settings?tab=discovery', file: 'settings-discovery.png', theme: 'dark' },
  { path: '/settings?tab=schedule', file: 'settings-schedule.png', theme: 'dark' },
  { path: '/settings?tab=system-health', file: 'system-health.png', theme: 'dark' },
  { path: '/', file: 'mobile-dashboard.png', theme: 'dark', mobile: true },
  { path: '/discover', file: 'mobile-discover.png', theme: 'dark', mobile: true },
  { path: '/playlists', file: 'mobile-playlists.png', theme: 'dark', mobile: true },
]

await mkdir(OUT_DIR, { recursive: true })

const hostPatterns: string[] = []
try {
  const u = new URL(BASE_URL)
  hostPatterns.push(u.host, u.hostname)
  const apex = u.hostname.split('.').slice(-2).join('.')
  if (apex && apex !== u.hostname) hostPatterns.push(apex)
} catch {}

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({
  viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
  deviceScaleFactor: DEVICE_SCALE,
  ignoreHTTPSErrors: true,
})
await ctx.addCookies([{ name: 'djllama_session', value: SESSION, url: BASE_URL }])
const page = await ctx.newPage()

// The username to scrub from visible text, read from the borrowed session.
const me = await page.request.get(`${BASE_URL}/api/v1/auth/me`)
if (!me.ok()) {
  console.error(`Session rejected (${me.status()}); copy a fresh djllama_session cookie`)
  process.exit(1)
}
const USERNAME = ((await me.json()) as { username: string }).username

async function setTheme(theme: 'dark' | 'light') {
  await page.evaluate((t) => {
    document.documentElement.setAttribute('data-theme', `djllama-${t}`)
    try {
      localStorage.setItem('djllama-theme', t)
    } catch {}
  }, theme)
}

async function sanitize() {
  await page.evaluate(
    ([u, pats]) => {
      const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const uRe = u ? new RegExp(`\\b${escapeRe(u)}\\b`, 'g') : null
      // Email addresses anywhere in visible text or attributes.
      const emailRe = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
      const patRes = (pats as string[])
        .filter(Boolean)
        .map((p) => ({ re: new RegExp(escapeRe(p), 'g'), replacement: 'example.com' }))
      const scrubText = (input: string) => {
        let val = input.replace(emailRe, 'user@example.com')
        if (uRe) val = val.replace(uRe, 'user')
        for (const { re, replacement } of patRes) val = val.replace(re, replacement)
        return val
      }
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      const toReplace: [Text, string][] = []
      while (walker.nextNode()) {
        const node = walker.currentNode as Text
        if (!node.nodeValue) continue
        const val = scrubText(node.nodeValue)
        if (val !== node.nodeValue) toReplace.push([node, val])
      }
      for (const [node, val] of toReplace) node.nodeValue = val
      // Resolve the effective label for an input so credential/account fields can be
      // masked even when their value isn't obviously a URL/token (e.g. a service username).
      const labelText = (input: HTMLInputElement) => {
        const parts = [
          input.getAttribute('aria-label') || '',
          input.placeholder || '',
          input.name,
          input.id,
        ]
        if (input.id) {
          try {
            const l = document.querySelector(`label[for="${CSS.escape(input.id)}"]`)
            if (l) parts.push(l.textContent || '')
          } catch {}
        }
        const wrap = input.closest('div')
        if (wrap) {
          const l = wrap.querySelector('label')
          if (l) parts.push(l.textContent || '')
        }
        return parts.join(' ').toLowerCase()
      }
      const sensitiveLabel = /user|account|e-?mail|client|token|secret|\bapi\b|\bkey\b|password/i
      // Mask form input values: URLs, tokens, emails, password fields, and labelled credentials.
      for (const input of document.querySelectorAll('input')) {
        const el = input as HTMLInputElement
        const v = el.value || ''
        const isPw = el.type === 'password'
        if (!v && !isPw) continue
        const isUrl = el.type === 'url' || /^https?:\/\//i.test(v) || /\.local|\.lan/i.test(v)
        const isToken = /^[A-Za-z0-9_-]{20,}$/.test(v)
        emailRe.lastIndex = 0
        const isEmail = emailRe.test(v)
        if (isUrl) {
          el.value = ''
          el.setAttribute('placeholder', 'https://example.com')
        } else if (isPw || isToken || isEmail) {
          el.value = ''
          el.setAttribute('placeholder', isEmail ? 'user@example.com' : 'REDACTED')
        } else if (sensitiveLabel.test(labelText(el))) {
          el.value = ''
          el.setAttribute('placeholder', 'redacted')
        }
      }
      // Scrub username/email out of attributes that leak into tooltips.
      for (const el of document.querySelectorAll('[title], [aria-label]')) {
        for (const attr of ['title', 'aria-label']) {
          const t = el.getAttribute(attr)
          if (t) {
            const scrubbed = scrubText(t)
            if (scrubbed !== t) el.setAttribute(attr, scrubbed)
          }
        }
      }
    },
    [USERNAME, hostPatterns] as const,
  )
}

async function waitForContent() {
  await page.waitForLoadState('domcontentloaded')
  await page.waitForLoadState('load')
  await page.waitForTimeout(1500)
  // Trigger lazy-loaded images by scrolling through the page
  await page.evaluate(async () => {
    const totalHeight = document.documentElement.scrollHeight
    const step = Math.max(200, window.innerHeight / 2)
    for (let y = 0; y <= totalHeight; y += step) {
      window.scrollTo(0, y)
      await new Promise((r) => setTimeout(r, 120))
    }
    window.scrollTo(0, 0)
  })
  // Wait for images to finish loading (with a hard ceiling)
  await page
    .waitForFunction(
      () => {
        const imgs = Array.from(document.querySelectorAll('img'))
        return imgs.every((img) => img.complete && (img.naturalWidth > 0 || img.src === ''))
      },
      { timeout: 10000 },
    )
    .catch(() => {})
  await page.waitForTimeout(500)
}

for (const spec of specs) {
  if (ONLY && !ONLY.includes(spec.file.replace(/\.png$/, ''))) continue
  console.log(`Capturing ${spec.file}...`)
  await page.setViewportSize(
    spec.mobile ? { width: 390, height: 844 } : { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
  )
  await setTheme(spec.theme)
  if (spec.path) {
    try {
      await page.goto(`${BASE_URL}${spec.path}`, { waitUntil: 'domcontentloaded', timeout: 30000 })
    } catch (e) {
      console.warn(`  nav warning: ${(e as Error).message}`)
    }
    await waitForContent()
  }
  await setTheme(spec.theme)
  if (spec.onPage) await spec.onPage(page)
  await page.waitForTimeout(300)
  await sanitize()
  await page.waitForTimeout(200)
  await page.screenshot({ path: `${OUT_DIR}/${spec.file}`, fullPage: false })
}

await browser.close()
console.log('Done')
