// IRONLOG service worker — app-shell caching for offline + faster loads.
// Strategy:
//   * /auth, /workouts, /api  -> always network (never cache auth or data)
//   * navigations (HTML)       -> network-first, fall back to cached shell offline
//   * other GET (hashed assets, icons) -> cache-first (filenames are immutable)
const CACHE = "ironlog-v4";
const SHELL = ["/", "/index.html", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  // never cache same-origin API / auth traffic
  if (url.origin === self.location.origin &&
      (url.pathname.startsWith("/auth") || url.pathname.startsWith("/workouts") ||
       url.pathname.startsWith("/program") || url.pathname.startsWith("/profile") ||
       url.pathname.startsWith("/meals") || url.pathname.startsWith("/foods") ||
       url.pathname.startsWith("/weights") || url.pathname.startsWith("/exercises") ||
       url.pathname.startsWith("/api"))) {
    return; // let it hit the network normally
  }

  // navigations: network-first so updates land immediately when online
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put("/index.html", copy));
          return res;
        })
        .catch(() => caches.match("/index.html").then((r) => r || caches.match("/")))
    );
    return;
  }

  // static assets: cache-first, then fill the cache
  event.respondWith(
    caches.match(request).then((cached) =>
      cached ||
      fetch(request).then((res) => {
        if (res.ok && url.origin === self.location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy));
        }
        return res;
      })
    )
  );
});
