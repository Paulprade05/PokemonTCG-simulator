/* Service worker del simulador. Estrategia mixta:
   - navegaciones: red primero, caché como red de seguridad, offline.html como último recurso
   - estáticos propios: caché primero
   - imágenes de cartas: caché primero con revalidación en segundo plano y tope de entradas
   Nunca toca peticiones que no sean GET (las server actions de Next son POST). */

// Súbelo en cada cambio de este fichero: el byte distinto es lo que hace que
// el navegador instale el service worker nuevo y dispare la recarga única de
// ServiceWorkerRegister en las PWA instaladas.
const VERSION = "v6"; // v6: cachea imágenes opacas, precache tolerante y tope de páginas
const SHELL_CACHE = `shell-${VERSION}`;
const STATIC_CACHE = `static-${VERSION}`;
const IMAGE_CACHE = `cards-${VERSION}`;
const PAGES_CACHE = `pages-${VERSION}`;

// Imprescindible para el modo offline: la propia página y el icono que ella
// muestra. Su fallo debe hacer fallar el install para que el navegador
// reintente, en lugar de dejar una versión sin página offline.
const CORE_ASSETS = ["/offline.html", "/icons/icon-192.png"];
// Deseables pero no críticos: que un 404 transitorio del CDN en cualquiera de
// ellos no tumbe el precache imprescindible.
const OPTIONAL_ASSETS = [
  "/manifest.webmanifest",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon.png",
];

const IMAGE_HOSTS = ["images.pokemontcg.io", "tcg.pokemon.com"];
// Dos variantes por carta (small 245w + large 734w) desde que el <img> usa
// srcSet: con 700 entradas se expulsaban cartas ya vistas a mitad de álbum.
const MAX_IMAGE_ENTRIES = 1400;
// Cada navegación cachea su HTML: sin tope, pages-vN crece hasta que el
// navegador purga el origen entero (y con él la caché de cartas).
const MAX_PAGE_ENTRIES = 40;

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // addAll es atómico: se reserva para lo imprescindible y SIN catch. Si
      // falla, el install falla, el SW anterior sigue al mando y el register()
      // de la próxima carga lo reintenta (autocurativo).
      await cache.addAll(CORE_ASSETS);
      // Los opcionales se añaden por separado tolerando fallos individuales.
      await Promise.allSettled(OPTIONAL_ASSETS.map((asset) => cache.add(asset)));
      await self.skipWaiting();
    })(),
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

async function cacheFirst(request, cacheName, { trim, allowOpaque } = {}) {
  const cache = await caches.open(cacheName);
  // Las imágenes de cartas (allowOpaque) sólo viven en su propia caché; para el
  // resto —estáticos propios— se cae a la búsqueda global entre cachés, de modo
  // que el icono de offline.html, precacheado en SHELL_CACHE, se encuentre
  // aunque la petición abra STATIC_CACHE y no salga roto sin conexión.
  const hit =
    (await cache.match(request)) ||
    (allowOpaque ? undefined : await caches.match(request));
  // Las imágenes cross-origin sin CORS devuelven respuesta opaca (status 0,
  // ok=false); para esos hosts se cachea igual, o cards-vN quedaría vacía y no
  // habría cartas sin conexión. Para lo demás se sigue exigiendo res.ok.
  const cacheable = (res) =>
    res && (res.ok || (allowOpaque && res.type === "opaque"));
  if (hit) {
    // Revalida en segundo plano sin bloquear la respuesta.
    fetch(request)
      .then((res) => {
        if (cacheable(res)) cache.put(request, res.clone());
      })
      .catch(() => {});
    return hit;
  }
  const res = await fetch(request);
  if (cacheable(res)) {
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
    if (res && res.ok) {
      cache.put(event.request, res.clone());
      trimCache(PAGES_CACHE, MAX_PAGE_ENTRIES);
    }
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
      cacheFirst(request, IMAGE_CACHE, {
        trim: MAX_IMAGE_ENTRIES,
        allowOpaque: true,
      }).catch(() => fetch(request)),
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
