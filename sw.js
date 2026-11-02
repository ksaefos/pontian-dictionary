/* Pontian Dictionary v5.1 — offline navigation, live update aware. */
const CACHE = 'pontian-dictionary-shell-v5.1.1';
const ROOT = self.registration.scope;
const SHELL = [ROOT, ROOT+'index.html',ROOT+'cloud-sync.js',ROOT+'manifest.webmanifest',ROOT+'icons/icon-192.png',ROOT+'icons/icon-512.png'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(Promise.all([caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('pontian-dictionary-shell-')&&key!==CACHE).map(key=>caches.delete(key)))),self.clients.claim()]));
});
self.addEventListener('fetch', event => {
  const req=event.request;
  if(req.method!=='GET')return;
  const url=new URL(req.url);
  // IMPORTANT: never intercept or cache Cloudflare Worker requests, credentials, or external origins.
  if(url.origin!==self.location.origin || !url.pathname.startsWith(new URL(ROOT).pathname))return;
  if(req.mode==='navigate') {
    event.respondWith(fetch(req).then(resp=>{
      if(resp.ok){const clone=resp.clone();event.waitUntil(caches.open(CACHE).then(c=>c.put(ROOT+'index.html',clone)));}
      return resp;
    }).catch(async()=> (await caches.match(ROOT+'index.html')) || Response.error()));
    return;
  }
  // Keep public edits.json network-first, cache only successful non-sensitive public response.
  if(url.pathname.endsWith('/data/edits.json')) {
    event.respondWith(fetch(req,{cache:'no-store'}).then(resp=>{
      if(resp.ok){const clone=resp.clone();event.waitUntil(caches.open(CACHE).then(c=>c.put(req,clone)));}
      return resp;
    }).catch(async()=>await caches.match(req)||Response.error()));
    return;
  }
  if(!SHELL.some(item=>new URL(item).pathname===url.pathname))return;
  event.respondWith(fetch(req).then(resp=>{
    if(resp.ok){const clone=resp.clone();event.waitUntil(caches.open(CACHE).then(c=>c.put(req,clone)));}
    return resp;
  }).catch(async()=>await caches.match(req)||Response.error()));
});
