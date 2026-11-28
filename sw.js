// Uygulama dosyalarını telefona saklar; internet yokken de açılır.
const SURUM = 'fatura-defteri-v9';
const DOSYALAR = ['./', 'index.html', 'app.js', 'vendor/jspdf.umd.min.js', 'manifest.webmanifest', 'icon-180.png', 'icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SURUM).then(c => c.addAll(DOSYALAR)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(k => Promise.all(k.filter(a => a !== SURUM).map(a => caches.delete(a)))).then(() => self.clients.claim()));
});
// Önce internetten yenisini dener, olmazsa saklananı açar.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    fetch(e.request).then(r => {
      const kopya = r.clone();
      caches.open(SURUM).then(c => c.put(e.request, kopya));
      return r;
    }).catch(() => caches.match(e.request, {ignoreSearch: true}))
  );
});
