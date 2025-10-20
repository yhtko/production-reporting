const CACHE = 'pr-cache-v3';
const ASSETS = ['/', '/index.html', '/app.js', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' })));
    })()
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)));
      await self.clients.claim();
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      await Promise.all(
        clients.map((client) => {
          if ('navigate' in client) {
            return client.navigate(client.url).catch(() => undefined);
          }
          if (client.postMessage) {
            client.postMessage({ type: 'SW_RELOAD' });
          }
          return undefined;
        })
      );
    })()
  );
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  // GET 以外 / http(s) 以外 / 自分のオリジン以外 は触らない
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate' || request.headers.get('accept')?.includes('text/html')) {
    e.respondWith(
      (async () => {
        try {
          const networkResponse = await fetch(request);
          const cache = await caches.open(CACHE);
          cache.put(request, networkResponse.clone());
          return networkResponse;
        } catch (error) {
          const cached = await caches.match(request);
          if (cached) return cached;
          return caches.match('/index.html');
        }
      })()
    );
    return;
  }

  e.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((res) => {
          // 成功レスだけキャッシュ（basic = 同一オリジン）
          if (res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(request, copy));
          }
          return res;
        })
        .catch(() => caches.match('/index.html'));
    })
  );
});
