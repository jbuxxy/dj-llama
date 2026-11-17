const CACHE_NAME = 'djllama-v2'
// Hashed build output (app-<hash>.js etc.) never changes in place, so it can
// be served straight from this cache with no network round-trip at all.
const ASSET_CACHE = 'djllama-assets-v1'
const ASSET_CACHE_MAX = 120
const SHELL_URLS = ['/', '/index.html']

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_URLS)))
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== CACHE_NAME && k !== ASSET_CACHE).map((k) => caches.delete(k)),
        ),
      ),
  )
  self.clients.claim()
})

async function trimAssetCache(cache) {
  const keys = await cache.keys()
  // Oldest first (insertion order); old deploys' bundles age out.
  for (const key of keys.slice(0, Math.max(0, keys.length - ASSET_CACHE_MAX))) {
    await cache.delete(key)
  }
}

async function cacheFirstAsset(request) {
  const cache = await caches.open(ASSET_CACHE)
  const hit = await cache.match(request)
  if (hit) return hit
  const response = await fetch(request)
  if (response.ok && response.type === 'basic') {
    await cache.put(request, response.clone())
    void trimAssetCache(cache)
  }
  return response
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  // Never cache API calls (including SSE streams)
  if (url.pathname.startsWith('/api/')) return

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirstAsset(request))
    return
  }

  // Everything else (the HTML shell): network-first so a deploy is picked up
  // immediately, falling back to the cached shell when offline.
  event.respondWith(fetch(request).catch(() => caches.match(request)))
})
