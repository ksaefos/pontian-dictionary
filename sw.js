/* Versioned app shell and last successfully fetched public overlay. */
const CACHE = 'pontian-dictionary-shell-v5.2.1';
const ROOT = self.registration.scope;
const EDITS = ROOT + 'data/edits.json';
const PUBLIC = ROOT + 'index.html';
const ADMIN = ROOT + 'admin/index.html';
const SHELL = [
  PUBLIC, ADMIN, ROOT + 'cloud-sync.js?v=5.2.1', ROOT + 'admin/proofreading.js?v=2',
  ROOT + 'manifest.webmanifest?v=2', ROOT + 'icons/icon-192.png?v=2',
  ROOT + 'icons/icon-512.png?v=2'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL.map(url => new Request(url, {cache: 'reload'})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('pontian-dictionary-shell-') && key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin ||
      !url.pathname.startsWith(new URL(ROOT).pathname)) return;

  // Versioned assets use the same snapshot as their offline HTML.
  if (url.href === ROOT + 'cloud-sync.js?v=5.2.1') {
    event.respondWith(caches.open(CACHE).then(async cache => (await cache.match(url.href)) || fetch(request)));
    return;
  }

  const root = new URL(ROOT).pathname;
  const navigation = request.mode === 'navigate' && {
    [root]: PUBLIC, [root + 'index.html']: PUBLIC,
    [root + 'admin']: ADMIN, [root + 'admin/']: ADMIN, [root + 'admin/index.html']: ADMIN
  }[url.pathname];
  const edits = url.pathname === new URL(EDITS).pathname;
  const fallback = navigation || (edits ? EDITS : SHELL.includes(url.href) ? url.href : null);
  if (!fallback) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    async function cached() {
      if (navigation && url.pathname === root + 'admin' && await cache.match(ADMIN)) {
        return Response.redirect(ROOT + 'admin/', 302);
      }
      return cache.match(fallback);
    }
    try {
      const response = await fetch(request);
      if (response.ok && edits) {
        try { await cache.put(EDITS, response.clone()); } catch { /* Return the network result. */ }
      }
      if (response.status < 500) return response;
      return (await cached()) || response;
    } catch {
      return (await cached()) || Response.error();
    }
  })());
});
