/* Service worker del simulador. Estrategia mixta:
   - navegaciones: red primero, caché como red de seguridad, offline.html como último recurso
   - estáticos propios: caché primero
   - imágenes de cartas: caché primero con revalidación en segundo plano y tope de entradas
   Nunca toca peticiones que no sean GET (las server actions de Next son POST). */

const VERSION = "v3";
const SHELL_CACHE = `shell-${VERSION}`;
const STATIC_CACHE = `static-${VERSION}`;
const IMAGE_CACHE = `cards-${VERSION}`;
const PAGES_CACHE = `pages-${VERSION}`;

const SHELL_ASSETS = [
  "/offline.html",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon.png",
];

const IMAGE_HOSTS = ["images.pokemontcg.io", "tcg.pokemon.com"];
const MAX_IMAGE_ENTRIES = 700;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => !k.endsWith(VERSION))
          .map((k) => caches.delete(k)),
      );
      if (self.registration.navigationPreload) {
        await self.registration.navigationPreload.enable();
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

/** Recorta una caché para que no crezca sin límite. */
async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length <= maxEntries) return;
  await Promise.all(
    keys.slice(0, keys.length - maxEntries).map((k) => cache.delete(k)),
  );
}

async function cacheFirst(request, cacheName, { trim } = {}) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) {
    // Revalida en segundo plano sin bloquear la respuesta.
    fetch(request)
      .then((res) => {
        if (res && res.ok) cache.put(request, res.clone());
      })
      .catch(() => {});
    return hit;
  }
  const res = await fetch(request);
  if (res && res.ok) {
    await cache.put(request, res.clone());
    if (trim) trimCache(cacheName, trim);
  }
  return res;
}

async function networkFirstPage(event) {
  const cache = await caches.open(PAGES_CACHE);
  try {
    const preload = await event.preloadResponse;
    const res = preload || (await fetch(event.request));
    if (res && res.ok) cache.put(event.request, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(event.request);
    if (hit) return hit;
    const shell = await caches.open(SHELL_CACHE);
    const offline = await shell.match("/offline.html");
    if (offline) return offline;
    throw err;
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return;

  // Imágenes de cartas: viven mucho tiempo y son el grueso del peso.
  if (IMAGE_HOSTS.includes(url.hostname)) {
    event.respondWith(
      cacheFirst(request, IMAGE_CACHE, { trim: MAX_IMAGE_ENTRIES }).catch(
        () => fetch(request),
      ),
    );
    return;
  }

  if (url.origin !== self.location.origin) return;

  // Nunca cachear autenticación ni datos dinámicos.
  if (url.pathname.startsWith("/api") || url.pathname.includes("clerk")) return;
  if (request.headers.get("RSC") || url.searchParams.has("_rsc")) return;

  if (request.mode === "navigate") {
    event.respondWith(networkFirstPage(event));
    return;
  }

  const isStatic =
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/icons/") ||
    url.pathname.startsWith("/splash/") ||
    /\.(css|js|woff2?|png|jpe?g|svg|webp|ico|webmanifest)$/.test(url.pathname);

  if (isStatic) {
    event.respondWith(
      cacheFirst(request, STATIC_CACHE).catch(() => fetch(request)),
    );
  }
});
