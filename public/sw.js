const CACHE_PREFIX = 'chesspilot-shell-'
const CACHE_NAME = `${CACHE_PREFIX}v1`
const scopeUrl = self.registration.scope
const appUrl = new URL('./', scopeUrl).href
const coreAssets = [
  appUrl,
  new URL('manifest.webmanifest', scopeUrl).href,
  new URL('chesspilot-mark.svg', scopeUrl).href,
  new URL('engine/stockfish-19-lite-single.js', scopeUrl).href,
  new URL('engine/stockfish-19-lite-single.wasm', scopeUrl).href,
  new URL('models/chess-tiles-v2.onnx', scopeUrl).href,
]

async function cacheBuildAssets() {
  const cache = await caches.open(CACHE_NAME)
  const shell = await cache.match(appUrl)
  if (!shell) return
  const html = await shell.text()
  const entrypoints = [...html.matchAll(/(?:src|href)=["']([^"']+\/assets\/[^"']+)["']/g)]
    .map((match) => new URL(match[1], appUrl))
    .filter((url) => url.origin === self.location.origin && url.href.startsWith(scopeUrl))

  for (const url of entrypoints) {
    try {
      const response = await fetch(url)
      if (!response.ok || response.type !== 'basic') continue
      await cache.put(url, response.clone())
      if (url.pathname.endsWith('.js')) {
        const js = await response.text()
        const runtimeAssets = [...js.matchAll(/["']([^"'\s]*\/assets\/[^"']+\.(?:mjs|wasm))["']/g)]
          .map((match) => new URL(match[1], appUrl))
          .filter((asset) => asset.origin === self.location.origin && asset.href.startsWith(scopeUrl) && !(asset.pathname.includes('ort-wasm') && asset.pathname.endsWith('.wasm')))
        await Promise.all(runtimeAssets.map(async (asset) => {
          try {
            const runtimeResponse = await fetch(asset)
            if (runtimeResponse.ok && runtimeResponse.type === 'basic') await cache.put(asset, runtimeResponse)
          } catch { /* Runtime assets can be cached later when first used. */ }
        }))
      }
    } catch { /* The shell remains useful if an optional bundle is temporarily unreachable. */ }
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(coreAssets)).then(cacheBuildAssets))
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== self.location.origin || !url.pathname.startsWith(new URL(scopeUrl).pathname)) return

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) void caches.open(CACHE_NAME).then((cache) => cache.put(appUrl, response.clone()))
          return response
        })
        .catch(async () => (await caches.match(appUrl)) || Response.error()),
    )
    return
  }

  const path = url.pathname
  const isAppAsset = /\/(assets|engine|models)\//.test(path) || /\.(?:webmanifest|svg)$/.test(path)
  if (!isAppAsset) return

  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then(async (cached) => {
      if (cached) return cached
      const response = await fetch(request)
      if (response.ok && response.type === 'basic') {
        const cache = await caches.open(CACHE_NAME)
        await cache.put(request, response.clone())
      }
      return response
    }),
  )
})
