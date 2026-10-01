/* Service worker del simulador. Estrategia mixta:
   - navegaciones: red primero CON PLAZO cuando hay copia guardada, caché como
     red de seguridad, offline.html como último recurso
   - estáticos propios: caché primero (los de /_next/static/ sin revalidar:
     llevan el hash en el nombre)
   - imágenes de cartas: caché primero, sin revalidar, con tope de entradas
   Nunca toca peticiones que no sean GET (las server actions de Next son POST),
   ni las RSC, ni /api — con UNA excepción escrita abajo: /api/arte-sobre/, que
   no son datos sino fotos públicas de sobre (ver el oyente de `fetch`).

   REGLA DE ORO DE ESTE FICHERO: cualquier rama nueva tiene que acabar en "ir a
   la red" si algo lanza. Un service worker roto deja la app instalada sin
   arrancar y sin forma de actualizarse; uno que se rinde y deja pasar la
   petición, como mucho, se comporta como si no existiera. */

// Súbelo en cada cambio de este fichero: el byte distinto es lo que hace que
// el navegador instale el service worker nuevo y dispare el aviso de versión
// nueva de ServiceWorkerRegister en las PWA instaladas.
const VERSION = "v11"; // v11: las fotos de sobre del cron (/api/arte-sobre/) se guardan con las de cartas

// SÓLO EL ARMAZÓN LLEVA LA VERSIÓN. Antes la llevaban las cuatro cachés y
// `activate` borraba todo lo que no terminara en ella: subir VERSION por un
// arreglo de dos líneas tiraba hasta 1.400 ilustraciones, las páginas y los
// chunks, y quien abría la app sin cobertura justo después sólo veía
// offline.html.
//
// LOS OTROS TRES NOMBRES ESTÁN CONGELADOS, y el "v9" que llevan ya no significa
// nada: son, letra por letra, los que tienen hoy los iPhone con la app
// instalada. Conservar el nombre es lo que hace que la actualización no pierda
// nada sin tener que copiar 1.400 respuestas de una caché a otra dentro de
// `activate` (lento, y con respuestas opacas duplica la cuota mientras dura).
// NO LOS RENOMBRES: cambiar uno equivale a vaciar esa caché en todos los
// dispositivos.
const SHELL_CACHE = `shell-${VERSION}`;
const STATIC_CACHE = "static-v9";
const IMAGE_CACHE = "cards-v9";
const PAGES_CACHE = "pages-v9";

// Imprescindible para el modo offline: la propia página y el icono que ella
// muestra. Su fallo debe hacer fallar el install para que el navegador
// reintente, en lugar de dejar una versión sin página offline.
const CORE_ASSETS = ["/offline.html", "/icons/icon-192.png"];
// Deseables pero no críticos: que un 404 transitorio del CDN en cualquiera de
// ellos no tumbe el precache imprescindible.
const OPTIONAL_ASSETS = [
  "/manifest.webmanifest",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon-v2.png",
];

// assets.tcgdex.net sirve las ilustraciones ESPAÑOLAS y los logos españoles de
// las expansiones. Sin él, un usuario con la app en español se quedaba sin
// cartas al perder cobertura: la caché guardaba las inglesas, que ya no pide
// nadie.
const IMAGE_HOSTS = [
  "images.pokemontcg.io",
  "tcg.pokemon.com",
  "assets.tcgdex.net",
];
// Dos variantes por carta (small 245w + large 734w), y por eso 1400 y no 700:
// con la mitad se expulsaban cartas ya vistas a mitad de álbum.
//
// OJO, NO ES POR srcSet: PokemonCard elige UNA de las dos a mano y explica por
// qué no usa srcSet (con dos variantes tan separadas, el navegador pediría
// siempre la grande y un álbum de 258 cartas pasaría de 45 MB a 151). Las dos
// acaban en caché porque las piden pantallas distintas: la pequeña la rejilla,
// la grande la apertura y el visor.
// El idioma NO duplica la cuenta: sólo se piden las del idioma activo, y quien
// lo cambia hace una recarga completa que vuelve a llenar la caché.
const MAX_IMAGE_ENTRIES = 1400;
// Cada navegación cachea su HTML: sin tope, la caché de páginas crece hasta que
// el navegador purga el origen entero (y con él la caché de cartas).
const MAX_PAGE_ENTRIES = 40;
// Los chunks de cada despliegue se quedaban para siempre: como la caché de
// estáticos ya no se borra al subir VERSION, necesita tope propio. 400 son
// varios despliegues de margen; se recorta por orden de entrada, así que lo
// primero que se va es lo del despliegue más viejo.
const MAX_STATIC_ENTRIES = 400;
// "LO MÁS VIEJO" NO ES "LO QUE YA NO SE USA". Los chunks que no cambian entre
// despliegues (React, el runtime de Next, las fuentes) son los primeros que
// entraron, y como lo inmutable no se revalida, no volvían a entrar nunca: al
// pasar del tope se iban ELLOS, que son justo los que usa cualquier versión, y
// sin red la app no montaba hasta la siguiente carga con cobertura. Por eso,
// de cada tantos aciertos sobre un fichero inmutable, uno se vuelve a guardar:
// `put` lo saca de su sitio y lo pone al final de la cola, así que lo que se
// sigue pidiendo se aleja solo del recorte. Uno de cada ocho y no todos: es
// una escritura a disco, y un arranque pide decenas de chunks.
const ACIERTOS_ENTRE_REFRESCOS = 8;
// Empieza en un punto distinto en cada vida del service worker. Si empezara
// siempre en cero, como un arranque pide los chunks en el mismo orden, se
// refrescarían siempre los mismos y el resto nunca.
let aciertosInmutables = Math.floor(Date.now() / 1000) % ACIERTOS_ENTRE_REFRESCOS;

// PLAZO DE LAS NAVEGACIONES. Con una raya de cobertura la red no falla: no
// contesta. "Red primero" sin plazo esperaba decenas de segundos con la página
// guardada debajo, y la PWA se quedaba en la pantalla de arranque. Pasado este
// tiempo se sirve la copia y la red sigue por detrás refrescándola.
// Cuatro segundos y no tres: un arranque en frío del servidor (función dormida
// más la consulta de expansiones) ronda los dos o tres, y servir la copia
// vieja en ese caso obligaría a recargar después de cada despliegue.
const PLAZO_NAVEGACION_MS = 4000;
// "Recargar la app" y "Actualizar" piden la versión NUEVA: servirles la copia
// guardada porque la red tardó cuatro segundos sería devolverles justo lo que
// querían dejar atrás. La página manda "SIN_PLAZO" antes de recargar y durante
// esta ventana las navegaciones esperan a la red como antes.
const VENTANA_SIN_PLAZO_MS = 15000;
let sinPlazoHasta = 0;

// Las pantallas fijas de la app, las que se alcanzan desde la barra de
// pestañas y desde la colección. Ver `calentar`.
const RUTAS_FIJAS = [
  "/",
  "/collection",
  "/mercado",
  "/friends",
  "/bazar",
  "/vitrina",
  "/graduacion",
];
// Una copia de página con menos de un día no se vuelve a pedir al calentar:
// abrir la app diez veces en una tarde no puede costar setenta renderizados.
const CADUCIDAD_CALENTADO_MS = 24 * 60 * 60 * 1000;
// Tope de ficheros de /_next/static/ que se guardan por página calentada: una
// página normal referencia unas decenas; esto sólo acota un HTML anómalo.
const MAX_ESTATICOS_POR_PAGINA = 150;

// EL SCRIPT DE CLERK (clerk.browser.js). Se sirve desde el dominio de Clerk
// —`<slug>.clerk.accounts.dev` en desarrollo, `clerk.<dominio>` en producción—
// y sin conexión no llegaba: la etiqueta <script> fallaba y `useUser()` no
// resolvía jamás. Es un bundle público y versionado, así que va como los
// estáticos propios (caché primero, revalidación en segundo plano). La
// respuesta es OPACA (la etiqueta lo pide sin CORS), y por eso entra con
// allowOpaque; el navegador ejecuta sin problema un script opaco servido desde
// caché, igual que lo ejecuta desde la red.
//
// LO QUE ESTO NO ARREGLA, para que nadie lo espere: con el script en caché
// clerk-js arranca, pero para saber QUIÉN es el usuario tiene que hablar con
// su API (/v1/environment, /v1/client), y sin red eso falla. `isLoaded` sigue
// sin llegar. Quien desatasca la interfaz en ese caso es el plazo de espera de
// hooks/useGameCurrency.tsx (ESPERA_CLERK_MS): pasado, la app sigue como
// invitado. Aquí sólo se evita que además falte el script.
const ES_HOST_DE_CLERK = /(^|\.)clerk\./;

const espera = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Alarga la vida del evento mientras dure la promesa. Fuera de plazo
 *  `waitUntil` lanza; el trabajo sigue igual, sólo pierde la garantía. */
function mantenerVivo(event, promesa) {
  try {
    event.waitUntil(promesa);
  } catch {
    /* el evento ya se cerró */
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // addAll es atómico: se reserva para lo imprescindible y SIN catch. Si
      // falla, el install falla, el SW anterior sigue al mando y el register()
      // de la próxima carga lo reintenta (autocurativo).
      // `cache: "reload"`: el armazón nuevo tiene que salir de la red, no de la
      // caché HTTP, o una versión nueva podría precargar el offline.html viejo.
      await cache.addAll(
        CORE_ASSETS.map((asset) => new Request(asset, { cache: "reload" })),
      );
      // Los opcionales se añaden por separado tolerando fallos individuales.
      await Promise.allSettled(OPTIONAL_ASSETS.map((asset) => cache.add(asset)));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Cada paso en su propio try: que falle la limpieza no puede impedir
      // que el service worker tome el control.
      try {
        // Lista blanca y no `endsWith(VERSION)`: se va el armazón de la
        // versión anterior y cualquier caché de una generación más vieja
        // (cards-v8…); las tres de nombre congelado se quedan como están.
        const conservar = [SHELL_CACHE, STATIC_CACHE, IMAGE_CACHE, PAGES_CACHE];
        const keys = await caches.keys();
        await Promise.all(
          keys
            .filter((k) => !conservar.includes(k))
            .map((k) => caches.delete(k)),
        );
      } catch {
        /* una caché de más no rompe nada */
      }
      try {
        if (self.registration.navigationPreload) {
          await self.registration.navigationPreload.enable();
        }
      } catch {
        /* sin precarga de navegación se pide con fetch, como siempre */
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  const dato = event.data;
  if (dato === "SKIP_WAITING") {
    self.skipWaiting();
  } else if (dato === "SIN_PLAZO") {
    sinPlazoHasta = Date.now() + VENTANA_SIN_PLAZO_MS;
  } else if (dato === "CALENTAR") {
    mantenerVivo(
      event,
      calentar().catch(() => {}),
    );
  } else if (dato === "VERSION") {
    // Ajustes > Acerca de pregunta qué versión corre. Contesta por el puerto
    // que trae el mensaje; si no trae ninguno no hay a quién contestar.
    try {
      if (event.ports && event.ports[0]) event.ports[0].postMessage(VERSION);
    } catch {
      /* el puerto se cerró: la hoja ya no está */
    }
  }
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

// `trimCache` lista TODAS las claves: llamarlo tras cada escritura, con 1.400
// cartas guardadas, eran 258 listados completos por álbum nuevo. Se recorta en
// la primera escritura de cada vida del service worker (iOS lo mata a menudo,
// así que un contador que empezara en cero podría no llegar nunca) y luego una
// de cada veinticinco. El exceso momentáneo es de 24 entradas como mucho.
const ESCRITURAS_ENTRE_RECORTES = 25;
const escriturasDesdeRecorte = new Map();
function recortarCadaTanto(cacheName, maxEntries) {
  const previas = escriturasDesdeRecorte.get(cacheName);
  const n = previas === undefined ? ESCRITURAS_ENTRE_RECORTES : previas + 1;
  if (n < ESCRITURAS_ENTRE_RECORTES) {
    escriturasDesdeRecorte.set(cacheName, n);
    return;
  }
  escriturasDesdeRecorte.set(cacheName, 0);
  trimCache(cacheName, maxEntries).catch(() => {});
}

/** Guarda sin lanzar: cuota agotada, `Vary: *` o una respuesta parcial no
 *  pueden convertir una petición servida en un error. */
async function guardarEn(cache, cacheName, request, res, trim) {
  try {
    await cache.put(request, res);
    if (trim) recortarCadaTanto(cacheName, trim);
  } catch {
    /* no cupo o no era guardable: la respuesta ya va camino de la página */
  }
}

/**
 * Caché primero para estáticos propios y el script de Clerk.
 * `revalidar: false` es para lo INMUTABLE (/_next/static/, con el hash en el
 * nombre): volver a pedirlo en cada acierto no puede traer nada distinto.
 */
async function cacheFirst(
  request,
  cacheName,
  { trim, allowOpaque, revalidar = true } = {},
) {
  const cache = await caches.open(cacheName);
  // El script de Clerk (allowOpaque) sólo vive en su propia caché; para el
  // resto —estáticos propios— se cae a la búsqueda global entre cachés, de modo
  // que el icono de offline.html, precacheado en SHELL_CACHE, se encuentre
  // aunque la petición abra STATIC_CACHE y no salga roto sin conexión.
  const propio = await cache.match(request);
  const hit = propio || (allowOpaque ? undefined : await caches.match(request));
  // Un script cross-origin sin CORS devuelve respuesta opaca (status 0,
  // ok=false); para ese caso se cachea igual. Para lo demás se exige res.ok.
  const cacheable = (res) =>
    res && (res.ok || (allowOpaque && res.type === "opaque"));
  if (hit) {
    if (revalidar) {
      // Revalida en segundo plano sin bloquear la respuesta.
      fetch(request)
        .then((res) =>
          cacheable(res)
            ? guardarEn(cache, cacheName, request, res, trim)
            : undefined,
        )
        .catch(() => {});
    } else if (propio) {
      // Inmutable y de ESTA caché: ver ACIERTOS_ENTRE_REFRESCOS. El clon se
      // saca antes de entregar el acierto, cuando su cuerpo aún no se ha leído.
      aciertosInmutables += 1;
      if (aciertosInmutables % ACIERTOS_ENTRE_REFRESCOS === 0) {
        try {
          guardarEn(cache, cacheName, request, propio.clone(), trim);
        } catch {
          /* si no se puede clonar, se queda donde estaba */
        }
      }
    }
    return hit;
  }
  const res = await fetch(request);
  if (cacheable(res)) {
    await guardarEn(cache, cacheName, request, res.clone(), trim);
  }
  return res;
}

/* ------------------------------------------------------------------ *
 * IMÁGENES DE CARTAS
 * ------------------------------------------------------------------ *
 *
 * LO QUE FALLABA:
 *  · Cada acierto de caché lanzaba otro fetch y otro cache.put: pintar una
 *    página de colección con 60 cartas ya guardadas eran 60 peticiones y 60
 *    escrituras a disco, para escaneos que no cambian nunca.
 *  · Todo se guardaba como respuesta OPACA (la etiqueta <img> pide sin CORS).
 *    De una opaca no se ve el estado, así que un 404 o un 503 del CDN se
 *    guardaba como si fuera la carta; y los navegadores les cargan un relleno
 *    de cuota enorme (unos 7 MB contables cada una en Chromium).
 *
 * LO QUE HACE AHORA: pide la imagen con CORS y sin credenciales. Si el host lo
 * admite, la respuesta es transparente: se guarda SÓLO si es un 200 de tipo
 * imagen, no lleva relleno de cuota y no hace falta volver a pedirla jamás. Si
 * el host no manda Access-Control-Allow-Origin, ese fetch lanza y se cae a la
 * vía opaca de siempre, que es exactamente lo que había.
 *
 * No se ha podido comprobar desde aquí cuáles de los tres hosts admiten CORS,
 * así que no se da por hecho en ninguno: lo averigua la primera petición a
 * cada uno y se recuerda mientras viva el service worker.
 */

// host -> "cors" | "opaco". Sólo en memoria: si el service worker se reinicia
// lo vuelve a averiguar con una petición.
const modoDeHost = new Map();
// host -> promesa del primer intento en curso. Un álbum nuevo pide 258
// imágenes a la vez; sin esto, las 258 probarían CORS antes de que la primera
// supiera si el host lo admite, y en uno que no lo admite sería descargar el
// álbum dos veces.
const sondeos = new Map();
// Lo que esperan las demás al primer intento. Corto a propósito: con mala
// cobertura ese intento puede tardar mucho y no puede frenar al resto.
const ESPERA_SONDEO_MS = 1500;

const esImagen = (res) => {
  const tipo = res.headers.get("content-type");
  // Sin cabecera se da por buena; con cabecera tiene que decir imagen (una
  // página de error con estado 200 no es una carta).
  return !tipo || tipo.startsWith("image/");
};

async function pedirImagenSabiendo(request, host) {
  if (modoDeHost.get(host) !== "opaco") {
    try {
      const res = await fetch(request.url, {
        mode: "cors",
        credentials: "omit",
      });
      modoDeHost.set(host, "cors");
      return { res, guardable: res.ok && esImagen(res) };
    } catch {
      // O el host no admite CORS o no hay red. Lo aclara la petición de abajo:
      // si ella sí llega, era lo primero.
    }
  }
  const res = await fetch(request);
  if (res.type === "opaque" && !modoDeHost.has(host)) {
    modoDeHost.set(host, "opaco");
  }
  return { res, guardable: res.ok || res.type === "opaque" };
}

function pedirImagen(request, host) {
  if (modoDeHost.has(host)) return pedirImagenSabiendo(request, host);
  const enCurso = sondeos.get(host);
  if (enCurso) {
    return Promise.race([enCurso, espera(ESPERA_SONDEO_MS)]).then(() =>
      pedirImagenSabiendo(request, host),
    );
  }
  const propia = pedirImagenSabiendo(request, host);
  const aviso = propia.then(
    () => {},
    () => {},
  );
  sondeos.set(host, aviso);
  aviso.then(() => {
    if (sondeos.get(host) === aviso) sondeos.delete(host);
  });
  return propia;
}

async function imagenDeCarta(event, host) {
  const { request } = event;
  const cache = await caches.open(IMAGE_CACHE);
  // ignoreVary: una respuesta con CORS puede traer `Vary: Origin`, y la
  // petición de la etiqueta <img> no lleva Origin. La URL es la carta.
  const hit = await cache.match(request, { ignoreVary: true });
  if (hit) {
    // Un acierto transparente es definitivo: no se revalida.
    // Uno OPACO (todo lo guardado antes de esta versión, y lo de los hosts sin
    // CORS) puede ser un error del CDN guardado como carta, y sólo se cura
    // volviéndolo a pedir. Si el host admite CORS, se pide una vez y la
    // entrada pasa a transparente para siempre. Si no lo admite, se revalida
    // una de cada diez veces: sigue curándose sola, con la décima parte del
    // tráfico y de las escrituras.
    if (
      hit.type === "opaque" &&
      self.navigator.onLine !== false &&
      (modoDeHost.get(host) !== "opaco" || Math.random() < 0.1)
    ) {
      mantenerVivo(
        event,
        pedirImagen(request, host)
          .then(({ res, guardable }) =>
            guardable
              ? guardarEn(cache, IMAGE_CACHE, request, res, MAX_IMAGE_ENTRIES)
              : undefined,
          )
          .catch(() => {}),
      );
    }
    return hit;
  }
  const { res, guardable } = await pedirImagen(request, host);
  if (guardable) {
    await guardarEn(cache, IMAGE_CACHE, request, res.clone(), MAX_IMAGE_ENTRIES);
  }
  return res;
}

/* ------------------------------------------------------------------ *
 * NAVEGACIONES
 * ------------------------------------------------------------------ */

/** La copia guardada de una página: la exacta o, si no, la misma ruta con otra
 *  query (`/` sirve para `/?source=pwa` y al revés). */
async function buscarPagina(cache, request) {
  return (
    (await cache.match(request, { ignoreVary: true })) ||
    (await cache.match(request, { ignoreSearch: true, ignoreVary: true })) ||
    null
  );
}

/** ¿Se puede guardar como página? Un 200 que no sea HTML (un JSON, una
 *  descarga, un fichero servido por una ruta sin extensión) no es una pantalla
 *  de la app, y `buscarPagina` se lo serviría después a cualquier navegación a
 *  esa ruta —con cualquier query— en cuanto la red tardara. Y una respuesta
 *  redirigida no se puede devolver a una navegación: el navegador la rechaza. */
function esPaginaGuardable(res) {
  if (!res || !res.ok || res.redirected) return false;
  const tipo = res.headers.get("content-type") || "";
  return tipo.includes("text/html");
}

async function networkFirstPage(event) {
  const { request } = event;
  let cache = null;
  let copia = null;
  try {
    cache = await caches.open(PAGES_CACHE);
    copia = await buscarPagina(cache, request);
  } catch {
    /* sin caché de páginas queda la red, que es lo que había antes de esto */
  }

  const red = (async () => {
    const preload = await event.preloadResponse;
    const res = preload || (await fetch(request));
    if (cache && esPaginaGuardable(res)) {
      // El clon se saca aquí, antes de entregar la respuesta: después el
      // cuerpo ya está en uso.
      const paraGuardar = res.clone();
      mantenerVivo(
        event,
        cache
          .put(request, paraGuardar)
          .then(() => trimCache(PAGES_CACHE, MAX_PAGE_ENTRIES))
          .catch(() => {}),
      );
    }
    return res;
  })();

  // Una vuelta del inicio de sesión de Clerk trae su testigo en la query
  // (`__clerk_handshake` y compañía) y quien tiene que procesarlo es el
  // servidor. Servirle la copia guardada porque la red tardó dejaría la sesión
  // a medio establecer: para estas navegaciones no hay plazo.
  const esVueltaDeClerk = request.url.includes("__clerk");

  // UNA RECARGA TAMBIÉN VA SIN PLAZO, la pida quien la pida. "SIN_PLAZO" sólo
  // lo manda `recargarApp()` (utils/versionApp.ts). El JavaScript de la versión
  // anterior —el que sigue vivo en una PWA suspendida cuando llega este
  // service worker— recarga con `location.reload()` a secas, sin mensaje: con
  // cobertura lenta recibía a los cuatro segundos la misma copia vieja que
  // quería dejar atrás, sin aviso. El navegador marca la petición de una
  // recarga con `cache` "reload" o "no-cache"; una navegación normal lleva
  // "default". Si algún navegador no la marcara, esto no cambia nada: se queda
  // con el plazo de siempre.
  const esRecarga = request.cache === "reload" || request.cache === "no-cache";

  // SIN COPIA (o con una recarga pedida a propósito) no hay nada mejor que
  // esperar a la red: se comporta como siempre.
  if (!copia || esVueltaDeClerk || esRecarga || Date.now() < sinPlazoHasta) {
    try {
      return await red;
    } catch (err) {
      if (copia) return copia;
      const offline = await caches.match("/offline.html");
      if (offline) return offline;
      throw err;
    }
  }

  // CON COPIA: carrera entre la red y el plazo. Con red buena gana la red y no
  // cambia nada; con red mala la app arranca con la copia a los cuatro
  // segundos y la red, que sigue viva por detrás, deja la copia al día para la
  // próxima vez. Si la copia es de un despliegue anterior, quien lo detecta y
  // ofrece actualizar es ServiceWorkerRegister.
  mantenerVivo(
    event,
    red.catch(() => {}),
  );
  const ganadora = await Promise.race([
    red.catch(() => null),
    espera(PLAZO_NAVEGACION_MS).then(() => null),
  ]);
  return ganadora || copia;
}

/* ------------------------------------------------------------------ *
 * CALENTAR LAS PANTALLAS FIJAS
 * ------------------------------------------------------------------ *
 *
 * EL PROBLEMA: dentro de la app todo son navegaciones de cliente (peticiones
 * RSC, que este fichero ignora a propósito), así que la caché de páginas sólo
 * conocía la ruta por la que se entró. Sin red, tocar "Colección" hacía fallar
 * la petición RSC, Next caía a una navegación dura a /collection, esa página
 * no estaba guardada y el jugador acababa en offline.html: en una app
 * instalada, sin barra ni botón atrás, un callejón sin salida.
 *
 * LO QUE SE HACE: cuando la página lo pide (mensaje "CALENTAR", una vez por
 * arranque de la app instalada), se pide el HTML de cada pantalla fija y se
 * guarda junto con los ficheros de /_next/static/ que ese HTML nombra. Así la
 * navegación dura de respaldo encuentra la página Y sus chunks, la app se
 * monta, y es cada pantalla la que enseña su propio estado de error con su
 * reintento, con la barra de pestañas a la vista.
 *
 * Nada de esto toca el camino de las peticiones: si falla entero, la app queda
 * exactamente como estaba antes de existir.
 */
let calentando = null;
function calentar() {
  if (!calentando) {
    calentando = calentarRutas().finally(() => {
      calentando = null;
    });
  }
  return calentando;
}

/** ¿Es una página de la app, entera y servida por nosotros? Una redirección
 *  guardada no se puede devolver a una navegación, y un HTML que no nombre
 *  /_next/static/ no es la app (un error del proveedor, un portal). */
function esPaginaDeLaApp(res, html) {
  if (!res || !res.ok || res.redirected || res.type !== "basic") return false;
  const tipo = res.headers.get("content-type") || "";
  return tipo.includes("text/html") && html.includes("/_next/static/");
}

function esCopiaReciente(res) {
  const fecha = Date.parse(res.headers.get("date") || "");
  // Sin fecha no se puede saber: se da por buena para no pedirla en cada
  // arranque. Se refresca igual cuando alguien navega a ella con red.
  if (!Number.isFinite(fecha)) return true;
  return Date.now() - fecha < CADUCIDAD_CALENTADO_MS;
}

function estaticosDe(html) {
  const urls = new Set();
  // En el HTML aparecen como atributo (src="/_next/…") y dentro del flujo RSC
  // incrustado, con las comillas escapadas (\"/_next/…\"): se corta en comilla,
  // barra invertida, espacio o cierre de etiqueta.
  const candidatos = html.match(/\/_next\/static\/[^"'\\\s<>)]+/g) || [];
  for (const crudo of candidatos) {
    const url = crudo.replace(/&amp;/g, "&");
    if (!/\.(js|css|woff2?)(\?.*)?$/.test(url)) continue;
    urls.add(url);
    if (urls.size >= MAX_ESTATICOS_POR_PAGINA) break;
  }
  return [...urls];
}

async function guardarEstaticos(urls) {
  const cache = await caches.open(STATIC_CACHE);
  // De cuatro en cuatro: es trabajo de fondo y no debe quitarle la red a lo
  // que el jugador está mirando.
  for (let i = 0; i < urls.length; i += 4) {
    await Promise.all(
      urls.slice(i, i + 4).map(async (url) => {
        try {
          if (await cache.match(url)) return;
          const res = await fetch(url);
          if (res.ok) {
            await guardarEn(cache, STATIC_CACHE, url, res, MAX_STATIC_ENTRIES);
          }
        } catch {
          /* un chunk que no llega se pedirá cuando haga falta */
        }
      }),
    );
  }
}

async function calentarRutas() {
  const paginas = await caches.open(PAGES_CACHE);
  let guardadas = 0;
  for (const ruta of RUTAS_FIJAS) {
    try {
      const copia = await paginas.match(ruta, {
        ignoreSearch: true,
        ignoreVary: true,
      });
      if (copia && esCopiaReciente(copia)) continue;
      const res = await fetch(ruta, { credentials: "same-origin" });
      const html = await res.clone().text();
      if (!esPaginaDeLaApp(res, html)) continue;
      // Primero los chunks y la página la última: que la página esté guardada
      // significa que sus ficheros ya lo estaban.
      await guardarEstaticos(estaticosDe(html));
      await paginas.put(ruta, res);
      guardadas++;
    } catch {
      /* una ruta que falla no impide las demás */
    }
  }
  if (guardadas > 0) await trimCache(PAGES_CACHE, MAX_PAGE_ENTRIES);
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
      imagenDeCarta(event, url.hostname).catch(() => fetch(request)),
    );
    return;
  }

  // Sólo el SCRIPT de Clerk, nunca sus llamadas de API (mismo host, pero
  // `destination` distinto): la sesión no se cachea jamás.
  if (request.destination === "script" && ES_HOST_DE_CLERK.test(url.hostname)) {
    event.respondWith(
      cacheFirst(request, STATIC_CACHE, {
        allowOpaque: true,
        trim: MAX_STATIC_ENTRIES,
      }).catch(() => fetch(request)),
    );
    return;
  }

  if (url.origin !== self.location.origin) return;

  /* LA ÚNICA RUTA DE /api QUE SE GUARDA: las fotos de sobre que trae el cron.
     No son datos de nadie: son imágenes públicas, sin sesión, que la propia
     ruta sirve con un año de caché en el CDN (app/api/arte-sobre). Vivían
     fuera del service worker sólo por empezar por /api, así que la tienda las
     volvía a pedir en cada visita y, sin cobertura, las expansiones cuya foto
     trae el cron se quedaban con el sobre dibujado aunque ya se hubiera visto.
     Van a la caché de imágenes, con su mismo tope. `cacheFirst` sólo guarda
     respuestas 200: el 404 de "no hay foto" y el 503 de "ahora no se puede
     saber" no se quedan. Y el catch final es la regla de oro. */
  if (url.pathname.startsWith("/api/arte-sobre/")) {
    event.respondWith(
      cacheFirst(request, IMAGE_CACHE, { trim: MAX_IMAGE_ENTRIES }).catch(() =>
        fetch(request),
      ),
    );
    return;
  }

  // Nunca cachear autenticación ni datos dinámicos.
  if (url.pathname.startsWith("/api") || url.pathname.includes("clerk")) return;
  if (request.headers.get("RSC") || url.searchParams.has("_rsc")) return;

  if (request.mode === "navigate") {
    // El catch final es la regla de oro: si la estrategia entera lanza, la
    // navegación va a la red como si este fichero no existiera.
    event.respondWith(networkFirstPage(event).catch(() => fetch(request)));
    return;
  }

  const inmutable = url.pathname.startsWith("/_next/static/");
  const isStatic =
    inmutable ||
    url.pathname.startsWith("/icons/") ||
    url.pathname.startsWith("/splash/") ||
    /\.(css|js|woff2?|png|jpe?g|svg|webp|ico|webmanifest)$/.test(url.pathname);

  if (isStatic) {
    event.respondWith(
      cacheFirst(request, STATIC_CACHE, {
        trim: MAX_STATIC_ENTRIES,
        revalidar: !inmutable,
      }).catch(() => fetch(request)),
    );
  }
});
