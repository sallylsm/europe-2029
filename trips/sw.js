// Offline support for Trips: keeps the app, its fonts, the map library and Firebase code on the device.
// Bump VERSION when you upload new files so phones pick up the change.
const VERSION = "trips-v1";
const SHELL = ["./", "index.html", "app.js", "style.css", "manifest.webmanifest", "icon.svg", "icon-192.png", "icon-512.png", "../config.js"];
self.addEventListener("install", e => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith("trips-") && k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request; if (req.method !== "GET") return;
  const url = new URL(req.url);
  const own = url.origin === location.origin;
  const lib = ["www.gstatic.com", "fonts.gstatic.com", "fonts.googleapis.com", "cdnjs.cloudflare.com"].includes(url.hostname);
  if (!own && !lib) return;   // live data, search, photos and map tiles go straight to the network
  if (own) {
    e.respondWith(fetch(req).then(res => { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); return res; })
      .catch(() => caches.match(req).then(r => r || caches.match("index.html"))));
  } else {
    e.respondWith(caches.match(req).then(r => r || fetch(req).then(res => { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); return res; })));
  }
});
