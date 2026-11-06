// Offline support: keeps the page, its icons, fonts and the Firebase code on the device.
// Bump VERSION whenever you upload a new index.html so phones pick up the change.
const VERSION = "europe2029-v4";
const SHELL = ["./", "index.html", "config.js", "manifest.webmanifest", "icon.svg", "icon-192.png", "icon-512.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Never cache Firebase's live data or sign-in traffic: Firestore keeps its own offline copy.
  if (/googleapis\.com$|firebaseapp\.com$|identitytoolkit|securetoken/.test(url.hostname) && !url.hostname.startsWith("fonts.")) return;
  const isOwn = url.origin === location.origin;
  const isLib = url.hostname === "www.gstatic.com" || url.hostname === "fonts.gstatic.com" || url.hostname === "fonts.googleapis.com";
  if (!isOwn && !isLib) return;
  if (isOwn) {
    // Network first for the app itself (so edits you upload show up), cache when offline.
    e.respondWith(fetch(req).then(res => { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); return res; })
      .catch(() => caches.match(req).then(r => r || caches.match("index.html"))));
  } else {
    // Cache first for pinned libraries and fonts.
    e.respondWith(caches.match(req).then(r => r || fetch(req).then(res => { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); return res; })));
  }
});
