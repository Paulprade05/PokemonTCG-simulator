#!/usr/bin/env node
/**
 * BAJA DE BULBAPEDIA LA ILUSTRACIÓN REAL DEL SOBRE DE CADA EXPANSIÓN.
 *
 *   node scripts/bajar-sobres-bulbapedia.mjs                  (SIMULACIÓN: informe y nada más)
 *   node scripts/bajar-sobres-bulbapedia.mjs --aplicar        (baja y sustituye en public/sobres)
 *   node scripts/bajar-sobres-bulbapedia.mjs --solo-informe   (lo mismo que sin argumentos)
 *   node scripts/bajar-sobres-bulbapedia.mjs --refrescar      (ignora la caché)
 *   node scripts/bajar-sobres-bulbapedia.mjs --aplicar --retirar-sobrantes
 *                                 (además MUEVE a la caché las variantes de antes que ya no salen)
 *
 * NO BORRA NADA, NUNCA. Ni una foto, ni una carpeta. Lo nuevo se prepara fuera
 * del repositorio y sólo sustituye a lo que había cuando está entero y
 * comprobado; si algo falla, lo que había se queda como estaba y el informe lo
 * dice. El porqué —y el fallo que había antes— está en la cabecera del paso 4.
 *
 * NECESITA `sharp`, QUE NO ESTÁ EN package.json: hoy llega sólo como dependencia
 * OPCIONAL de Next (next -> sharp). Con `npm install --omit=optional`, o en una
 * plataforma para la que sharp no traiga binario, este script y
 * preparar-sobres.mjs dejan de arrancar con "Cannot find package sharp".
 * Declararlo en devDependencies exige instalar, y eso lo decide el dueño.
 *
 * Es el hermano automático de scripts/preparar-sobres.mjs. Aquél convierte los
 * PNG que una persona ha bajado a mano a una carpeta; éste hace el trabajo de
 * esa persona para las 171 expansiones de src/data/all-sets.json. Los dos
 * acaban en el mismo sitio —public/sobres/<id>/1.webp… y el manifiesto
 * src/data/sobres.json— y los dos lo dejan igual: da lo mismo en qué orden se
 * ejecuten (ver "EL MANIFIESTO SE RECONSTRUYE DEL DISCO", más abajo).
 *
 * ============================================================================
 * DE DÓNDE SALEN LAS IMÁGENES Y CON QUÉ PERMISO SE PUBLICAN
 * ============================================================================
 *
 * De Bulbapedia (bulbapedia.bulbagarden.net), a través de su API de MediaWiki;
 * los ficheros viven en Bulbagarden Archives (archives.bulbagarden.net).
 *
 * El contenido *escrito* de Bulbapedia se publica bajo Attribution-
 * NonCommercial-ShareAlike 2.5 (CC BY-NC-SA 2.5). Las imágenes NO: son
 * escaneos y arte oficial de producto cuyos derechos son de Nintendo /
 * Creatures / GAME FREAK / The Pokémon Company, y la wiki los aloja como uso
 * legítimo con fines informativos. Aquí se usan igual —proyecto personal, sin
 * ánimo de lucro, con la ilustración identificando a su propio producto— y NO
 * se pueden usar comercialmente. Quien mañana quiera hacer algo comercial con
 * este repositorio tiene que empezar por borrar public/sobres.
 *
 * El dueño del repositorio lo sabe y ha pedido esto explícitamente. Queda
 * escrito aquí para que no haga falta preguntárselo otra vez.
 *
 * Y por ser buenos vecinos de una wiki que se paga con donaciones: se manda un
 * User-Agent que identifica el proyecto, se piden hasta 50 títulos por
 * petición en vez de uno, se duerme entre peticiones, se piden MINIATURAS y no
 * los originales de 1,7 MB (thumburl), y todo lo que se baja se guarda en
 * caché fuera del repositorio para que la segunda ejecución no repita nada.
 *
 * ============================================================================
 * LO DIFÍCIL NO ES BAJAR: ES EMPAREJAR
 * ============================================================================
 *
 * Nuestro id es "sv8" y la página se llama "Surging Sparks (TCG)". El puente
 * es el nombre de src/data/all-sets.json, pero el puente se cae solo: hay
 * expansiones con otro nombre en la wiki ("HS—Unleashed" es "Unleashed
 * (TCG)"), subsets que no tienen sobre propio (Trainer Gallery, Shiny Vault),
 * redirecciones que juntan dos expansiones en una página (Rayo Negro y Llama
 * Blanca), y páginas que llevan DENTRO los sobres japoneses del mismo bloque,
 * que son otro producto con otro dibujo.
 *
 * UN SOBRE EN LA EXPANSIÓN EQUIVOCADA ES PEOR QUE UN SOBRE QUE FALTA: el que
 * falta se ve —queda el sobre dibujado— y el equivocado no lo mira nadie dos
 * veces. Así que aquí se empareja con dos llaves y hacen falta las dos:
 *
 *   1. LA PÁGINA. El título por defecto es "<nombre> (TCG)". Se aceptan las
 *      redirecciones de la wiki (Base -> Base Set), y si no, hay un mapa a
 *      mano en src/data/sobres-bulbapedia.json.
 *   2. EL NOMBRE DEL FICHERO. Que la página sea la buena NO basta: "Surging
 *      Sparks (TCG)" trae 31 ficheros y 27 son iconos de ataque. El fichero
 *      tiene que llamarse "<algo nuestro> Booster <lo que sea>", donde "algo
 *      nuestro" es el nombre de la expansión, su id, el título de la página o
 *      un prefijo puesto a mano. Eso deja fuera "S12a VSTAR Universe Booster
 *      Chinese.png" (el sobre japonés de Zenit Supremo) sin tener que saber
 *      qué es "S12a", que es justo lo que no quiero tener que saber.
 *
 *   Y tres cedazos más, que salen gratis y quitan disgustos:
 *     - la proporción: un sobre es alto y estrecho (~1,83 de alto por ancho).
 *       Lo que se salga de [1,65 - 2,00] no es un sobre, es una caja, un
 *       expositor o un recorte del dibujo;
 *     - el idioma: fuera "… Booster Chinese", "… ES", "… KO";
 *     - la unicidad: si dos expansiones se pelean por el mismo fichero, no se
 *       lo lleva ninguna. Es lo que pasaría con las páginas que juntan dos
 *       expansiones si el mapa a mano se equivocase.
 *
 * TODO LO QUE SE QUEDA SIN SOBRE SE IMPRIME AL FINAL, con el motivo, para que
 * se pueda arreglar a mano en src/data/sobres-bulbapedia.json.
 *
 * ============================================================================
 * EL PESO ES UN LÍMITE DURO
 * ============================================================================
 *
 * Son ~130 expansiones con sobre y, a 4 variantes y ancho 780 como las de
 * me5, se plantan en 60 MB dentro de un repositorio de git que se despliega en
 * Vercel. Tres decisiones lo bajan a la quinta parte:
 *
 *   - MÁXIMO 3 VARIANTES por expansión. Con tres ya no se repite el dibujo dos
 *     sobres seguidos, que es todo lo que se le pedía a la variedad.
 *   - ANCHO 560 Y NO 780. El sobre se pinta a ~280 px de ancho (ver ANCHO_ARTE
 *     en components/BoosterPack.tsx), así que 560 es exactamente 2x, la
 *     densidad de la inmensa mayoría de las pantallas. Los 780 de
 *     preparar-sobres.mjs (2,8x) se los puede permitir quien convierte cuatro
 *     imágenes a mano; aquí son cuatrocientas y el área crece al cuadrado.
 *   - NUNCA SE AMPLÍA. Muchos escaneos viejos tienen 250-400 px de ancho. Se
 *     quedan como están: ampliarlos sólo añade peso y desenfoque.
 *
 *   Y por encima de todo, TOPE_MB: si el total se pasa, se deja de bajar y se
 *   dice. Las expansiones se recorren de la MÁS NUEVA a la más vieja, así que
 *   lo que se quedaría fuera es lo que menos se abre.
 *
 * ============================================================================
 * LA PROPORCIÓN DE SALIDA NO ES NEGOCIABLE
 * ============================================================================
 *
 * components/BoosterPack.tsx pinta la foto con `background: … 100% auto` y le
 * da al hueco `aspect-ratio: 780/1426`. O sea que el fichero tiene que tener
 * ESA proporción exacta (1,828), no un ancho concreto: si es más chato quedan
 * bandas transparentes por abajo, y si es más alto se corta. Los escaneos
 * andan entre 1,72 y 1,90, así que cada uno se recorta a la proporción buena
 * (`cover`, anclado ARRIBA: lo que sobra se va por abajo, que es la parte lisa
 * del sobre, y nunca por el crimpado de arriba, que es por donde la aplicación
 * rasga).
 *
 * ============================================================================
 * EL MANIFIESTO SE RECONSTRUYE DEL DISCO
 * ============================================================================
 *
 * src/data/sobres.json no se escribe con "lo que acabo de convertir" sino
 * MIRANDO public/sobres. Si no, el último de los dos scripts en ejecutarse
 * borraría del manifiesto el trabajo del otro, y la expansión tendría su foto
 * en el disco sin que la aplicación llegara a mirarla nunca. Con el disco como
 * fuente de verdad los dos scripts conmutan y el manifiesto es siempre lo que
 * de verdad hay.
 *
 * Y por lo mismo, este script NO TOCA UNA CARPETA QUE NO SEA SUYA: las que
 * bajó él están apuntadas en la sección "generado" de
 * src/data/sobres-bulbapedia.json. Una carpeta que existe y no está ahí es de
 * una persona (hoy, me5) y vale más que la mía.
 */

// OJO: aquí NO se importa `rmSync` ni `unlinkSync`, y es a propósito. Este
// script no borra nada (ver el paso 4); si algún día hace falta uno de los dos,
// antes hay que leer por qué se quitaron.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { transform, loadBindings } from "next/dist/build/swc/index.js";
import sharp from "sharp";

/* ------------------------------------------------------------------ *
 * EL EMPAREJAMIENTO YA NO VIVE AQUÍ
 * ------------------------------------------------------------------ *
 *
 * Lo difícil de este script —decidir QUÉ fichero de la wiki es el sobre de QUÉ
 * expansión— se ha mudado a services/sobresEmparejar.ts, y desde aquí se
 * IMPORTA. El porqué largo está en la cabecera de aquel fichero; el corto es
 * que ahora hay un segundo consumidor, el cron nocturno
 * (services/sobresIngest.ts), y dos copias de esta lógica no se separan "por
 * si acaso": se separan seguro, y cuando lo hagan el resultado no será un
 * error sino UN SOBRE EN LA EXPANSIÓN EQUIVOCADA, que no lo mira nadie dos
 * veces.
 *
 * CARGAR UN .ts DESDE UN .mjs: mismo truco que scripts/test-invariantes.mjs y
 * scripts/sim-mercado.mjs — se transpila con el SWC que Next ya trae y se
 * ejecuta con `new Function`. Se copian las ~18 líneas en vez de compartirlas
 * porque compartirlas obligaría a que los tres scripts importasen de un cuarto
 * fichero, y entonces el cargador necesitaría un cargador.
 *
 * El módulo cargado NO IMPORTA NADA (es una regla suya, escrita allí), así que
 * este `require` de mentira no llega a usarse nunca. Se deja igualmente para
 * que el día que alguien le añada una dependencia el fallo sea un mensaje
 * claro y no un `undefined` diez líneas más abajo.
 */
// Que `loadBindings` no reescriba package-lock.json ni llame al registro de npm
// (lo hace si al lockfile le faltan los `@next/swc-*`; ver scripts/sim-mercado.mjs).
process.env.NEXT_IGNORE_INCORRECT_LOCKFILE ??= "1";
await loadBindings();

const _modulos = new Map();
async function cargarModulo(rel) {
  const clave = resolve(process.cwd(), rel);
  if (_modulos.has(clave)) return _modulos.get(clave);
  const { code } = await transform(readFileSync(clave, "utf8"), {
    jsc: { parser: { syntax: "typescript" }, target: "es2022" },
    module: { type: "commonjs" },
  });
  const mod = { exports: {} };
  const requiere = (spec) => {
    const destino = resolve(dirname(clave), spec.endsWith(".ts") ? spec : spec + ".ts");
    const dep = _modulos.get(destino);
    if (!dep) throw new Error("dependencia no precargada: " + spec);
    return dep;
  };
  new Function("module", "exports", "require", code)(mod, mod.exports, requiere);
  _modulos.set(clave, mod.exports);
  return mod.exports;
}

const {
  RATIO,
  MAX_VARIANTES,
  acumularPaginas,
  candidatasDe,
  pasaElFiltro,
  resolverPaginas,
  tituloDePagina,
} = await cargarModulo("services/sobresEmparejar.ts");

/* ------------------------------------------------------------------ *
 * CONSTANTES
 * ------------------------------------------------------------------ */

const API = "https://bulbapedia.bulbagarden.net/w/api.php";
/** Que se sepa quién llama y a quién quejarse. Lo pide la etiqueta de MediaWiki. */
const AGENTE =
  "PokemonTCGSimulator-sobres/1.0 (simulador de sobres, proyecto personal sin ánimo de lucro; node " +
  process.versions.node +
  ")";

/** Pausa entre peticiones a la API. */
const PAUSA_API = 900;
/** Pausa entre descargas de imagen (ficheros estáticos, se puede ir algo más rápido). */
const PAUSA_IMG = 350;
/** Títulos por petición. La API admite 50 y así 171 expansiones son ~4 peticiones. */
const LOTE = 50;

/** Ancho de salida. El porqué de 560 y no 780 está en la cabecera. */
const ANCHO = 560;
/** Calidad WebP, la misma que preparar-sobres.mjs. */
const CALIDAD = 82;
/**
 * Tope de peso de public/sobres. Si se pasa, se para y se avisa.
 *
 * 30 no es un número redondo por casualidad: las 129 expansiones que hoy
 * tienen sobre ocupan 25,9 MB, y los 4 MB que sobran son las que traiga el
 * cron los próximos meses sin que nadie tenga que volver aquí. Cuando salte el
 * aviso hay que decidir a conciencia, no subir el número: bajar MAX_VARIANTES
 * a 2 quita un tercio del peso de golpe y deja variedad de sobra.
 *
 * OJO: este tope es SÓLO de este script, porque sólo aquí las fotos son
 * ficheros de un repositorio de git que se despliega entero. El cron escribe
 * en Postgres y no tiene este problema; el suyo es otro (no martillear la
 * wiki) y está en services/sobresIngest.ts.
 */
const TOPE_MB = 30;

/* RATIO, RATIO_MIN, RATIO_MAX, ANCHO_MINIMO, MAX_VARIANTES, CANDIDATAS_EXTRA,
 * PALABRAS_NO, IDIOMAS_NO, TIRADAS y EXTENSIONES estaban aquí y ahora viven en
 * services/sobresEmparejar.ts, junto con las tres funciones que los usan. Lo
 * que este script necesita nombrar directamente se destructura arriba; el
 * resto lo aplican `candidatasDe` y `pasaElFiltro` por dentro. */

/* ------------------------------------------------------------------ *
 * RUTAS Y ARGUMENTOS
 * ------------------------------------------------------------------ */

const raiz = process.cwd();
const argv = process.argv.slice(2);
const tiene = (f) => argv.includes(f);
const valor = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
};

/* POR DEFECTO, SIMULACIÓN. Este script reescribe ~400 ficheros commiteados de
 * public/sobres, así que tocar el disco tiene que ser una decisión y no lo que
 * pasa al pulsar Intro: sin --aplicar se queda en informe, igual que con
 * --solo-informe (que se conserva, y gana si se pasan los dos). */
const APLICAR = tiene("--aplicar");
const SOLO_INFORME = tiene("--solo-informe") || !APLICAR;
const REFRESCAR = tiene("--refrescar");
/** Mover a la caché las variantes de antes que ya no salen. Mover, no borrar. */
const RETIRAR_SOBRANTES = tiene("--retirar-sobrantes");

const SETS = join(raiz, "src", "data", "all-sets.json");
const MAPA = join(raiz, "src", "data", "sobres-bulbapedia.json");
const DESTINO = join(raiz, "public", "sobres");
const MANIFIESTO = join(raiz, "src", "data", "sobres.json");
/* La caché vive FUERA del repositorio, AL LADO de la carpeta de originales de
 * preparar-sobres.mjs y no DENTRO: las dos son materia prima que no se
 * commitea, pero aquél recorre su carpeta tratando cada subcarpeta como una
 * expansión, y una caché ahí dentro le sale por el informe como "carpeta sin
 * mapear" en cada ejecución. Así tampoco hay que tocar .gitignore. */
const CACHE = valor("--cache")
  ? resolve(valor("--cache"))
  : resolve(raiz, "..", "_cache-sobres-bulbapedia");

for (const f of [SETS, MAPA]) {
  if (!existsSync(f)) {
    console.error("Falta un fichero que hace falta sí o sí: " + f);
    process.exit(1);
  }
}

const sets = JSON.parse(readFileSync(SETS, "utf8"));
const mapa = JSON.parse(readFileSync(MAPA, "utf8"));
const MANUAL = mapa.manual ?? {};
const GENERADO_ANTES = mapa.generado ?? {};

mkdirSync(join(CACHE, "api"), { recursive: true });
mkdirSync(join(CACHE, "img"), { recursive: true });

/* ------------------------------------------------------------------ *
 * UTILIDADES
 * ------------------------------------------------------------------ */

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/** Nombre de fichero de caché a partir de un título, con hash para no colisionar. */
function claveCache(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const limpio = s.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 90);
  return limpio + "-" + (h >>> 0).toString(36);
}

function leerCache(carpeta, clave) {
  if (REFRESCAR) return null;
  const f = join(CACHE, carpeta, clave);
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return null;
  }
}

function escribirCache(carpeta, clave, dato) {
  writeFileSync(join(CACHE, carpeta, clave), JSON.stringify(dato));
}

/**
 * Una petición a la API, con reintentos.
 *
 * `maxlag` es la cortesía estándar de MediaWiki: si sus bases de datos van
 * retrasadas, que nos manden a esperar en vez de añadir carga. Y un 429 se
 * respeta de verdad, con espera larga: es la wiki diciendo "para".
 */
async function pedirApi(params) {
  const url = API + "?" + new URLSearchParams({ format: "json", formatversion: "2", maxlag: "5", ...params });
  for (let intento = 1; intento <= 4; intento++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": AGENTE, Accept: "application/json" } });
      if (r.status === 429 || r.status >= 500) {
        await dormir(4000 * intento);
        continue;
      }
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      if (j.error?.code === "maxlag") {
        await dormir(5000);
        continue;
      }
      if (j.error) throw new Error(j.error.code + ": " + j.error.info);
      return j;
    } catch (e) {
      if (intento === 4) throw e;
      await dormir(1500 * intento);
    }
  }
  // Aquí se llega cuando los cuatro intentos acabaron en 429, 5xx o maxlag: la
  // wiki está caída o pidiendo que se pare. Antes decía "no debería llegarse
  // aquí", que era falso y no ayudaba a nadie.
  throw new Error("la API de Bulbapedia no ha contestado en 4 intentos (429, 5xx o maxlag). No se ha tocado nada: vuelve a probar más tarde");
}

/* ------------------------------------------------------------------ *
 * PASO 1. QUÉ FICHEROS TIENE LA PÁGINA DE CADA EXPANSIÓN
 * ------------------------------------------------------------------ */

/**
 * Pide `prop=images` de una lista de títulos y devuelve, por TÍTULO PEDIDO,
 * el título final (tras normalización y redirección) y sus ficheros.
 *
 * La continuación de la API no es un adorno: con 50 páginas de golpe y hasta
 * 500 ficheros cada una, la respuesta llega partida y las páginas del final
 * volverían vacías. Se sigue el `continue` hasta que no queda nada.
 *
 * QUÉ DE ESTO ES DE AQUÍ Y QUÉ NO: los lotes de 50, la caché en disco y las 8
 * rondas son transporte y son de aquí. Seguir los alias de la wiki
 * (`normalized`/`redirects`) y cerrar el mapa PEDIDO -> página son
 * `acumularPaginas` y `resolverPaginas`, de services/sobresEmparejar.ts, y no
 * pueden ser de aquí: el título final entra en `prefijosDe` como PREFIJO, o sea
 * que decide qué ficheros se aceptan. Estaba escrito aquí y otra vez en el cron,
 * y dos copias de eso no se separan en un log sino en un prefijo.
 */
async function ficherosDePaginas(titulos) {
  const salida = new Map();
  const pendientes = [];

  for (const t of titulos) {
    const cacheado = leerCache("api", claveCache("pag:" + t));
    if (cacheado) salida.set(t, cacheado);
    else pendientes.push(t);
  }

  for (let i = 0; i < pendientes.length; i += LOTE) {
    const lote = pendientes.slice(i, i + LOTE);
    let params = {
      action: "query",
      redirects: "1",
      prop: "images",
      imlimit: "500",
      titles: lote.join("|"),
    };
    // pedido -> título final, siguiendo normalización y redirección
    const destinoDe = new Map(lote.map((t) => [t, t]));
    const acumulado = new Map();

    for (let ronda = 0; ronda < 8; ronda++) {
      const j = await pedirApi(params);
      acumularPaginas(j, destinoDe, acumulado);
      if (!j.continue) break;
      params = { ...params, ...j.continue };
      await dormir(PAUSA_API);
    }

    for (const [t, p] of resolverPaginas(lote, destinoDe, acumulado)) {
      // `redirigido` es sólo del informe de aquí y por eso se calcula aquí: el
      // título final ya viene resuelto, así que basta con mirar si cambió.
      const entrada = { titulo: p.titulo, existe: p.existe, redirigido: p.titulo !== t, ficheros: p.ficheros };
      escribirCache("api", claveCache("pag:" + t), entrada);
      salida.set(t, entrada);
    }

    console.log(`   páginas ${Math.min(i + LOTE, pendientes.length)}/${pendientes.length}`);
    await dormir(PAUSA_API);
  }

  return salida;
}

/* ------------------------------------------------------------------ *
 * PASO 2. CUÁL DE ESOS FICHEROS ES EL SOBRE
 * ------------------------------------------------------------------ *
 *
 * Ya no está aquí: `prefijosDe` y `analizarFichero` viven en
 * services/sobresEmparejar.ts y las aplica `candidatasDe`, que además
 * deduplica, ordena y corta. Este script la llama más abajo, en el bucle del
 * programa, con exactamente los mismos argumentos que usaba el código suelto
 * que había ahí.
 */

/* ------------------------------------------------------------------ *
 * PASO 3. TAMAÑO Y URL DE CADA CANDIDATA
 * ------------------------------------------------------------------ */

/**
 * `iiurlwidth` es la parte amable: en vez del original (1,7 MB de PNG) pide la
 * miniatura ya escalada al ancho que vamos a usar. Y de paso llegan alto y
 * ancho reales, que es con lo que se descarta lo que no tiene forma de sobre
 * SIN bajarlo.
 */
async function infoDeFicheros(titulos) {
  const salida = new Map();
  const pendientes = [];
  for (const t of titulos) {
    const c = leerCache("api", claveCache("img:" + t));
    if (c) salida.set(t, c);
    else pendientes.push(t);
  }

  for (let i = 0; i < pendientes.length; i += LOTE) {
    const lote = pendientes.slice(i, i + LOTE);
    const j = await pedirApi({
      action: "query",
      prop: "imageinfo",
      iiprop: "url|size|mime",
      iiurlwidth: String(ANCHO),
      titles: lote.join("|"),
    });
    const porTitulo = new Map();
    for (const p of j.query?.pages ?? []) {
      const info = p.imageinfo?.[0];
      porTitulo.set(p.title, info ? { url: info.thumburl || info.url, ancho: info.width, alto: info.height, mime: info.mime } : null);
    }
    for (const t of lote) {
      const dato = porTitulo.get(t) ?? null;
      escribirCache("api", claveCache("img:" + t), dato);
      salida.set(t, dato);
    }
    console.log(`   ficheros ${Math.min(i + LOTE, pendientes.length)}/${pendientes.length}`);
    await dormir(PAUSA_API);
  }
  return salida;
}

/** Los bytes de una imagen, de la caché si ya estaban. */
async function bajarImagen(url) {
  const clave = claveCache(url);
  const destino = join(CACHE, "img", clave);
  if (!REFRESCAR && existsSync(destino)) return readFileSync(destino);

  const u = new URL(url);
  // Sólo de la wiki. La URL viene de su API, pero esto acaba en un fetch y en
  // el disco, y una lista blanca cuesta una línea.
  if (u.protocol !== "https:" || !/(^|\.)bulbagarden\.net$/.test(u.hostname)) {
    throw new Error("URL fuera de Bulbagarden: " + url);
  }
  const r = await fetch(url, { headers: { "User-Agent": AGENTE } });
  if (!r.ok) throw new Error("HTTP " + r.status + " al bajar " + url);
  const buf = Buffer.from(await r.arrayBuffer());
  /* A la caché sólo entra lo que se deja abrir como imagen. Una descarga cortada
   * o una página de error servida con 200 se guardaba tal cual, y como la caché
   * manda sobre la red, esa expansión fallaba ya en TODAS las pasadas siguientes
   * hasta que alguien se acordase de --refrescar. */
  try {
    await sharp(buf).metadata();
  } catch (e) {
    throw new Error("lo que se ha bajado no es una imagen (" + buf.length + " bytes): " + e.message);
  }
  writeFileSync(destino, buf);
  await dormir(PAUSA_IMG);
  return buf;
}

/* ------------------------------------------------------------------ *
 * PASO 4. CONVERSIÓN
 * ------------------------------------------------------------------ */

/**
 * A WebP con la proporción exacta que la aplicación da por hecha.
 *
 * `cover` recorta lo que sobra en vez de rellenar con transparencia, y anclado
 * arriba: lo que se pierde es el borde de abajo del sobre, que es liso, y
 * nunca el crimpado de arriba, que es por donde se rasga.
 *
 * El ancho de salida nunca supera el del original: la mitad de estos escaneos
 * tienen 300 px y ampliarlos sólo sería peso y desenfoque.
 */
async function convertir(buf, destino) {
  const meta = await sharp(buf).metadata();
  const anchoUtil = Math.floor(Math.min(meta.width, meta.height / RATIO));
  const W = Math.min(ANCHO, anchoUtil);
  const H = Math.round(W * RATIO);
  await sharp(buf)
    .resize({ width: W, height: H, fit: "cover", position: "top" })
    .webp({ quality: CALIDAD, alphaQuality: 100, effort: 6 })
    .toFile(destino);
  return { W, H };
}

/* ------------------------------------------------------------------ *
 * PASO 5. EL MANIFIESTO, LEÍDO DEL DISCO
 * ------------------------------------------------------------------ */

/**
 * Lo que de verdad hay en public/sobres, que es lo único que la aplicación
 * puede pedir. Cuenta 1.webp, 2.webp… hasta el primer hueco: el contrato de
 * utils/sobreArte.ts es que las variantes van seguidas desde 1.
 */
function manifiestoDesdeDisco(carpetaRaiz) {
  const m = {};
  if (!existsSync(carpetaRaiz)) return m;
  for (const d of readdirSync(carpetaRaiz, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    let n = 0;
    while (existsSync(join(carpetaRaiz, d.name, `${n + 1}.webp`))) n++;
    if (n > 0) m[d.name] = { variantes: n };
  }
  const ordenado = {};
  for (const k of Object.keys(m).sort()) ordenado[k] = m[k];
  return ordenado;
}

/**
 * Cuántas variantes tiene AHORA una expansión en el disco: 1.webp, 2.webp…
 * hasta el primer hueco. Es la misma cuenta que hace `manifiestoDesdeDisco`, y
 * es lo que el paso 4 se compromete a no perder.
 */
function variantesEnDisco(dir) {
  let n = 0;
  while (existsSync(join(dir, `${n + 1}.webp`))) n++;
  return n;
}

/* ------------------------------------------------------------------ *
 * PASO 5 BIS. SUSTITUIR SIN BORRAR
 * ------------------------------------------------------------------ *
 *
 * Las tres funciones de aquí abajo existen por una sola razón: que entre "había
 * una foto buena" y "hay una foto nueva" no exista ningún instante en el que no
 * haya ninguna. El porqué largo está en la cabecera del paso 4.
 */

/**
 * ¿Lo que acaba de escribir `convertir` es de verdad la foto que se pidió?
 *
 * Se vuelve a abrir el fichero del disco —no el buffer del que salió— porque lo
 * que se va a copiar a public/sobres es el fichero: un disco lleno o un proceso
 * cortado dejan un WebP a medias que `toFile` no siempre denuncia. Devuelve el
 * peso, que `sustituir` usa para comprobar la copia.
 */
async function comprobarFoto(fichero, W, H) {
  const bytesDelFichero = readFileSync(fichero);
  if (bytesDelFichero.length === 0) throw new Error("el WebP convertido está vacío");
  const meta = await sharp(bytesDelFichero).metadata();
  if (meta.format !== "webp" || meta.width !== W || meta.height !== H) {
    throw new Error(`el WebP convertido no es el esperado (${meta.format} ${meta.width}x${meta.height}, se pidió webp ${W}x${H})`);
  }
  return bytesDelFichero.length;
}

/**
 * Coloca el juego nuevo de una expansión encima del viejo.
 *
 * EN DOS TIEMPOS, y el orden es el arreglo: primero se copian TODAS al lado de
 * su destino con nombre provisional y se comprueba que cada copia pesa lo que
 * debe; sólo cuando están todas se renombran encima. Copiar puede fallar (disco
 * lleno, permisos); renombrar dentro de la misma carpeta, casi nunca. Así un
 * fallo deja las fotos de antes intactas y, como mucho, algún `N.webp.nuevo`
 * suelto que el manifiesto no cuenta y la siguiente pasada vuelve a escribir.
 *
 * `renameSync` sobre un nombre que existe lo REEMPLAZA de una vez (en Windows
 * también): no hay un "borro y luego pongo".
 */
function sustituir(dir, preparadas) {
  mkdirSync(dir, { recursive: true });
  const provisionales = preparadas.map((p, k) => {
    const provisional = join(dir, `${k + 1}.webp.nuevo`);
    copyFileSync(p.fichero, provisional);
    const copiado = statSync(provisional).size;
    if (copiado !== p.peso) throw new Error(`la copia de ${k + 1}.webp pesa ${copiado} bytes y el original ${p.peso}`);
    return provisional;
  });
  provisionales.forEach((provisional, k) => renameSync(provisional, join(dir, `${k + 1}.webp`)));
}

/**
 * Escribe un fichero de texto sin pasar por el estado "truncado y a medias":
 * `writeFileSync` vacía el destino antes de escribir, y si el proceso muere ahí
 * el manifiesto se queda en un JSON roto. Se escribe al lado y se renombra.
 */
function escribirEntero(fichero, texto) {
  const provisional = fichero + ".nuevo";
  writeFileSync(provisional, texto);
  renameSync(provisional, fichero);
}

/* ================================================================== *
 * PROGRAMA
 * ================================================================== */

console.log("Bulbapedia -> " + DESTINO);
console.log("Caché:  " + CACHE);
if (SOLO_INFORME) {
  console.log("MODO INFORME: no se baja ninguna foto ni se escribe nada en el repositorio.");
  if (!tiene("--solo-informe")) console.log("  (es lo que hace por defecto; para escribir de verdad, añade --aplicar)");
  console.log("");
} else console.log("");

/* --- Orden: de la más nueva a la más vieja. Si el tope de peso corta, corta
 *     por las que menos se abren. --- */
const enOrden = [...sets].sort((a, b) => String(b.releaseDate).localeCompare(String(a.releaseDate)));

/* --- Qué carpetas NO son mías: existen en public/sobres y no las bajé yo. --- */
const ajenas = new Set();
if (existsSync(DESTINO)) {
  for (const d of readdirSync(DESTINO, { withFileTypes: true })) {
    if (d.isDirectory() && !GENERADO_ANTES[d.name]) ajenas.add(d.name);
  }
}

/* --- Paso 1: las páginas. --- */
const titulosPorSet = new Map();
for (const s of enOrden) {
  // `tituloDePagina` devuelve null para las marcadas `omitir`, que es lo mismo
  // que hacía el `continue` que había aquí. La diferencia es que ahora el cron
  // decide el título con esta misma función y no con una copia suya.
  const titulo = tituloDePagina(s, MANUAL[s.id]);
  if (titulo) titulosPorSet.set(s.id, titulo);
}
console.log("Consultando páginas...");
const paginas = await ficherosDePaginas([...new Set(titulosPorSet.values())]);

/* --- Paso 2: las candidatas de cada expansión. --- */
const sinSobre = [];   // {id, nombre, motivo}
const planes = [];     // {set, pagina, candidatas[]}

for (const s of enOrden) {
  const man = MANUAL[s.id] ?? {};
  if (man.omitir) {
    sinSobre.push({ id: s.id, nombre: s.name, motivo: "omitida a mano: " + (man.motivo ?? "sin motivo escrito") });
    continue;
  }
  if (ajenas.has(s.id)) {
    sinSobre.push({ id: s.id, nombre: s.name, motivo: "public/sobres/" + s.id + " ya existe y no la bajé yo (manda la de la persona)" });
    continue;
  }

  const titulo = titulosPorSet.get(s.id);
  const pag = paginas.get(titulo);
  if (!pag?.existe) {
    sinSobre.push({ id: s.id, nombre: s.name, motivo: `no hay página "${titulo}" en Bulbapedia` });
    continue;
  }

  /* Prefijos, filtro de nombre, deduplicado por dibujo, orden estable y corte:
   * todo eso era código suelto aquí y ahora lo hace `candidatasDe`. Lo que se
   * ganó al mudarlo no es brevedad —son las mismas líneas en otro sitio— sino
   * que el orden, que es la parte que menos parece importar, sea LITERALMENTE
   * el mismo en el cron: la variante 1 de una expansión tiene que ser la misma
   * foto aquí y allí, porque ese número acaba en la URL y en el CDN. */
  const candidatas = candidatasDe(s, pag.ficheros, pag.titulo, man);

  if (candidatas.length === 0) {
    sinSobre.push({
      id: s.id,
      nombre: s.name,
      motivo: `"${pag.titulo}" (${pag.ficheros.length} ficheros) no tiene ninguno que parezca su sobre`,
    });
    continue;
  }
  planes.push({ set: s, pagina: pag.titulo, candidatas });
}

/* --- Un fichero, una expansión. Si dos se lo pelean, ninguna se lo lleva. --- */
const duenoDe = new Map();
for (const plan of planes) {
  for (const c of plan.candidatas) {
    const previo = duenoDe.get(c.titulo);
    if (previo && previo !== plan.set.id) duenoDe.set(c.titulo, "__PELEA__");
    else duenoDe.set(c.titulo, plan.set.id);
  }
}
const peleados = [...duenoDe.entries()].filter(([, v]) => v === "__PELEA__").map(([k]) => k);
for (const plan of planes) {
  plan.candidatas = plan.candidatas.filter((c) => duenoDe.get(c.titulo) !== "__PELEA__");
}

/* --- Paso 3: tamaños. --- */
console.log("\nConsultando tamaños...");
const todosLosFicheros = [...new Set(planes.flatMap((p) => p.candidatas.map((c) => c.titulo)))];
const info = await infoDeFicheros(todosLosFicheros);

/* --- Paso 4: bajar, convertir y —sólo si todo sale bien— sustituir. ---
 *
 * AQUÍ ESTABA EL FALLO GORDO DE ESTE SCRIPT, y conviene dejar escrito cuál era
 * para que nadie lo "simplifique" de vuelta. Antes, por cada expansión:
 *
 *   1. se BORRABAN los 1.webp, 2.webp… que ya había en public/sobres/<id>;
 *   2. se intentaba bajar las nuevas;
 *   3. si fallaban todas, se borraba la carpeta entera;
 *   4. y el manifiesto y el registro se reescribían con lo que quedase.
 *
 * O sea que el estado bueno se destruía ANTES de tener con qué reemplazarlo.
 * Un día con la wiki contestando 429 o 503 —o sin red, o con --refrescar y la
 * caché vacía— vaciaba las 130 carpetas, que además están commiteadas, y dejaba
 * la tienda entera con el sobre dibujado. Con fallos parciales, una expansión
 * de 3 variantes se quedaba en 1.
 *
 * LA REGLA AHORA ES UNA Y NO TIENE EXCEPCIONES: ESTE SCRIPT NO BORRA NADA.
 *
 *   · Las fotos nuevas se preparan en una ANTESALA fuera del repositorio
 *     (<caché>/nuevo/<id>/) y se comprueban una a una (`comprobarFoto`).
 *   · Si la expansión YA TENÍA fotos, sólo se sustituyen cuando el juego nuevo
 *     está ENTERO. Con una sola variante que falle, se queda lo que había y se
 *     dice. Si no tenía ninguna no hay nada que proteger y vale lo que llegue.
 *   · Sustituir es copiar al lado con nombre provisional y renombrar encima
 *     (`sustituir`): el único instante en que una foto buena deja de existir es
 *     el mismo en que la nueva ocupa su nombre.
 *   · Si esta vez salen MENOS variantes que antes, las que sobran NO se quitan:
 *     se quedan, se cuentan en el manifiesto —que se lee del disco— y salen en
 *     el informe con su ruta. Con --retirar-sobrantes se MUEVEN (no se borran)
 *     a <caché>/retiradas/<id>/. Antes se borraban sin preguntar para que no se
 *     viera un 3.webp huérfano; un huérfano es una foto de más de la expansión
 *     correcta, y borrar sin permiso es justo lo que el dueño ha prohibido.
 *   · La carpeta de una expansión no se borra nunca, ni vacía.
 */
console.log("");
const conSobre = [];
const descartes = [];
const sobrantes = []; // líneas del informe: variantes de antes que esta vez no salen
let bytes = 0;
let topeAlcanzado = false;
const generado = {};
/** Para que dos retiradas de la misma variante en días distintos no se pisen. */
const SELLO = new Date().toISOString().replace(/[:.]/g, "-");

for (const plan of planes) {
  const { set: s } = plan;
  const elegidas = [];
  for (const c of plan.candidatas) {
    if (elegidas.length >= MAX_VARIANTES) break;
    const i = info.get(c.titulo);
    // El cedazo de forma también se comparte, y con él los textos del informe:
    // `pasaElFiltro` devuelve null si pasa y el motivo si no.
    const motivo = pasaElFiltro(i);
    if (motivo) {
      descartes.push(`${s.id}: ${c.titulo} — ${motivo}`);
      continue;
    }
    elegidas.push({ ...c, ...i });
  }

  if (elegidas.length === 0) {
    sinSobre.push({ id: s.id, nombre: s.name, motivo: "sus candidatas no pasaron el filtro de forma o tamaño" });
    continue;
  }

  if (topeAlcanzado) {
    sinSobre.push({ id: s.id, nombre: s.name, motivo: `tope de ${TOPE_MB} MB alcanzado antes de llegar a ella` });
    continue;
  }

  if (SOLO_INFORME) {
    conSobre.push({ id: s.id, nombre: s.name, pagina: plan.pagina, ficheros: elegidas.map((e) => e.titulo), kb: 0 });
    generado[s.id] = { pagina: plan.pagina, ficheros: elegidas.map((e) => e.titulo) };
    continue;
  }

  const dir = join(DESTINO, s.id);
  // Lo que hay que proteger. Se mira ANTES de tocar nada y no se vuelve a mirar.
  const habia = variantesEnDisco(dir);

  /* 4a. A LA ANTESALA. Nada de lo que pase aquí dentro toca public/sobres. */
  const antesala = join(CACHE, "nuevo", s.id);
  mkdirSync(antesala, { recursive: true });
  const preparadas = [];
  let fallo = null;
  for (const e of elegidas) {
    try {
      const buf = await bajarImagen(e.url);
      const fichero = join(antesala, `${preparadas.length + 1}.webp`);
      const { W, H } = await convertir(buf, fichero);
      const peso = await comprobarFoto(fichero, W, H);
      preparadas.push({ titulo: e.titulo, fichero, W, H, peso });
    } catch (err) {
      fallo = `${e.titulo} — ${err.message}`;
      descartes.push(`${s.id}: ${fallo}`);
      // Con fotos que proteger, un fallo ya decide que no se sustituye: seguir
      // bajando las demás sería pedirle a la wiki un trabajo que se va a tirar.
      if (habia > 0) break;
    }
  }

  if (preparadas.length === 0 || (habia > 0 && preparadas.length < elegidas.length)) {
    sinSobre.push({
      id: s.id,
      nombre: s.name,
      motivo:
        habia > 0
          ? `no se pudo preparar el juego nuevo completo (${fallo}): NO se ha tocado nada`
          : "todas sus imágenes fallaron al bajar",
    });
    continue;
  }

  /* 4b. SUSTITUIR. El único punto del script que pisa una foto buena. */
  try {
    sustituir(dir, preparadas);
  } catch (err) {
    descartes.push(`${s.id}: no se pudieron colocar las fotos nuevas — ${err.message}`);
    sinSobre.push({
      id: s.id,
      nombre: s.name,
      motivo:
        `falló al colocar las fotos en public/sobres/${s.id} (${err.message}). MÍRALA A MANO: puede haber` +
        " quedado algún *.webp.nuevo y, si falló a mitad del renombrado, variantes nuevas y viejas mezcladas",
    });
    continue;
  }

  let kb = 0;
  const puestos = [];
  for (const p of preparadas) {
    kb += p.peso / 1024;
    bytes += p.peso;
    puestos.push(p.titulo);
    console.log(
      `${s.id.padEnd(12)} ${(puestos.length + ".webp").padEnd(8)} ${String(p.W) + "x" + p.H}`.padEnd(38) +
        (p.peso / 1024).toFixed(0).padStart(5) + " KB   " + p.titulo.replace(/^File:/, ""),
    );
  }

  /* 4c. LO QUE SOBRA de antes (había 3 y ahora salen 2). No se borra: o se
   * queda donde está, o —si se ha pedido— se MUEVE fuera del repositorio. */
  const ficherosDelRegistro = [...puestos];
  if (habia > puestos.length) {
    const titulosDeAntes = GENERADO_ANTES[s.id]?.ficheros ?? [];
    for (let k = habia; k > puestos.length; k--) {
      const viejo = join(dir, `${k}.webp`);
      if (RETIRAR_SOBRANTES) {
        try {
          const retirada = join(CACHE, "retiradas", s.id);
          mkdirSync(retirada, { recursive: true });
          const a = join(retirada, `${SELLO}-${k}.webp`);
          // renameSync y no copiar+borrar: o se mueve entera o no se toca. Si la
          // caché está en otro disco esto falla (EXDEV) y la foto se queda.
          renameSync(viejo, a);
          sobrantes.push(`${s.id}: ${k}.webp de antes MOVIDA a ${a}`);
          continue;
        } catch (err) {
          sobrantes.push(`${s.id}: ${k}.webp de antes no se pudo mover (${err.message}) y SIGUE en ${viejo}`);
        }
      } else {
        sobrantes.push(
          `${s.id}: ${viejo} es de la tanda anterior y SIGUE AHÍ (ahora salen ${puestos.length} variantes y había ${habia}).` +
            " Se seguirá viendo como una variante más; con --retirar-sobrantes se mueve a la caché",
        );
      }
      // La que se queda sigue siendo de esta expansión y el registro lo dice: el
      // cron (services/sobresIngest.ts) usa esta lista para saber qué fichero de
      // la wiki está ya adjudicado.
      const titulo = titulosDeAntes[k - 1];
      if (titulo && !ficherosDelRegistro.includes(titulo)) ficherosDelRegistro.push(titulo);
    }
  }

  conSobre.push({ id: s.id, nombre: s.name, pagina: plan.pagina, ficheros: puestos, kb });
  generado[s.id] = { pagina: plan.pagina, ficheros: ficherosDelRegistro };
  if (bytes / 1024 / 1024 >= TOPE_MB) topeAlcanzado = true;
}

/* --- LO QUE TENÍA FOTO Y NO SE HA REGENERADO SIGUE SIENDO DE ESTE SCRIPT. ---
 *
 * Antes el registro "generado" se reescribía sólo con lo bajado EN ESTA
 * ejecución. Una expansión que hoy fallaba (o a la que no se llegaba por el tope
 * de peso) desaparecía del registro con su carpeta todavía en el disco, y a la
 * siguiente pasada el script la tomaba por ajena —"ya existe y no la bajé yo"—
 * y no volvía a actualizarla nunca. Y el cron perdía de vista que esos ficheros
 * de la wiki ya estaban adjudicados. Mientras las fotos sigan en el disco, su
 * entrada se conserva tal cual.
 *
 * De paso, esto separa en el informe dos cosas que no son la misma: una
 * expansión SIN SOBRE (no tiene foto: hay que mirarla) y una que SE QUEDA COMO
 * ESTABA (tiene la de antes: no hay prisa). */
const regeneradas = new Set(conSobre.map((c) => c.id));
const motivoDe = new Map(sinSobre.map((x) => [x.id, x.motivo]));
const seQuedan = []; // {id, variantes, motivo}
for (const [id, entrada] of Object.entries(GENERADO_ANTES)) {
  if (regeneradas.has(id)) continue;
  const variantes = variantesEnDisco(join(DESTINO, id));
  if (variantes === 0) continue; // la carpeta ya no está: no hay nada que conservar
  generado[id] = entrada;
  seQuedan.push({ id, variantes, motivo: motivoDe.get(id) ?? "ya no está en src/data/all-sets.json" });
}
const idsQueSeQuedan = new Set(seQuedan.map((x) => x.id));

/* --- Paso 5: manifiesto y registro. --- */
if (!SOLO_INFORME) {
  const manifiesto = manifiestoDesdeDisco(DESTINO);
  escribirEntero(MANIFIESTO, JSON.stringify(manifiesto, null, 2) + "\n");

  const ordenado = {};
  for (const k of Object.keys(generado).sort()) ordenado[k] = generado[k];
  // "manual" se vuelve a escribir TAL CUAL: es de una persona y este script no
  // opina sobre ella.
  escribirEntero(MAPA, JSON.stringify({ manual: MANUAL, generado: ordenado }, null, 2) + "\n");
}

/* ------------------------------------------------------------------ *
 * INFORME
 * ------------------------------------------------------------------ */

console.log("\n" + "=".repeat(72));
console.log(`CON SOBRE${SOLO_INFORME ? " (lo que se bajaría)" : " NUEVO"}: ${conSobre.length} expansiones`);
console.log("=".repeat(72));
for (const c of conSobre) {
  console.log(`  ${c.id.padEnd(12)} ${c.nombre.padEnd(34)} ${c.ficheros.length} var  ${c.kb.toFixed(0).padStart(4)} KB`);
}

/* En simulación `conSobre` es todo lo que se INTENTARÍA bajar, así que esta
 * lista sale corta: sólo trae lo que ni se intentaría. Las que fallen al bajar
 * de verdad aparecen aquí al aplicar. */
if (seQuedan.length > 0) {
  console.log("\n" + "=".repeat(72));
  console.log(`SE QUEDAN COMO ESTABAN: ${seQuedan.length} expansiones — tienen la foto de antes y no se ha tocado`);
  console.log("=".repeat(72));
  for (const q of seQuedan.sort((a, b) => a.id.localeCompare(b.id))) {
    console.log(`  ${q.id.padEnd(12)} ${String(q.variantes).padStart(2)} var  ${q.motivo}`);
  }
  console.log("\nEste script no borra fotos. Si una de éstas SOBRA (por ejemplo, la has marcado");
  console.log('"omitir" porque el sobre era de otra expansión), retira tú su carpeta de public/sobres');
  console.log("y vuelve a ejecutar: el manifiesto se cuenta del disco.");
}

const sinFoto = sinSobre.filter((s) => !idsQueSeQuedan.has(s.id));
console.log("\n" + "=".repeat(72));
console.log(`SIN SOBRE: ${sinFoto.length} expansiones — hay que mirarlas a mano`);
console.log("=".repeat(72));
for (const s of sinFoto.sort((a, b) => a.id.localeCompare(b.id))) {
  console.log(`  ${s.id.padEnd(12)} ${s.nombre.padEnd(34)} ${s.motivo}`);
}
console.log("\nPara arreglar una: añádela a \"manual\" en src/data/sobres-bulbapedia.json");
console.log('  "<id>": { "pagina": "<título en Bulbapedia>", "prefijos": ["<como empieza el fichero>"] }');
console.log('  o { "omitir": true, "motivo": "..." } si de verdad no tuvo sobre propio.');

if (peleados.length > 0) {
  console.log("\nFICHEROS QUE SE PELEABAN DOS EXPANSIONES (no se los ha quedado ninguna):");
  for (const f of peleados) console.log("  " + f);
}

if (descartes.length > 0) {
  console.log(`\nCANDIDATAS DESCARTADAS (${descartes.length}):`);
  for (const d of descartes) console.log("  " + d);
}

if (sobrantes.length > 0) {
  console.log(`\nVARIANTES DE ANTES QUE ESTA VEZ NO SALEN (${sobrantes.length}) — no se ha borrado ninguna:`);
  for (const l of sobrantes) console.log("  " + l);
}

const totalDisco = existsSync(DESTINO)
  ? readdirSync(DESTINO, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .flatMap((d) => readdirSync(join(DESTINO, d.name)).map((f) => readFileSync(join(DESTINO, d.name, f)).length))
      .reduce((a, b) => a + b, 0)
  : 0;

console.log("\n" + "=".repeat(72));
console.log(
  SOLO_INFORME
    ? `Se bajarían:    ${conSobre.reduce((a, c) => a + c.ficheros.length, 0)} imágenes (simulación: no se ha escrito nada; añade --aplicar)`
    : `Bajado ahora:   ${(bytes / 1024 / 1024).toFixed(2)} MB en ${conSobre.reduce((a, c) => a + c.ficheros.length, 0)} imágenes`,
);
console.log(`public/sobres:  ${(totalDisco / 1024 / 1024).toFixed(2)} MB en total (incluye las que puso preparar-sobres.mjs)`);
if (topeAlcanzado) console.log(`AVISO: se alcanzó el tope de ${TOPE_MB} MB y quedaron expansiones sin bajar.`);
console.log("=".repeat(72));
