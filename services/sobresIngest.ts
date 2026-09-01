/**
 * INGESTA DE FOTOS DE SOBRE: Bulbapedia -> Postgres.
 *
 * ============================================================================
 * QUÉ RESUELVE
 * ============================================================================
 *
 * `app/api/cron/sync-sets` mete expansiones nuevas cada noche él solo, y las
 * fotos de sus sobres las baja `scripts/bajar-sobres-bulbapedia.mjs`, que
 * alguien tiene que ejecutar A MANO. O sea que una expansión recién salida
 * llegaba SIEMPRE sin foto — y es justo la que más se abre. Esto lo automatiza.
 *
 * NO PUEDE ESCRIBIR EN public/sobres, y ése es el hecho que decide el diseño
 * entero: en Vercel `public/` es de sólo lectura en ejecución y además
 * utils/sobreArte.ts importa el manifiesto en tiempo de COMPILACIÓN. Así que
 * las fotos nuevas van a Postgres y la aplicación las lee de ahí, que es el
 * mismo camino que ya recorrieron las traducciones y los precios.
 *
 * ESTÁ CALCADO DE services/idiomaIngest.ts a propósito: presupuesto de tiempo,
 * reanudable, cola por `revisado_en` y resumen. Si aquél cambia de forma, éste
 * debería seguirle.
 *
 * ============================================================================
 * EL EMPAREJAMIENTO NO ESTÁ AQUÍ, Y ES LO MÁS IMPORTANTE DE ESTE FICHERO
 * ============================================================================
 *
 * Decidir QUÉ fichero de la wiki es el sobre de QUÉ expansión vive en
 * services/sobresEmparejar.ts, compartido con el script. NO SE COPIA. Si se
 * copiara, las dos versiones se separarían, y la consecuencia de que se separen
 * no es un error sino UN SOBRE EN LA EXPANSIÓN EQUIVOCADA: el que falta se ve
 * —queda el sobre dibujado— y el equivocado no lo mira nadie dos veces.
 *
 * Lo único que este fichero decide por su cuenta es LA UNICIDAD, porque no
 * puede hacer otra cosa: el script junta las candidatas de las 171 expansiones
 * y descarta las que dos se pelean, y aquí se ven seis como mucho. Se hace en
 * dos capas —el empate entre las de esta noche (paso 2b, con la regla del
 * script tal cual) y lo ya adjudicado (`yaEsDeOtra`, donde no se puede)— y las
 * dos tienen escrito lo que se pierde. Debajo queda el índice único.
 *
 * ============================================================================
 * SER BUEN VECINO DE UNA WIKI QUE SE PAGA CON DONACIONES
 * ============================================================================
 *
 *   · User-Agent que identifica el proyecto (lo pide la etiqueta de MediaWiki).
 *   · Varios títulos por petición: una noche entera son DOS peticiones a la API
 *     pase lo que pase, más las descargas de las fotos que de verdad se queden.
 *   · `maxlag`: si sus bases de datos van retrasadas, que nos manden a esperar.
 *   · Un 429 se respeta DE VERDAD, que aquí significa parar hasta mañana y no
 *     dormir y reintentar: no hay prisa ninguna, el sobre dibujado ya está.
 *   · Se piden MINIATURAS (`iiurlwidth`) y no los originales de 1,7 MB.
 *   · Y sobre todo: NO SE REPREGUNTA. De las 171 expansiones, 130 ya tienen
 *     foto estática y ni se miran, y de las 41 restantes ninguna va a tener
 *     sobre nunca (promos, Trainer Gallery, Shiny Vault, kits, energías,
 *     McDonald's, POP Series). El negativo se guarda con su motivo igual que el
 *     positivo. Sin eso serían 40 peticiones diarias eternas para un trabajo
 *     útil de tres peticiones al mes. Los plazos están en DIAS_PARA_REPREGUNTAR
 *     (services/sobresEsquema.ts), con los números.
 *
 * ============================================================================
 * SI FALLA, NO PASA NADA
 * ============================================================================
 *
 * El sobre dibujado en CSS es el respaldo y está pensado exactamente para esto
 * (sección 6 de utils/sobreArte.ts). Una wiki caída, un timeout o un
 * emparejamiento dudoso dejan la expansión CON SU SOBRE DIBUJADO y una línea en
 * el log. Nunca un hueco, nunca una excepción que suba hasta la página.
 *
 * Y CON UNA REGLA MÁS, QUE ES LA QUE FALTABA: fallar no puede COSTAR NADA a
 * futuro. Un negativo de 180 días sólo se escribe cuando la wiki ha contestado
 * de verdad; si no contestó, se escribe ESTADOS_SOBRE.ERROR, que vale un día. La
 * regla entera, con el caso concreto que se rompía, está en el bloque grande de
 * `sincronizarSobres`.
 */
import { sql } from "@vercel/postgres";
import mapaBulbapedia from "../src/data/sobres-bulbapedia.json";
import { tieneIlustracionEstatica } from "../utils/sobreArte";
import { olvidarVariantesDeSobre } from "./sobresBD";
import {
  MAX_VARIANTES,
  acumularPaginas,
  candidatasDe,
  pasaElFiltro,
  resolverPaginas,
  tituloDePagina,
  type Candidata,
  type EntradaManual,
  type PaginaDeSobre,
  type SetParaSobre,
} from "./sobresEmparejar";
import {
  DIAS_PARA_REPREGUNTAR,
  DIAS_PARA_REPREGUNTAR_RECIENTE,
  DIAS_RECIENTE,
  ESTADOS_SOBRE,
  MIMES_SOBRE,
  SENTENCIAS_SOBRES,
  type EstadoSobre,
} from "./sobresEsquema";

/* ------------------------------------------------------------------ *
 * CONSTANTES
 * ------------------------------------------------------------------ */

const API = "https://bulbapedia.bulbagarden.net/w/api.php";

/** Que se sepa quién llama y a quién quejarse. Lo pide la etiqueta de MediaWiki. */
const AGENTE =
  "PokemonTCGSimulator-sobres/1.0 (simulador de sobres, proyecto personal sin ánimo de lucro; cron nocturno)";

/** Ancho de la miniatura que se pide. El sobre se pinta a ~280 px, así que 560
 *  es exactamente 2x: la densidad de la inmensa mayoría de las pantallas.
 *  Mismo número que el script, y a propósito. */
const ANCHO = 560;

/**
 * Cuántas expansiones se miran por noche.
 *
 * En régimen permanente esto sobra por mucho: salen 6-10 expansiones al año.
 * El número existe por el ARRANQUE, cuando la tabla está vacía y hay 41
 * expansiones sin clasificar; a 6 por noche, la cola se vacía en una semana y
 * después se queda dormida para siempre. Subirlo no acelera nada en régimen y
 * sí hace más gorda la única petición de la noche.
 */
const LOTE_SETS = 6;

/** Pausa entre peticiones a la API. La misma que el script, aunque aquí sean
 *  dos por noche y allí cuatrocientas: la cortesía no se descuenta por volumen. */
const PAUSA_API = 900;
/** Pausa entre descargas de imagen (ficheros estáticos, se puede ir algo más rápido). */
const PAUSA_IMG = 350;

/** Corte de cada petición. Por encima de esto la wiki no va a contestar a
 *  tiempo de nada y el presupuesto entero se lo come una sola llamada. Nunca
 *  es el corte de verdad: el de verdad es el MENOR entre esto y lo que quede
 *  de presupuesto (ver `pedirApi`), porque si no una sola llamada lenta se
 *  come el tramo entero y de paso el de los precios. */
const TIMEOUT_MS = 6_000;

/**
 * Por debajo de esto ni se intenta una petición.
 *
 * No es prudencia: una petición lanzada con 800 ms por delante va a expirar
 * casi seguro, y una expiración cuesta el tiempo que queda Y una anotación de
 * "no se pudo" que hay que ir a mirar. Vale más terminar diciendo "no me dio
 * tiempo", que es reanudable y no ensucia nada.
 */
const MINIMO_PETICION_MS = 2_000;

/** Margen para cerrar y responder sin que la función muera a mitad de un
 *  INSERT. Mismo criterio que MARGEN_OLEADA_MS en services/idiomaIngest.ts. */
const MARGEN_MS = 1_500;

/** Rondas de `continue` que se persiguen en el paso 1. El script llega a 8;
 *  aquí, con seis títulos y un presupuesto de segundos, la tercera ya no cabe.
 *  Quedarse corto NO se anota como negativo: ver `ficherosDePaginas`. */
const RONDAS_MAX = 2;

/** Redirecciones que se siguen al bajar una foto, revalidando el host en cada
 *  salto. Dos sobran: la wiki sirve el fichero directo o con un salto. */
const SALTOS_MAX = 2;

/**
 * Tope de bytes por foto.
 *
 * ============================================================================
 * ESTE NÚMERO ESTABA MAL Y DEJABA LA FUNCIÓN INÚTIL PARA LO QUE SE PIDIÓ
 * ============================================================================
 *
 * Valía 400 KB, con el comentario "una miniatura de 560 px pesa 30-120 KB, 400
 * es holgado". Eso es cierto de los escaneos viejos, que son JPEG, y FALSO
 * desde que los sobres se suben en PNG con transparencia. Medido sobre las 363
 * miniaturas que el script tiene en caché, pedidas a la misma URL
 * (`iiurlwidth=560`) que pide esto:
 *
 *     mediana 138 KB · percentil 90 888 KB · máximo 1.287 KB
 *     por encima de 400 KB: 63 de 363 (17,4%)
 *
 * Y no repartidas al azar: 21 expansiones tienen TODAS sus fotos por encima de
 * 400 KB, y son la era moderna entera —sv1…sv10, zsv10pt5, rsv10pt5, me1, me2,
 * me2pt5—, o sea justo las que este cron existe para traer. Con el tope viejo,
 * `bajarImagen` devolvía null, el bucle anotaba FILTRO_FORMA y la expansión se
 * quedaba 180 días con el sobre dibujado y un log que decía "no se pudo bajar",
 * que suena a la wiki y era nuestro.
 *
 * 2 MB deja pasar el máximo medido con holgura y sigue siendo una red de
 * seguridad de verdad: el original de un sobre son 1,7 MB, así que un fichero
 * por encima de esto sólo puede ser la wiki devolviendo el original en vez de
 * la miniatura, que es exactamente lo que este tope existe para cazar.
 *
 * LO QUE CUESTA, dicho claro: una expansión moderna son ~2,7 MB en tres filas
 * de Postgres, y salen 6-10 al año. El CDN sirve cada foto una vez por región y
 * el navegador se la queda un día (app/api/arte-sobre). Se acepta a sabiendas.
 *
 * NO SE ARREGLA PIDIENDO UNA MINIATURA MÁS ESTRECHA, aunque parezca lo obvio, y
 * está comprobado: la wiki NO genera miniaturas de anchos que no tenga ya
 * hechos. `iiurlwidth=380` devuelve una `thumburl` con toda la cara de valer y
 * esa URL responde 404 (probado con File:SV8 Booster Pikachu.png, dos veces);
 * la de 560 responde 200. Cambiar ANCHO sería cambiar fotos grandes por
 * ninguna foto.
 */
const MAX_BYTES = 2 * 1024 * 1024;

/* ------------------------------------------------------------------ *
 * EL MAPA A MANO
 * ------------------------------------------------------------------ */

/**
 * src/data/sobres-bulbapedia.json, el mismo fichero que usa el script.
 *
 * SE IMPORTA AQUÍ Y SE PASA POR PARÁMETRO al módulo de emparejamiento, que no
 * importa nada: aquél tiene que poder cargarse desde un `.mjs` con el cargador
 * de scripts/test-invariantes.mjs, y ese cargador no sabe resolver JSON. La
 * regla está escrita en su cabecera.
 *
 * `manual` es de una persona y dice dónde vive la página de una expansión
 * cuando "<nombre> (TCG)" no vale, o que no tuvo sobre. `generado` es lo que el
 * script bajó la última vez que alguien lo ejecutó, y aquí se usa SÓLO para la
 * unicidad (ver `yaEsDeOtra`).
 */
const MAPA = mapaBulbapedia as {
  manual?: Record<string, EntradaManual | undefined>;
  generado?: Record<string, { pagina?: string; ficheros?: string[] } | undefined>;
};
const MANUAL = MAPA.manual ?? {};

/**
 * Índice inverso de `generado`: título de fichero -> expansión que se lo quedó.
 * Se construye una vez al cargar el módulo; son 130 entradas con hasta 3
 * ficheros cada una.
 */
const DUENO_ESTATICO: ReadonlyMap<string, string> = (() => {
  const m = new Map<string, string>();
  for (const [setId, entrada] of Object.entries(MAPA.generado ?? {})) {
    for (const f of entrada?.ficheros ?? []) if (!m.has(f)) m.set(f, setId);
  }
  return m;
})();

/* ------------------------------------------------------------------ *
 * TIPOS
 * ------------------------------------------------------------------ */

export interface ResumenSobres {
  /** Expansiones que se han mirado esta noche. */
  revisados: string[];
  /** Las que se han quedado con foto, con cuántas variantes y de dónde. */
  nuevos: { setId: string; variantes: number; pagina: string }[];
  /** Las que no, con el motivo. Se guardan en la tabla para no repreguntar. */
  sinSobre: { setId: string; estado: EstadoSobre; motivo: string }[];
  /** Cuántas había en la cola y no se han llegado a mirar. */
  pendientes: number;
  truncadoPorTiempo: boolean;
  errores: string[];
}

interface FilaCola {
  id: string;
  name: string;
  estado: string | null;
  revisadoEn: number | null;
}

const DIA_MS = 24 * 60 * 60 * 1000;

interface InfoFichero {
  url: string | null;
  /** Del ORIGINAL: es con lo que filtra el script, y hay que filtrar igual. */
  ancho: number | null;
  alto: number | null;
  /** De la MINIATURA, que es lo que de verdad se guarda. */
  anchoThumb: number | null;
  altoThumb: number | null;
}

/**
 * Lo que se lee de una respuesta de la API de MediaWiki. Está escrito a mano y
 * no como `any` porque estos campos vienen de un tercero: si mañana la wiki
 * deja de mandar `thumbwidth`, prefiero que el compilador me obligue a mirar
 * qué pasa con el recorte antes que enterarme por un sobre torcido.
 *
 * Todo opcional a propósito: la API omite lo que no aplica (una página que no
 * existe no trae `images`, un fichero más estrecho que la miniatura pedida no
 * trae `thumburl`) y el código de abajo lo trata caso a caso.
 */
interface RespuestaWiki {
  error?: { code?: string; info?: string };
  continue?: Record<string, string>;
  query?: {
    normalized?: { from?: string; to?: string }[];
    redirects?: { from?: string; to?: string }[];
    pages?: {
      title?: string;
      missing?: boolean;
      images?: { title?: string }[];
      imageinfo?: {
        url?: string;
        thumburl?: string;
        width?: number;
        height?: number;
        thumbwidth?: number;
        thumbheight?: number;
        mime?: string;
      }[];
    }[];
  };
}

/* ------------------------------------------------------------------ *
 * ESQUEMA
 * ------------------------------------------------------------------ */

let tablasListas: Promise<void> | null = null;

/**
 * Las tablas, memoizadas por instancia. Van aquí y no en el `ensureSchema` de
 * app/action.ts por el criterio que fija services/esquemaMejoras.ts: una tabla
 * que sólo escribe un cron se asegura en el módulo del cron. `ensureSchema` se
 * espera antes de CADA compra de sobre y no se le carga trabajo que no le toca;
 * la lectura (services/sobresBD.ts) degrada a silencio si no existen todavía.
 *
 * El fallo NO se cachea, para que el siguiente intento vuelva a probar.
 */
function asegurarTablas(): Promise<void> {
  if (!tablasListas) {
    tablasListas = (async () => {
      for (const sentencia of SENTENCIAS_SOBRES) await sql.query(sentencia);
    })().catch((e) => {
      tablasListas = null;
      throw e;
    });
  }
  return tablasListas;
}

/* ------------------------------------------------------------------ *
 * LA WIKI
 * ------------------------------------------------------------------ */

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * EL ESTADO DE UNA PASADA, y por qué viaja como argumento en vez de vivir en
 * el módulo.
 *
 * Son dos cosas y las dos son de ESTA pasada, no del proceso:
 *
 *   · `fin`: el instante en el que hay que haber terminado. Existe para que
 *     NINGUNA petición pueda durar más que el presupuesto que queda. Antes el
 *     corte era fijo (6 s) y el reloj sólo se miraba en el paso 4, así que en
 *     el peor caso el tramo gastaba ~21 s de un presupuesto de 6-10: se comía
 *     la reserva de los precios y dejaba a Cardmarket sin turno esa noche, que
 *     es justo la inversión de prioridades que app/api/cron/sync-es dice
 *     impedir. Ahora cada llamada se corta con `min(TIMEOUT_MS, lo que queda)`.
 *
 *   · `parar`: la wiki ha pedido que paremos (429 o maxlag). No se reintenta:
 *     se acaba la noche. Es la diferencia entre el script —que tiene todo el
 *     tiempo del mundo y puede dormir cuatro segundos— y un cron con diez:
 *     dormir dentro del presupuesto sería gastarlo entero en esperar, y
 *     reintentar es lo contrario de lo que pide un 429.
 *
 * Era una variable de módulo y se ha traído aquí: si dos pasadas coincidían en
 * la misma instancia (el cron de la noche y alguien disparando `?setId=` a la
 * vez), la bandera de una paraba a la otra. Con el reloj eso habría sido peor
 * que una molestia —una pasada le habría acortado las peticiones a la otra—,
 * así que las dos van juntas y por parámetro.
 */
interface Pasada {
  fin: number;
  parar: boolean;
}

/** Cuántos ms quedan antes de tener que cerrar. Puede salir negativo. */
function restan(p: Pasada): number {
  return p.fin - Date.now();
}

/**
 * Lo que devuelve una petición a la API.
 *
 * ============================================================================
 * `fallo` NO ES `datos === null`, Y ESA DISTINCIÓN ES MEDIA CORRECCIÓN
 * ============================================================================
 *
 * Antes esto devolvía `RespuestaWiki | null` y `null` valía para todo: un
 * timeout, un 503, un DNS caído y "la wiki ha contestado". Arriba, el paso 2 lo
 * leía como "no existe la página" y anotaba SIN_PAGINA, que son 180 DÍAS SIN
 * VOLVER A MIRAR. O sea que treinta segundos de wiki caída a las 07:00 —y la
 * cola empieza por la expansión más nueva, que es la que importa— quemaban seis
 * expansiones durante medio año, con un log que afirmaba algo falso ("no hay
 * página X en Bulbapedia") y mandaba a quien lo leyera a editar el mapa a mano
 * buscando un problema que no existe.
 *
 * `fallo` significa EXACTAMENTE "esta pregunta se ha quedado sin respuesta
 * fiable". Nunca significa "la wiki ha dicho que no". Con eso, quien llama
 * puede escribir la regla que faltaba: un negativo de meses sólo se anota
 * cuando la wiki ha contestado de verdad.
 */
interface RespuestaApi {
  datos: RespuestaWiki | null;
  fallo: boolean;
}

const SIN_RESPUESTA: RespuestaApi = { datos: null, fallo: true };

/**
 * Una petición a la API. Sin reintentos y con corte de tiempo.
 */
async function pedirApi(p: Pasada, params: Record<string, string>): Promise<RespuestaApi> {
  if (p.parar) return SIN_RESPUESTA;
  const margen = restan(p);
  if (margen < MINIMO_PETICION_MS) return SIN_RESPUESTA;

  const url =
    API +
    "?" +
    new URLSearchParams({ format: "json", formatversion: "2", maxlag: "5", ...params });
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": AGENTE, Accept: "application/json" },
      signal: AbortSignal.timeout(Math.min(TIMEOUT_MS, margen)),
    });
    if (r.status === 429) {
      p.parar = true;
      console.warn("[sync-sobres] la wiki ha respondido 429: se para hasta mañana");
      return SIN_RESPUESTA;
    }
    /* EL 503 VA ANTES QUE `!r.ok`, Y NO ES ORDEN CASUAL. `maxlag` —la cortesía
     * que este cron declara en cada llamada— NO llega como un 200 con un error
     * dentro: MediaWiki responde HTTP 503 con `Retry-After`. Con el `!r.ok`
     * delante, la rama de maxlag de más abajo era código muerto para el único
     * caso que decía cubrir: la wiki nos mandaba a esperar, nosotros no nos
     * enterábamos y hacíamos la siguiente petición. Un 503 sin maxlag (wiki
     * sobrecargada) quiere exactamente lo mismo, así que se tratan igual. */
    if (r.status === 503) {
      p.parar = true;
      const espera = r.headers.get("retry-after");
      console.warn(
        "[sync-sobres] la wiki ha respondido 503 (maxlag o sobrecarga): se para hasta mañana" +
          (espera ? ` (Retry-After: ${espera})` : ""),
      );
      return SIN_RESPUESTA;
    }
    if (!r.ok) return SIN_RESPUESTA;
    const j = (await r.json()) as RespuestaWiki;
    // Se deja por si algún día contesta 200 con el error dentro (lo hacía en
    // versiones viejas de MediaWiki). Barato y no estorba.
    if (j?.error?.code === "maxlag") {
      p.parar = true;
      console.warn("[sync-sobres] maxlag: la wiki va retrasada, se para hasta mañana");
      return SIN_RESPUESTA;
    }
    if (j?.error) return SIN_RESPUESTA;
    return { datos: j, fallo: false };
  } catch {
    return SIN_RESPUESTA;
  }
}

/**
 * `prop=images` de varios títulos de golpe: qué ficheros cuelgan de cada
 * página, siguiendo normalizaciones y redirecciones.
 *
 * Es el paso 1 del script, y lo que hay aquí es SÓLO EL TRANSPORTE: qué se pide,
 * cuántas rondas de `continue` se persiguen y cuándo se para. Interpretar la
 * respuesta —seguir los alias de la wiki y cerrar el mapa PEDIDO -> página— lo
 * hacen `acumularPaginas` y `resolverPaginas` de services/sobresEmparejar.ts,
 * las mismas que usa el script. No puede ser de otra forma: el título final
 * entra en `prefijosDe` como PREFIJO, o sea que decide qué ficheros se aceptan,
 * y dos copias de eso no se separan en un mensaje sino en un emparejamiento.
 *
 * Diferencias reales con el script: aquí no hay caché en disco (no hay disco) y
 * el `continue` se persigue RONDAS_MAX veces en vez de 8, porque con seis
 * títulos y un presupuesto de segundos la tercera ronda no cabe.
 *
 * `fallo` ES LO QUE HAY QUE MIRAR ANTES DE CREERSE UN `existe: false`. Se
 * levanta cuando alguna ronda no contestó, y también cuando quedarse en
 * RONDAS_MAX ha dejado ficheros sin traer: en los dos casos la lista de una
 * página puede estar incompleta, y una lista incompleta es lo que convierte
 * "todavía no han subido la foto" en un negativo de 180 días. Quedarse corto ya
 * no es "el fallo barato": es el fallo caro y silencioso.
 */
async function ficherosDePaginas(
  p: Pasada,
  titulos: readonly string[],
): Promise<{ paginas: Map<string, PaginaDeSobre>; fallo: boolean }> {
  if (titulos.length === 0) return { paginas: new Map(), fallo: false };

  let params: Record<string, string> = {
    action: "query",
    redirects: "1",
    prop: "images",
    imlimit: "500",
    titles: titulos.join("|"),
  };
  const destinoDe = new Map(titulos.map((t) => [t, t]));
  const acumulado = new Map<string, PaginaDeSobre>();
  let fallo = false;

  for (let ronda = 0; ronda < RONDAS_MAX; ronda++) {
    const { datos, fallo: falloRonda } = await pedirApi(p, params);
    if (falloRonda || !datos) {
      fallo = true;
      break;
    }
    acumularPaginas(datos, destinoDe, acumulado);
    if (!datos.continue) break;
    // Queda respuesta por traer y no hay ronda para ella: lo que tenemos está
    // incompleto y no sirve para descartar a nadie.
    if (ronda === RONDAS_MAX - 1) {
      fallo = true;
      break;
    }
    params = { ...params, ...datos.continue };
    await dormir(PAUSA_API);
  }

  return { paginas: resolverPaginas(titulos, destinoDe, acumulado), fallo };
}

/**
 * `iiurlwidth` es la parte amable: en vez del original (1,7 MB de PNG) pide la
 * miniatura ya escalada al ancho que vamos a usar. Y de paso llegan alto y
 * ancho reales, que es con lo que se descarta lo que no tiene forma de sobre
 * SIN BAJARLO.
 *
 * Se guardan las dos medidas. `ancho`/`alto` son las del ORIGINAL, que es con
 * las que filtra el script y por tanto con las que hay que filtrar aquí para
 * que las dos vías decidan igual. `anchoThumb`/`altoThumb` describen los bytes
 * que de verdad se van a guardar, y son las que acaban en la tabla porque son
 * las que la hoja de estilos necesita para recortar.
 */
async function infoDeFicheros(
  p: Pasada,
  titulos: readonly string[],
): Promise<{ info: Map<string, InfoFichero>; fallo: boolean }> {
  const salida = new Map<string, InfoFichero>();
  if (titulos.length === 0) return { info: salida, fallo: false };

  const { datos, fallo } = await pedirApi(p, {
    action: "query",
    prop: "imageinfo",
    iiprop: "url|size|mime",
    iiurlwidth: String(ANCHO),
    titles: titulos.join("|"),
  });
  // Sin respuesta el mapa sale VACÍO, y un mapa vacío hace que `pasaElFiltro`
  // descarte todas las candidatas por "la API no da URL". Eso no es un veredicto
  // sobre la forma de nadie: por eso el fallo sube y quien llama no anota.
  if (fallo || !datos) return { info: salida, fallo: true };

  for (const pag of datos.query?.pages ?? []) {
    const info = pag.imageinfo?.[0];
    if (!pag.title || !info) continue;
    salida.set(pag.title, {
      url: info.thumburl || info.url || null,
      ancho: info.width ?? null,
      alto: info.height ?? null,
      anchoThumb: info.thumbwidth ?? info.width ?? null,
      altoThumb: info.thumbheight ?? info.height ?? null,
    });
  }
  return { info: salida, fallo: false };
}

/** ¿Apunta esto a la wiki y sólo a la wiki? */
function esDeLaWiki(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && /(^|\.)bulbagarden\.net$/.test(u.hostname);
  } catch {
    return false;
  }
}

/**
 * Lo que sale de intentar bajar una foto.
 *
 * `transitorio` separa "este fichero no vale" de "hoy no se ha podido", igual
 * que `fallo` en las peticiones a la API y por lo mismo: lo primero es un
 * negativo que vale meses y lo segundo es un martes por la noche.
 */
interface Bajada {
  buf: Buffer | null;
  motivo: string | null;
  transitorio: boolean;
}

/**
 * Los bytes de una foto.
 *
 * ============================================================================
 * LA LISTA BLANCA DE HOST TIENE QUE SOBREVIVIR A LAS REDIRECCIONES
 * ============================================================================
 *
 * No es paranoia repetida aunque el script tenga la suya: allí esto corre en un
 * portátil y aquí DENTRO DE LA RED DE LA PLATAFORMA, donde un `fetch` a un
 * destino elegido por otro es un problema de otra categoría.
 *
 * Y la versión anterior no la tenía. Validaba la URL de entrada y luego hacía
 * `fetch` con el `redirect: "follow"` de por defecto, así que el destino REAL
 * no se volvía a mirar nunca: bastaba con que la API devolviera una URL de
 * bulbagarden.net que respondiera 302 —MediaWiki sirve `Special:FilePath` y
 * `Special:Redirect/file` exactamente así, y cualquier redirección abierta de
 * ese dominio vale igual— para que la petición acabara donde dijera la wiki.
 * La cabecera prometía la protección que no existía.
 *
 * Ahora `redirect: "manual"`: cada salto se lee, se resuelve contra la URL
 * actual y SE VUELVE A VALIDAR antes de pedirlo. Un destino fuera de
 * Bulbagarden no se pide, no se descarta en silencio: se avisa.
 *
 * EL TOPE DE BYTES SE MIRA ANTES DE BUFFEREAR, con `Content-Length`. Antes se
 * comprobaba después de `arrayBuffer()`, o sea que limitaba lo que se GUARDA y
 * no lo que se mete en memoria de una función serverless. La cabecera puede
 * mentir, así que se comprueba también después: la primera puerta ahorra, la
 * segunda garantiza.
 */
async function bajarImagen(p: Pasada, url: string): Promise<Bajada> {
  let actual = url;

  for (let salto = 0; salto <= SALTOS_MAX; salto++) {
    if (!esDeLaWiki(actual)) {
      console.warn("[sync-sobres] URL fuera de Bulbagarden, no se baja:", actual);
      return { buf: null, motivo: "la URL no apunta a Bulbagarden", transitorio: false };
    }
    if (p.parar) return { buf: null, motivo: "la wiki pidió parar", transitorio: true };
    const margen = restan(p);
    if (margen < MINIMO_PETICION_MS) {
      return { buf: null, motivo: "no daba tiempo a bajarla", transitorio: true };
    }

    try {
      const r = await fetch(actual, {
        headers: { "User-Agent": AGENTE },
        redirect: "manual",
        signal: AbortSignal.timeout(Math.min(TIMEOUT_MS, margen)),
      });

      if (r.status === 429) {
        p.parar = true;
        console.warn("[sync-sobres] 429 al bajar una foto: se para hasta mañana");
        return { buf: null, motivo: "la wiki respondió 429", transitorio: true };
      }
      if (r.status >= 300 && r.status < 400) {
        const destino = r.headers.get("location");
        if (!destino) {
          return { buf: null, motivo: `HTTP ${r.status} sin destino`, transitorio: false };
        }
        // Relativa admitida: se resuelve contra la URL de la que vino, y el
        // bucle la revalida arriba antes de pedirla.
        actual = new URL(destino, actual).toString();
        continue;
      }
      if (!r.ok) {
        return {
          buf: null,
          motivo: `HTTP ${r.status} al bajarla`,
          transitorio: r.status >= 500,
        };
      }

      const declarado = Number(r.headers.get("content-length"));
      if (Number.isFinite(declarado) && declarado > MAX_BYTES) {
        return {
          buf: null,
          motivo: `dice pesar ${Math.round(declarado / 1024)} KB, por encima del tope`,
          transitorio: false,
        };
      }

      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length === 0) return { buf: null, motivo: "llegó vacía", transitorio: true };
      if (buf.length > MAX_BYTES) {
        return {
          buf: null,
          motivo: `pesa ${Math.round(buf.length / 1024)} KB, por encima del tope`,
          transitorio: false,
        };
      }
      return { buf, motivo: null, transitorio: false };
    } catch {
      // Timeout, DNS, conexión cortada. Mañana hay otra.
      return { buf: null, motivo: "no respondió a tiempo", transitorio: true };
    }
  }

  return { buf: null, motivo: "demasiadas redirecciones", transitorio: false };
}

/**
 * El tipo de imagen, SACADO DE LOS BYTES y no de lo que diga la wiki.
 *
 * Estos bytes vuelven a salir por app/api/arte-sobre con un `Content-Type`
 * puesto por nosotros, así que el tipo deja de ser un dato y pasa a ser una
 * instrucción para el navegador de quien mira la página. Fiarse del `mime` de
 * la API o —peor— de la extensión de la URL sería fiarse de un tercero para
 * eso. Doce bytes de cabecera lo resuelven, y de paso descartan un fichero
 * truncado o una página de error servida con 200.
 *
 * Devuelve null para cualquier cosa que no sea PNG, JPEG o WebP. En
 * particular, un SVG no tiene firma binaria y no llega aquí como ninguno de
 * los tres: un SVG es un documento con scripts dentro, y no se sirve.
 */
function tipoDeImagen(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  if (
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) {
    return "image/png";
  }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    return "image/webp";
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * UNICIDAD: LO ÚNICO QUE NO SE PUEDE COMPARTIR CON EL SCRIPT
 * ------------------------------------------------------------------ */

/**
 * ¿Este fichero de la wiki ya es de otra expansión?
 *
 * EL SCRIPT HACE ALGO QUE AQUÍ NO SE PUEDE HACER. Él junta las candidatas de
 * las 171 expansiones y, si dos se pelean por el mismo fichero, no se lo lleva
 * NINGUNA — que es el cedazo que atrapa "las páginas que juntan dos expansiones
 * si el mapa a mano se equivocase". El cron ve una o dos expansiones por noche
 * y no tiene con qué comparar: reproducir ese barrido exigiría pedirle a la
 * wiki las 171 páginas cada vez, que es exactamente lo que no se puede hacer.
 *
 * LO QUE SÍ SE PUEDE, Y HAY QUE DECIR QUE NO ES LO MISMO: contrastar contra lo
 * que YA está adjudicado, que son dos sitios y ninguno de los dos es la lista
 * completa de candidatas de nadie.
 *
 *   (a) la sección `generado` de src/data/sobres-bulbapedia.json, que viaja en
 *       el bundle y dice qué fichero se llevó cada una de las 130 que el script
 *       ya bajó;
 *   (b) las filas que este mismo cron haya escrito antes.
 *
 * La diferencia con el barrido del script: allí un empate DESCALIFICA A LAS DOS
 * (nadie se lleva un fichero dudoso); contra lo YA ADJUDICADO no se puede hacer
 * eso, porque la otra ya tiene la foto puesta y quitársela sería peor. Así que
 * contra el pasado gana quien llegó primero, y queda anotado como CONFLICTO,
 * que es lo que una persona tiene que mirar.
 *
 * ENTRE LAS EXPANSIONES DE ESTA MISMA NOCHE SÍ SE APLICA LA REGLA DEL SCRIPT, y
 * no está aquí sino en el paso 2b del programa: allí las candidatas del lote
 * entero están delante a la vez, ninguna tiene todavía nada escrito, y un
 * empate no se lo lleva ninguna. Esta función sola no bastaba: se la llama
 * antes de que la pasada escriba una sola fila, así que dos expansiones del
 * mismo lote nunca se veían la una a la otra.
 *
 * Y hay una tercera red debajo de las dos: el índice único de `fichero` en
 * `set_pack_art` (services/sobresEsquema.ts). Ése no se puede saltar aunque
 * esta función se equivoque.
 */
async function yaEsDeOtra(setId: string, ficheros: readonly string[]): Promise<Set<string>> {
  const tomados = new Set<string>();
  for (const f of ficheros) {
    const dueno = DUENO_ESTATICO.get(f);
    if (dueno && dueno !== setId) tomados.add(f);
  }

  try {
    const { rows } = await sql.query(
      `SELECT fichero FROM set_pack_art
        WHERE fichero = ANY($1::text[]) AND set_id <> $2`,
      [ficheros as string[], setId],
    );
    for (const r of rows) if (r.fichero) tomados.add(String(r.fichero));
  } catch {
    // Si la consulta falla se sigue con lo que dice el mapa estático. El índice
    // único de la tabla es la red de debajo y ése no falla en silencio.
  }
  return tomados;
}

/* ------------------------------------------------------------------ *
 * LA COLA
 * ------------------------------------------------------------------ */

/**
 * Qué expansiones toca mirar esta noche.
 *
 * EL FILTRO QUE MÁS AHORRA NO ESTÁ EN SQL, y no puede estarlo: las expansiones
 * que ya tienen foto ESTÁTICA en public/sobres (130 de 171) se descartan con
 * `tieneIlustracionEstatica`, que compara por id NORMALIZADO —"me2pt5" y
 * "me2.5" son la misma expansión y Postgres no lo sabe—. Sin eso la cola
 * traería cada noche 130 expansiones que jamás van a necesitar nada, porque el
 * manifiesto estático manda siempre que tenga entrada.
 *
 * El resto del cedazo (cuándo repreguntar por un negativo) se hace también
 * aquí, en JavaScript y no en SQL, porque los plazos son una decisión de
 * producto que se lee mejor en una tabla con comentarios
 * (DIAS_PARA_REPREGUNTAR) que dentro de un CASE. La tabla tiene ~170 filas de
 * texto: traerlas enteras cuesta menos que discutirlo.
 */
async function colaDeSets(soloSetId: string | null): Promise<{ cola: FilaCola[]; total: number }> {
  /* El recuento de fotos va en una SUBCONSULTA agregada y no en un JOIN a pelo
   * contra `set_pack_art`: la tabla tiene bytes y no hace falta traer ni una
   * fila suya, sólo cuántas hay por expansión. Son unas decenas de filas.
   * Para qué se usa, que no es obvio: ver "OK SIN FOTOS" más abajo. */
  const { rows } = await sql.query(
    `SELECT s.id,
            s.name,
            s.release_date,
            e.estado,
            e.revisado_en,
            COALESCE(a.filas, 0) AS filas
       FROM sets s
       LEFT JOIN set_pack_art_estado e ON e.set_id = s.id
       LEFT JOIN (SELECT set_id, COUNT(*) AS filas FROM set_pack_art GROUP BY set_id) a
              ON a.set_id = s.id
      WHERE ($1::text IS NULL OR s.id = $1)
      ORDER BY COALESCE(e.revisado_en, TIMESTAMP '1970-01-01') ASC,
               s.release_date DESC NULLS LAST`,
    [soloSetId],
  );

  const ahora = Date.now();
  const cola: FilaCola[] = [];

  for (const r of rows) {
    const id = String(r.id ?? "");
    if (!id) continue;

    const fila: FilaCola = {
      id,
      name: String(r.name ?? id),
      estado: r.estado ? String(r.estado) : null,
      revisadoEn: r.revisado_en ? new Date(r.revisado_en).getTime() : null,
    };

    /* `?setId=` se salta la cola y los plazos, PERO NO EL MANIFIESTO ESTÁTICO:
     * bajar una foto para una expansión que ya la tiene en public/sobres sería
     * gastar peticiones en algo que la aplicación no va a mirar nunca. */
    if (tieneIlustracionEstatica(id)) continue;
    if (soloSetId) {
      cola.push(fila);
      continue;
    }

    /* OK SIN FOTOS: el único estado del que no se sale solo.
     *
     * `guardarFotos` hace DELETE y luego los INSERT sin transacción —el `sql` de
     * @vercel/postgres es un pool y no puede haberla—, y ese orden está pensado
     * para que morir a mitad deje 1..k fotos, que es un resultado bueno. Lo que
     * no cubre es morir ENTRE el DELETE y el primer INSERT: quedan CERO filas y
     * la fila de estado sigue diciendo `ok` de la vez anterior, que vale `null`
     * días, o sea NUNCA MÁS. Sobre dibujado para siempre con la tabla afirmando
     * que hay tres fotos, y sólo recuperable con un `?setId=` a mano que nadie
     * sabe que hay que disparar. Sólo se llega forzando una expansión que ya
     * estaba `ok`, pero de ahí no se sale, y de ahí sí se sale con una línea. */
    const filas = Number(r.filas) || 0;
    if (fila.estado === ESTADOS_SOBRE.OK && filas === 0) {
      cola.push(fila);
      continue;
    }

    const dias = plazoDeReconsulta(fila.estado, r.release_date, ahora);
    if (fila.estado && dias === null) continue; // ok / omitida: nunca más
    if (fila.estado && typeof dias === "number" && fila.revisadoEn !== null) {
      if (ahora - fila.revisadoEn < dias * DIA_MS) continue;
    }
    cola.push(fila);
  }

  return { cola: cola.slice(0, LOTE_SETS), total: cola.length };
}

/**
 * Cuántos días hay que esperar antes de volver a preguntar por esta expansión.
 *
 * El estado pone el plazo base (DIAS_PARA_REPREGUNTAR) y LA EDAD lo acorta,
 * porque los dos casos que caen en el mismo estado no son el mismo problema:
 *
 *   · POP Series 3 no tiene sobre y no lo va a tener: 180 días está bien, y de
 *     hecho sobra.
 *   · La expansión que salió el martes puede no tener la foto subida TODAVÍA.
 *     Preguntar el miércoles y no volver hasta dentro de seis meses es fallarle
 *     justo a la única expansión que motivó todo esto.
 *
 * El porqué largo y lo que cuesta están en DIAS_PARA_REPREGUNTAR_RECIENTE
 * (services/sobresEsquema.ts). `null` no se toca: lo ha dicho una persona
 * (`omitida`) o ya está resuelto (`ok`).
 */
function plazoDeReconsulta(
  estado: string | null,
  fechaSalida: unknown,
  ahora: number,
): number | null | undefined {
  const base = DIAS_PARA_REPREGUNTAR[estado ?? ""];
  if (typeof base !== "number") return base;

  const salida = fechaSalida ? new Date(String(fechaSalida)).getTime() : NaN;
  // Sin fecha de salida se aplica el plazo largo: no saber cuándo salió no es
  // motivo para preguntar más.
  if (!Number.isFinite(salida)) return base;
  if (ahora - salida > DIAS_RECIENTE * DIA_MS) return base;
  return Math.min(base, DIAS_PARA_REPREGUNTAR_RECIENTE);
}

/* ------------------------------------------------------------------ *
 * ESCRITURA
 * ------------------------------------------------------------------ */

/** Deja anotado por qué esta expansión no tiene foto, para no repreguntar. */
async function anotarEstado(
  setId: string,
  estado: EstadoSobre,
  motivo: string | null,
  pagina: string | null,
  variantes: number,
): Promise<void> {
  await sql.query(
    `INSERT INTO set_pack_art_estado
       (set_id, estado, motivo, pagina, variantes, intentos, revisado_en, cambiado_en)
     VALUES ($1, $2, $3, $4, $5, 1, NOW(), NOW())
     ON CONFLICT (set_id) DO UPDATE
       SET estado      = EXCLUDED.estado,
           motivo      = EXCLUDED.motivo,
           pagina      = EXCLUDED.pagina,
           variantes   = EXCLUDED.variantes,
           intentos    = set_pack_art_estado.intentos + 1,
           revisado_en = NOW(),
           cambiado_en = CASE WHEN set_pack_art_estado.estado IS DISTINCT FROM EXCLUDED.estado
                              THEN NOW() ELSE set_pack_art_estado.cambiado_en END`,
    [setId, estado, motivo, pagina, variantes],
  );
}

/**
 * Guarda las fotos de una expansión.
 *
 * EL ORDEN DE LAS TRES SENTENCIAS ES LA TOLERANCIA A FALLOS, no una casualidad.
 * No hay transacción —el `sql` de @vercel/postgres es un pool y cada llamada
 * puede caer en otra conexión— así que la función puede morir por tiempo entre
 * dos de ellas, y lo que quede escrito tiene que ser coherente igualmente:
 *
 *   1. DELETE de lo que hubiera. Sólo importa cuando se fuerza con `?setId=`.
 *   2. INSERT de las variantes, EN ORDEN 1..N. Si muere a mitad quedan 1..k, y
 *      services/sobresBD.ts las cuenta y comprueba que van seguidas desde 1: la
 *      expansión enseña k fotos en vez de N, que es un resultado perfectamente
 *      bueno. Lo que nunca puede pasar es que se anuncien fotos que no están.
 *   3. La fila de estado, LA ÚLTIMA. Mientras no se escriba, la expansión sigue
 *      en la cola y mañana se vuelve a intentar entera. Escribirla primero
 *      sería declarar el trabajo hecho antes de hacerlo.
 */
async function guardarFotos(
  setId: string,
  pagina: string,
  fotos: {
    fichero: string;
    origen: string;
    mime: string;
    ancho: number;
    alto: number;
    bytes: Buffer;
  }[],
): Promise<void> {
  await sql.query(`DELETE FROM set_pack_art WHERE set_id = $1`, [setId]);

  for (let i = 0; i < fotos.length; i++) {
    const f = fotos[i];
    await sql.query(
      `INSERT INTO set_pack_art
         (set_id, variante, mime, ancho, alto, bytes, pagina, fichero, origen)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [setId, i + 1, f.mime, f.ancho, f.alto, f.bytes, pagina, f.fichero, f.origen],
    );
  }

  await anotarEstado(setId, ESTADOS_SOBRE.OK, null, pagina, fotos.length);
}

/* ================================================================== *
 * PROGRAMA
 * ================================================================== */

export interface OpcionesSobres {
  presupuestoMs: number;
  /** Fuerza una expansión concreta, saltándose la cola y los plazos. */
  soloSetId?: string | null;
}

/**
 * Una pasada. Nunca lanza por culpa de la wiki; sí puede lanzar si Postgres no
 * está, y quien la llama lo captura (el tramo encadenado de sync-es va en su
 * propio try/catch y no convierte la respuesta en un 500).
 */
export async function sincronizarSobres({
  presupuestoMs,
  soloSetId = null,
}: OpcionesSobres): Promise<ResumenSobres> {
  const arranque = Date.now();
  /* EL RELOJ Y LA BANDERA DE PARADA VIAJAN JUNTOS Y POR PARÁMETRO. El reloj lo
   * miran también las funciones de red, que es la corrección que faltaba: antes
   * cada petición se cortaba a 6 s fijos y el presupuesto sólo se consultaba en
   * el paso 4, así que el tramo podía gastar ~21 s de los 6-10 que tiene. */
  const pasada: Pasada = { fin: arranque + presupuestoMs - MARGEN_MS, parar: false };
  const quedaTiempo = () => restan(pasada) > 0;

  const resumen: ResumenSobres = {
    revisados: [],
    nuevos: [],
    sinSobre: [],
    pendientes: 0,
    truncadoPorTiempo: false,
    errores: [],
  };

  await asegurarTablas();

  const { cola, total } = await colaDeSets(soloSetId);
  resumen.pendientes = Math.max(0, total - cola.length);
  if (cola.length === 0) return resumen;

  /* --- Las que el mapa a mano marca "omitir" no gastan NI UNA PETICIÓN.
   *     Se anotan y se acabó: si una persona ha escrito que esto no tuvo sobre
   *     suelto, preguntárselo a la wiki no aporta nada. Son las 9 marcadas hoy
   *     (promos, Trainer Gallery, Shiny Vault, kits, energías). --- */
  const porPreguntar: { fila: FilaCola; titulo: string }[] = [];
  for (const fila of cola) {
    const manual = MANUAL[fila.id];
    const titulo = tituloDePagina({ id: fila.id, name: fila.name }, manual);
    if (!titulo) {
      resumen.revisados.push(fila.id);
      const motivo = "omitida a mano: " + (manual?.motivo ?? "sin motivo escrito");
      resumen.sinSobre.push({ setId: fila.id, estado: ESTADOS_SOBRE.OMITIDA, motivo });
      await anotarEstado(fila.id, ESTADOS_SOBRE.OMITIDA, motivo, null, 0);
      continue;
    }
    porPreguntar.push({ fila, titulo });
  }
  if (porPreguntar.length === 0) return resumen;
  /* Última mirada al reloj ANTES DE TOCAR LA RED. Hasta aquí sólo ha habido
   * Postgres (crear tablas, la cola, las omitidas), y con una base fría eso ya
   * puede haberse comido el turno. Salir aquí no cuesta nada; entrar sin tiempo
   * cuesta una petición a la wiki que no va a servir para nada. */
  if (!quedaTiempo()) {
    resumen.truncadoPorTiempo = true;
    return resumen;
  }

  /* ------------------------------------------------------------------ *
   * LA REGLA QUE GOBIERNA TODO LO QUE SIGUE
   * ------------------------------------------------------------------
   *
   * UN NEGATIVO DE 180 DÍAS SÓLO SE ESCRIBE SI LA WIKI HA CONTESTADO.
   *
   * Antes no era así, y era el fallo más caro de este fichero: `pedirApi`
   * devolvía `null` igual para un timeout que para una respuesta, el paso 2 lo
   * leía como "no existe la página" y sellaba SIN_PAGINA. Como la cola va por
   * `revisado_en ASC, release_date DESC`, LA PRIMERA DE LA COLA ES LA EXPANSIÓN
   * MÁS NUEVA: treinta segundos de wiki caída a las 07:00 quemaban durante medio
   * año justo la que este cron existe para traer, dejando en el log una frase
   * falsa ("no hay página X en Bulbapedia") que manda a quien la lea a buscar un
   * problema que no existe en el mapa a mano.
   *
   * Así que hay tres desenlaces y no uno:
   *
   *   · la wiki contestó y dijo que no  -> negativo con su estado (180 días, o
   *     7 si la expansión es reciente: ver `plazoDeReconsulta`).
   *   · la wiki no contestó             -> ESTADOS_SOBRE.ERROR, que vale 1 DÍA y
   *     existe exactamente para esto. Hasta hoy era inalcanzable desde la red:
   *     sólo lo escribía el catch de Postgres.
   *   · nos hemos quedado sin tiempo, o
   *     la wiki ha pedido parar         -> NO SE ANOTA NADA. La expansión
   *     conserva su `revisado_en` viejo y sale la primera mañana. La tabla es la
   *     cola y no hay cursor que corromper.
   * ------------------------------------------------------------------ */

  /* --- Paso 1: UNA petición para todas las páginas de la noche. --- */
  const { paginas, fallo: falloPaginas } = await ficherosDePaginas(pasada, [
    ...new Set(porPreguntar.map((x) => x.titulo)),
  ]);
  /* Se mide contra MINIMO_PETICION_MS y no contra cero: si no queda ni para la
   * siguiente petición, la pasada ya ha terminado aunque el reloj diga que sí.
   * Y se sale SIN ANOTAR NADA, que es lo que hace que quedarse sin tiempo no
   * cueste nada mañana — incluye el caso en que `pedirApi` ni llegó a pedir. */
  if (pasada.parar || restan(pasada) < MINIMO_PETICION_MS) {
    resumen.errores.push(
      pasada.parar ? "la wiki pidió parar antes de empezar" : "sin tiempo tras pedir las páginas",
    );
    resumen.truncadoPorTiempo = !pasada.parar;
    return resumen;
  }
  if (falloPaginas) {
    console.warn(
      "[sync-sobres] la consulta de páginas llegó incompleta:" +
        " esta noche no se descarta a nadie por no encontrarle sobre",
    );
  }
  await dormir(PAUSA_API);

  /* --- Paso 2: emparejar. Puro, compartido con el script, sin red. --- */
  let planes: {
    fila: FilaCola;
    pagina: string;
    candidatas: Candidata[];
  }[] = [];

  /* LA ASIMETRÍA, que es lo que hace que una respuesta incompleta no cueste seis
   * meses: con `falloPaginas` levantado, lo que SÍ se encontró sigue valiendo
   * —una candidata que está, está— pero lo que NO se encontró deja de ser un
   * veredicto y pasa a ser ERROR, que son 1 día. Una lista de ficheros a medias
   * sólo puede producir falsos NEGATIVOS, nunca un falso positivo. */
  const negativo = falloPaginas ? ESTADOS_SOBRE.ERROR : null;

  for (const { fila, titulo } of porPreguntar) {
    const set: SetParaSobre = { id: fila.id, name: fila.name };
    const pag = paginas.get(titulo);

    if (!pag?.existe) {
      const motivo = negativo
        ? `la wiki no terminó de contestar por "${titulo}"`
        : `no hay página "${titulo}" en Bulbapedia`;
      const estado = negativo ?? ESTADOS_SOBRE.SIN_PAGINA;
      resumen.revisados.push(fila.id);
      resumen.sinSobre.push({ setId: fila.id, estado, motivo });
      await anotarEstado(fila.id, estado, motivo, titulo, 0);
      continue;
    }

    const candidatas = candidatasDe(set, pag.ficheros, pag.titulo, MANUAL[fila.id]);
    if (candidatas.length === 0) {
      const motivo = negativo
        ? `la lista de ficheros de "${pag.titulo}" llegó incompleta`
        : `"${pag.titulo}" (${pag.ficheros.length} ficheros) no tiene ninguno que parezca su sobre`;
      const estado = negativo ?? ESTADOS_SOBRE.SIN_CANDIDATAS;
      resumen.revisados.push(fila.id);
      resumen.sinSobre.push({ setId: fila.id, estado, motivo });
      await anotarEstado(fila.id, estado, motivo, pag.titulo, 0);
      continue;
    }

    planes.push({ fila, pagina: pag.titulo, candidatas });
  }

  /* --- Paso 2b: UN FICHERO, UNA EXPANSIÓN, TAMBIÉN DENTRO DE LA MISMA NOCHE.
   *
   * Esto faltaba y era una grieta de verdad. `yaEsDeOtra` contrasta contra lo
   * que YA está adjudicado —el mapa `generado` y las filas escritas— pero todas
   * las escrituras de esta pasada ocurren en el paso 4, así que dos expansiones
   * DEL MISMO LOTE que se peleasen por un fichero no se veían la una a la otra:
   * las dos lo conservaban, la primera en escribir se lo quedaba y la segunda
   * reventaba contra el índice único. Y la asimetría era lo peor: a la perdedora
   * se le anotaba CONFLICTO y salía por el log, a la ganadora no se le anotaba
   * nada. Si la equivocada era la que llegó primero, no quedaba ni una línea.
   *
   * Aquí sí se puede aplicar la regla del script TAL CUAL, porque las candidatas
   * del lote entero están delante: SI DOS SE PELEAN, NO SE LO LLEVA NINGUNA.
   * Es el cedazo que atrapa "el mapa a mano manda dos expansiones a la misma
   * página", que es el único camino realista hacia un sobre en la expansión
   * equivocada. El barrido global de las 171 sigue siendo del script; esto es su
   * versión de esta noche, y por debajo queda el índice único. --- */
  const duenoDe = new Map<string, string>();
  for (const plan of planes) {
    for (const c of plan.candidatas) {
      const previo = duenoDe.get(c.titulo);
      duenoDe.set(c.titulo, previo && previo !== plan.fila.id ? "__PELEA__" : plan.fila.id);
    }
  }

  /* --- Paso 2c: y contra lo que ya era de otra (mapa estático + filas). --- */
  const conCandidatas: typeof planes = [];
  for (const plan of planes) {
    const peleadas = plan.candidatas
      .filter((c) => duenoDe.get(c.titulo) === "__PELEA__")
      .map((c) => c.titulo);
    const tomados = await yaEsDeOtra(plan.fila.id, plan.candidatas.map((c) => c.titulo));
    for (const t of peleadas) tomados.add(t);

    const libres = plan.candidatas.filter((c) => !tomados.has(c.titulo));
    if (libres.length === 0) {
      /* El motivo dice de cuál de las dos redes vino, porque se arreglan de
       * formas distintas: una pelea de esta noche casi siempre es el mapa a
       * mano mandando dos expansiones a la misma página; un fichero ya
       * adjudicado es alguien pisando a una expansión que ya tiene su foto. */
      const motivo =
        "sus candidatas no son suyas: " +
        [...tomados]
          .map((t) => (peleadas.includes(t) ? `${t} (se la pelea otra de esta misma noche)` : t))
          .join(", ");
      resumen.revisados.push(plan.fila.id);
      resumen.sinSobre.push({ setId: plan.fila.id, estado: ESTADOS_SOBRE.CONFLICTO, motivo });
      await anotarEstado(plan.fila.id, ESTADOS_SOBRE.CONFLICTO, motivo, plan.pagina, 0);
      continue;
    }
    conCandidatas.push({ ...plan, candidatas: libres });
  }
  planes = conCandidatas;

  if (planes.length === 0 || pasada.parar || restan(pasada) < MINIMO_PETICION_MS) {
    if (!pasada.parar && planes.length > 0) resumen.truncadoPorTiempo = true;
    return resumen;
  }

  /* --- Paso 3: UNA petición para los tamaños de todas las candidatas. --- */
  const { info, fallo: falloInfo } = await infoDeFicheros(pasada, [
    ...new Set(planes.flatMap((x) => x.candidatas.map((c) => c.titulo))),
  ]);
  if (pasada.parar) {
    resumen.errores.push("la wiki pidió parar antes de bajar nada");
    return resumen;
  }
  if (restan(pasada) < MINIMO_PETICION_MS) {
    // Se acabó el presupuesto durante la consulta. No es un veredicto sobre
    // nadie: sin anotar, y mañana salen las primeras.
    resumen.truncadoPorTiempo = true;
    return resumen;
  }
  if (falloInfo) {
    /* Sin tamaños, `pasaElFiltro` diría "la API no da URL" de TODAS y el bucle
     * de abajo escribiría FILTRO_FORMA —"no tienen forma de sobre"— por una
     * petición que ni siquiera llegó. ERROR, que es 1 día, y mañana. */
    const motivo = "la wiki no contestó a la consulta de tamaños";
    for (const plan of planes) {
      resumen.revisados.push(plan.fila.id);
      resumen.sinSobre.push({ setId: plan.fila.id, estado: ESTADOS_SOBRE.ERROR, motivo });
      await anotarEstado(plan.fila.id, ESTADOS_SOBRE.ERROR, motivo, plan.pagina, 0);
    }
    resumen.errores.push(motivo);
    return resumen;
  }
  await dormir(PAUSA_API);

  /* --- Paso 4: bajar y guardar, expansión a expansión, mirando el reloj. --- */
  for (const plan of planes) {
    if (!quedaTiempo() || pasada.parar) {
      resumen.truncadoPorTiempo = true;
      // Sin anotar: se quedan con su `revisado_en` viejo y salen las primeras
      // mañana. La propia tabla es la cola y no hay cursor que corromper.
      break;
    }

    const { fila } = plan;
    /* "Revisada" SE APUNTA EN CADA DESENLACE Y NO AQUÍ ARRIBA, que es donde
     * estaba: una expansión que se queda a medias porque se acabó el tiempo no
     * está revisada —mañana se mira entera otra vez— y contarla hoy sería
     * mentirle al resumen que lee el log. */

    const elegidas: {
      fichero: string;
      origen: string;
      mime: string;
      ancho: number;
      alto: number;
      bytes: Buffer;
    }[] = [];
    const descartes: string[] = [];
    /* Se ha quedado alguna candidata sin mirar por algo que NO es culpa suya:
     * se acabó el tiempo, la wiki pidió parar o no respondió a la descarga.
     * Distingue "ninguna de sus fotos vale" de "no llegué a saberlo", que es la
     * diferencia entre 180 días y mañana. */
    let interrumpido = false;
    let transitorio = false;

    for (const c of plan.candidatas) {
      if (elegidas.length >= MAX_VARIANTES) break;
      if (!quedaTiempo() || pasada.parar) {
        interrumpido = true;
        break;
      }

      const i = info.get(c.titulo);
      // El cedazo de forma es el compartido, así que el cron y el script
      // aceptan y rechazan exactamente lo mismo.
      const motivo = pasaElFiltro(
        i ? { url: i.url, ancho: i.ancho, alto: i.alto } : null,
      );
      if (motivo) {
        descartes.push(`${c.titulo} — ${motivo}`);
        continue;
      }

      const bajada = await bajarImagen(pasada, i!.url!);
      if (!bajada.buf) {
        descartes.push(`${c.titulo} — ${bajada.motivo ?? "no se pudo bajar"}`);
        // Un 429 tardío o un timeout en la ÚLTIMA candidata acababa antes en
        // FILTRO_FORMA, o sea 180 días, porque la parada sólo se miraba al
        // principio de la vuelta siguiente y ya no había vuelta siguiente.
        if (bajada.transitorio) transitorio = true;
        continue;
      }
      const mime = tipoDeImagen(bajada.buf);
      if (!mime || !MIMES_SOBRE.has(mime)) {
        descartes.push(`${c.titulo} — los bytes no son PNG, JPEG ni WebP`);
        continue;
      }

      elegidas.push({
        fichero: c.titulo,
        origen: i!.url!,
        mime,
        // Las de la MINIATURA: son las que describen estos bytes, y con las que
        // la hoja de estilos calcula el recorte (`tamanoDeFondo`).
        ancho: i!.anchoThumb ?? i!.ancho ?? 0,
        alto: i!.altoThumb ?? i!.alto ?? 0,
        bytes: bajada.buf,
      });
      await dormir(PAUSA_IMG);
    }

    if (elegidas.length === 0) {
      const detalle = descartes.length ? " · " + descartes.join(" · ") : "";
      if (interrumpido) {
        /* Ni una línea en la tabla: conserva su `revisado_en` viejo y sale la
         * primera mañana. Es lo mismo que hace el bucle de fuera. */
        resumen.truncadoPorTiempo = true;
        break;
      }
      if (transitorio) {
        const motivo = "no se pudieron bajar sus fotos esta noche" + detalle;
        resumen.sinSobre.push({ setId: fila.id, estado: ESTADOS_SOBRE.ERROR, motivo });
        await anotarEstado(fila.id, ESTADOS_SOBRE.ERROR, motivo, plan.pagina, 0);
        resumen.revisados.push(fila.id);
        continue;
      }
      const motivo = "sus candidatas no pasaron el filtro de forma o tamaño" + detalle;
      resumen.sinSobre.push({ setId: fila.id, estado: ESTADOS_SOBRE.FILTRO_FORMA, motivo });
      await anotarEstado(fila.id, ESTADOS_SOBRE.FILTRO_FORMA, motivo, plan.pagina, 0);
      resumen.revisados.push(fila.id);
      continue;
    }

    try {
      await guardarFotos(fila.id, plan.pagina, elegidas);
      resumen.nuevos.push({
        setId: fila.id,
        variantes: elegidas.length,
        pagina: plan.pagina,
      });
      olvidarVariantesDeSobre();
    } catch (e: unknown) {
      /* El índice único de `fichero` es lo que casi seguro ha saltado: dos
       * expansiones apuntando al mismo fichero de la wiki. Se anota como
       * conflicto —que es lo que una persona tiene que mirar— y no como error,
       * porque reintentarlo mañana daría exactamente lo mismo. */
      const msg = e instanceof Error ? e.message : String(e);
      const conflicto = /duplicate key|unique/i.test(msg);
      const estado = conflicto ? ESTADOS_SOBRE.CONFLICTO : ESTADOS_SOBRE.ERROR;
      /* Puede haber quedado 1..k escritas antes de reventar, así que el recuento
       * en memoria de esta instancia ya no vale. Se tira igual que en el camino
       * bueno: `variantesDeSobre` cuenta filas y es la que manda. Sin esto, la
       * instancia servía hasta cinco minutos un número que la tabla desmiente. */
      olvidarVariantesDeSobre();
      resumen.errores.push(`${fila.id}: ${msg}`);
      resumen.sinSobre.push({ setId: fila.id, estado, motivo: msg });
      try {
        await anotarEstado(fila.id, estado, msg, plan.pagina, 0);
      } catch {
        // Si tampoco se puede anotar, mañana se vuelve a intentar. No hay nada
        // que hacer aquí y desde luego no tumbar el cron por ello.
      }
    }
    resumen.revisados.push(fila.id);
  }

  return resumen;
}
