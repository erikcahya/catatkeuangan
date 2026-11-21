// Service worker: simpan kerangka aplikasi agar bisa dibuka cepat dan dipasang dari ponsel.
// Permintaan /api/* selalu ke jaringan (data keuangan tidak disimpan di cache).
// Naikkan VERSION setiap kali berkas di public/ berubah.
const VERSION = 'v44';
const CACHE = `shell-${VERSION}`;
const SHELL = ['/', '/index.html', '/styles.css', '/app.js', '/format.js', '/icons.js', '/picker.js', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  // Jaringan dulu, cache bila offline.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('/index.html'))),
  );
});
