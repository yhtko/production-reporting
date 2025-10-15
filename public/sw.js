self.addEventListener('install', (e)=>{
  e.waitUntil(caches.open('static-v1').then((c)=>c.addAll([
    '/', '/index.html', '/src/app.js', '/src/db.js', '/src/ui.css'
  ])));
});


self.addEventListener('fetch', (e)=>{
  const url = new URL(e.request.url);
  // APIはネット優先、静的はキャッシュ優先
  if (url.pathname.startsWith('/api/')) return;
  e.respondWith(
    caches.match(e.request).then((r)=> r || fetch(e.request))
  );
});