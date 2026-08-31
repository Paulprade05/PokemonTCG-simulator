// services/preciosIngest.ts
//
// INGESTA DE PRECIOS REALES: TCGdex (bloque de Cardmarket) -> Postgres.
//
// QUÉ RESUELVE: `utils/constanst.ts` sabe convertir euros en monedas
// (ajustePorPrecioReal) y `services/preciosBD.ts` sabe leer los euros de la
// tabla `card_prices`, pero NADIE los metía ahí. Sin este fichero el ajuste por
// precio real es código muerto: `preciosEnEuros` devuelve siempre un mapa vacío
// y cada carta se paga a su tarifa por rareza, exactamente como antes.
//
// POR QUÉ NO SALEN DE `cards.cardmarket`: esa columna la llena la ingesta desde
// pokemontcg.io y está VACÍA en las 252 de 252 cartas comprobadas de sv08 (lo
// documenta services/esquemaMejoras.ts). Además esa API lleva meses devolviendo
// 502. TCGdex sí responde y sí sirve precios en euros al día.
//
// ESTÁ CALCADO DE services/idiomaIngest.ts a propósito —cola por `revisado_en`,
// presupuesto absoluto, oleadas en paralelo, escrituras en serie y las guardias
// antimapeo— porque el modo de fallo es el MISMO y es el peor de todos: un
// emparejamiento cruzado escribe el precio de OTRA carta. Si aquél cambia de
// forma, éste debería seguirle.
//
// LO QUE NO HACE: tocar `cards`, `sets`, `users` ni nada de lo que dependa la
// economía. Escribe en `card_prices` y en ninguna otra tabla, y esa tabla no
// tiene ninguna columna en monedas.

import { sql } from "@vercel/postgres";
import { ESTADOS_PRECIO, SENTENCIAS_PRECIOS } from "./esquemaMejoras";
import { ESTADOS_IDIOMA } from "./idiomaEsquema";
import { MAPA_SETS_ES, candidatoTcgdex } from "./mapaSetsEs";
import { SELL_PRICES } from "../utils/constanst";

/**
 * INGLÉS Y NO ESPAÑOL, y no es un descuido: son dos decisiones en una.
 *
 *  1. El precio es el mismo en las dos locales —Cardmarket es un solo mercado y
 *     TCGdex sirve el mismo bloque `pricing` mire uno /en o /es—, así que el
 *     idioma no cuesta ni aporta nada por el lado del dato.
 *  2. Pero la GUARDIA de nombres sólo funciona en inglés. Nuestra tabla `cards`
 *     guarda el nombre inglés de pokemontcg.io; contra /v2/en los nombres tienen
 *     que coincidir casi todos, mientras que contra /v2/es coincidiría el 33-90%
 *     (es la medición que cita idiomaIngest.ts) y el umbral se volvería inútil
 *     justo donde más falta hace.
 *
 * Los ids de expansión y de carta de TCGdex son los mismos en todas las locales,
 * así que un `tcgdex_id` que confirmó el cron de traducciones vale aquí tal cual.
 */
const API_EN = "https://api.tcgdex.net/v2/en";

/**
 * Peticiones en vuelo. MEDIDO: 44 cartas/s con olas de 8, o sea unas 2.000
 * cartas en los 45 s de presupuesto. Subirlo más no acelera (TCGdex empieza a
 * encolar) y sí multiplica el destrozo si hay que abortar a mitad.
 */
const OLEADA = 8;

/**
 * EL CORTE POR VALOR, que es la decisión importante de todo el fichero.
 *
 * MEDIDO sobre las 252 cartas de sv08 con precios reales: el ajuste mueve el
 * precio MENOS DE UN 1% en Common (+0,0%), Uncommon (+0,0%), Rare (+0,1%) y
 * Double Rare (+0,1%), y 179 de las 252 cartas valen menos de 1 € (ajuste por
 * debajo del 0,1%, o sea CERO monedas después de redondear). Pedir el precio de
 * una Common es tirar una petición: cuesta lo mismo que la de una Hyper Rare y
 * no cambia ni una moneda de lo que paga la tienda.
 *
 * Con el corte en 35 monedas de tarifa (Double Rare para arriba) se dejan fuera
 * Common 2, Uncommon 3, Rare 14, Rare Holo 22 y Promo 26 —el grueso de cada
 * expansión— y entran las que sí mueven la aguja, incluidas las cuatro de sv08
 * que pasan de 50 € (ahí el ajuste llega al 5%, y +27% en la de 271 €).
 *
 * EL CORTE SE DERIVA DE SELL_PRICES, no se lista a mano: si alguien reequilibra
 * la economía y sube una rareza por encima de 35, entra sola en el cron. Una
 * lista copiada se habría quedado atrás en silencio.
 */
const CORTE_TARIFA = 35;

/** Las rarezas que NO se preguntan. Derivadas, nunca escritas a mano. */
const RAREZAS_BARATAS: readonly string[] = Object.keys(SELL_PRICES).filter(
  (rareza) => SELL_PRICES[rareza] < CORTE_TARIFA,
);

/** Margen para abrir una expansión: GET del set + SELECT de sus cartas. */
const MARGEN_SET_MS = 6_000;
/** Margen para cerrar la oleada en vuelo sin que la función muera. */
const MARGEN_OLEADA_MS = 2_500;
/** Margen que se guarda SIEMPRE para volcar lo ya leído (ver `volcar`). */
const MARGEN_ESCRITURA_MS = 3_000;
/** Por debajo de esto no merece la pena ni abrir conexión: se vuelve mañana. */
const PRESUPUESTO_MINIMO_MS = 9_000;

/** Tope por petición: una respuesta que nunca llega no la detecta ningún reintento. */
const TIMEOUT_PETICION_MS = 10_000;
/** Reintentos por carta. Cortos a propósito: aquí hay miles de peticiones. */
const REINTENTOS = 3;
/** Base del respaldo exponencial: 600 ms, 1,2 s. Peor caso 1,8 s por carta. */
const ESPERA_BASE_MS = 600;
/** Sólo se duerme si después queda tiempo para la petición que sigue. */
const MARGEN_REINTENTO_MS = 1_500;

/**
 * Filas por sentencia. Con 3 parámetros por fila son 600 marcadores, lejísimos
 * del tope de 65.535 de Postgres. El motivo de agrupar NO es el tope, es el
 * número de idas y vueltas: ver el comentario de `volcar`.
 */
const FILAS_POR_SENTENCIA = 200;

/**
 * Techo de cordura en euros. `card_prices.eur` es NUMERIC(10,2) y un valor
 * absurdo (o un campo que TCGdex sirva en otra unidad por error) reventaría la
 * sentencia ENTERA por desbordamiento, tirando el lote de 200 cartas buenas que
 * viaja con él. No existe una carta de 100.000 €; lo que pase de ahí es basura.
 */
const TOPE_EUR = 100_000;

/**
 * Tope de errores que se guardan con su texto. Un fallo de red al principio de
 * la noche puede repetirse dos mil veces y el resumen viaja dentro del JSON de
 * la respuesta del cron: sin tope, el registro de Vercel se vuelve ilegible.
 */
const MAX_ERRORES = 20;

export interface ResumenPrecios {
  /** Expansiones abiertas en esta pasada. */
  setsRevisados: string[];
  /** Expansiones que NO se escribieron, y por qué. Es lo único accionable. */
  setsRechazados: { setId: string; motivo: string }[];
  /** Cartas por las que se preguntó. */
  revisados: number;
  /** Cartas cuyo precio en euros cambió respecto al que ya había. */
  actualizados: number;
  /** Cartas releídas con el mismo euro que ya tenían. */
  sinCambios: number;
  /**
   * Cartas leídas sin precio utilizable: TCGdex no publica bloque de Cardmarket
   * para ellas, lo publica en otra moneda, o devolvió 404 a su id. NO se les
   * borra el precio que tuvieran: sólo se les mueve el estado.
   */
  sinPrecio: number;
  /** Cartas marcadas sin fuente (expansión sin id de TCGdex o rechazada). */
  sinFuente: number;
  truncadoPorTiempo: boolean;
  errores: string[];
  /** Errores que ocurrieron pero no se guardaron por el tope de MAX_ERRORES. */
  erroresOmitidos: number;
}

interface CartaRemota {
  id: string;
  localId: string;
  name: string;
}

/**
 * La expansión tal y como la sirve TCGdex en /v2/en/sets/<id>.
 *
 * Sólo se declaran los dos campos que se usan, y los dos OPCIONALES: la guardia
 * de más abajo existe precisamente porque `id` puede no ser el que se pidió y
 * `cards` puede llegar vacío. Declararlos obligatorios sería mentirle al
 * compilador sobre una respuesta que no controlamos.
 */
interface SetRemoto {
  id?: string;
  cards?: CartaRemota[];
}

interface CartaLocal {
  id: string;
  numero: string;
  nombre: string;
  rareza: string;
  /** Milisegundos; 0 para una carta por la que no se ha preguntado nunca. */
  revisadoEn: number;
  /** Lo que ya hay guardado, para distinguir "actualizado" de "sin cambios". */
  eur: number | null;
}

/* ------------------------------------------------------------------ *
 * ESQUEMA
 * ------------------------------------------------------------------ */

let tablasListas: Promise<void> | null = null;

/**
 * La tabla, memoizada por instancia. Va aquí y NO en el `ensureSchema` de
 * app/action.ts por el motivo que ese fichero documenta en su propio comentario
 * (action.ts:143-159): aquél se espera antes de CADA compra de sobre y esta
 * tabla no la toca ninguna compra —sólo la escribe este cron, una vez al día,
 * dentro de su presupuesto—. El fallo no se cachea, para que el siguiente
 * intento vuelva a probar en vez de quedarse envenenado hasta el próximo
 * despliegue.
 */
function asegurarTablas(): Promise<void> {
  if (!tablasListas) {
    tablasListas = (async () => {
      for (const sentencia of SENTENCIAS_PRECIOS) await sql.query(sentencia);
    })().catch((e) => {
      tablasListas = null;
      throw e;
    });
  }
  return tablasListas;
}

/* ------------------------------------------------------------------ *
 * TCGdex
 * ------------------------------------------------------------------ */

function dormir(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * COPIA DELIBERADA de `senalConTiempo` de services/ingest.ts. Sin un tope por
 * petición, una conexión colgada se come el maxDuration entero y la función
 * muere sin responder ni dejar resumen; y sin recortar contra `limite`, el tope
 * de la petición sobreviviría al presupuesto.
 */
function senalConTiempo(limite: number): AbortSignal {
  const restante = limite - Date.now();
  return AbortSignal.timeout(Math.max(1000, Math.min(TIMEOUT_PETICION_MS, restante)));
}

/**
 * POR QUÉ NO SE USA `fetchJson` DE services/ingest.ts, que era lo primero que
 * había que mirar. Dos motivos, y el primero es de seguridad:
 *
 *  1. `fetchJson` manda las cabeceras de `cabeceras()`, que incluyen
 *     `X-Api-Key: POKEMONTCG_API_KEY` a CUALQUIER host. Usarlo aquí filtraría
 *     nuestra clave de pokemontcg.io a api.tcgdex.net en cada una de las ~2.000
 *     peticiones nocturnas. Una credencial no se manda a un tercero que no la
 *     pide.
 *  2. Su respaldo es de 3 s × 2^intento (hasta 60 s), dimensionado para 170
 *     peticiones grandes de páginas de 250 cartas. Aquí una sola espera de 3 s
 *     se lleva por delante 130 cartas de las 44/s medidas. Y trata el 404 como
 *     error, cuando aquí es un dato con su propio estado ('404').
 *
 * Lo que sí se reutiliza es el CRITERIO: reintentos con respaldo, AbortSignal
 * por intento y no dormir nunca más allá del presupuesto. Si algún día
 * `fetchJson` acepta cabeceras por parámetro, esto se borra y se llama a aquél.
 *
 * Devuelve `null` para 404, que es "TCGdex no conoce ese id" y no un fallo.
 */
/**
 * GENÉRICA Y NO `any`: quien llama declara la forma que espera y se hace
 * responsable de ella. Lo que llega es JSON de un tercero, así que ninguna
 * firma puede GARANTIZAR la forma; lo que sí se consigue es que el punto donde
 * se asume esté escrito y se vea, en vez de un `any` que se propaga en silencio
 * por todo el fichero.
 */
async function pedirJson<T>(url: string, limite: number): Promise<T | null> {
  for (let intento = 0; intento < REINTENTOS; intento++) {
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { accept: "application/json" },
        cache: "no-store",
        signal: senalConTiempo(limite),
      });
    } catch {
      const espera = ESPERA_BASE_MS * Math.pow(2, intento);
      if (Date.now() + espera + MARGEN_REINTENTO_MS > limite) {
        throw new Error("sin tiempo para reintentar: " + url);
      }
      await dormir(espera);
      continue;
    }
    if (res.status === 404) return null;
    if (res.ok) return res.json();
    if ([429, 500, 502, 503, 504].includes(res.status)) {
      const espera = ESPERA_BASE_MS * Math.pow(2, intento);
      if (Date.now() + espera + MARGEN_REINTENTO_MS > limite) {
        throw new Error(`HTTP ${res.status} sin tiempo para reintentar: ${url}`);
      }
      await dormir(espera);
      continue;
    }
    throw new Error(`HTTP ${res.status} en ${url}`);
  }
  throw new Error("reintentos agotados: " + url);
}

/**
 * De qué campo sale el euro que se guarda.
 *
 * `avg30` PRIMERO Y NO `low` NI `avg`: es la media de los últimos 30 días, o
 * sea una tendencia. `low` es el vendedor más barato de hoy —un dato que salta
 * varios euros de un día para otro y que haría bailar la tienda sin que haya
 * pasado nada— y `avg` es la media histórica completa, que reacciona
 * demasiado tarde a una reimpresión. Si falta `avg30` se cae a `trend` (la
 * tendencia que calcula el propio Cardmarket) y sólo al final a `avg`.
 *
 * LA COMPROBACIÓN DE `unit` NO ES PARANOIA BARATA: la columna se llama `eur` y
 * la fórmula de utils/constanst.ts divide por 1000 EUROS. Meter ahí dólares
 * sería un error silencioso que nadie vería nunca, porque el número seguiría
 * pareciendo razonable.
 */
function precioDe(datos: unknown): number | null {
  // Un cast acotado en vez de `any`: lo que llega es JSON de un tercero y de él
  // sólo se tocan estas dos claves. Si TCGdex cambiara la forma, el `?.` deja
  // `cm` en undefined y la carta se marca sin precio, que es lo correcto.
  const cm = (datos as { pricing?: { cardmarket?: Record<string, unknown> } } | null)
    ?.pricing?.cardmarket;
  if (!cm) return null;
  if (cm.unit !== undefined && cm.unit !== null && String(cm.unit).toUpperCase() !== "EUR") {
    return null;
  }
  for (const clave of ["avg30", "trend", "avg"] as const) {
    const valor = Number(cm[clave]);
    if (!Number.isFinite(valor) || valor <= 0 || valor >= TOPE_EUR) continue;
    // Se redondea AQUÍ a los dos decimales de NUMERIC(10,2) para que la
    // comparación con lo guardado (¿cambió el precio?) compare lo mismo que
    // Postgres almacenó, y no un 3,4499999 contra un 3,45.
    return Math.round(valor * 100) / 100;
  }
  return null;
}

/**
 * COPIADA de `candidatosDeNumero` de services/idiomaIngest.ts, que a su vez la
 * copió de scripts/generar-diccionario-es.mjs. Allí no está exportada, y hacer
 * que lo esté es tocar un fichero que no me toca. Es la MISMA regla y tiene que
 * seguir siéndolo: el repo escribe el número sin ceros ("sv3pt5-1") y TCGdex con
 * tres ("sv03.5-001"), pero los promos alfanuméricos ("SWSH074", "TG01")
 * coinciden tal cual. Si allí cambia, aquí también.
 */
function candidatosDeNumero(sufijo: string): string[] {
  const vistos = new Set<string>();
  const add = (v: string) => { if (v && !vistos.has(v)) vistos.add(v); };
  add(sufijo);
  if (/^\d+$/.test(sufijo)) {
    const n = String(Number(sufijo));
    for (const ancho of [1, 2, 3, 4]) add(n.padStart(ancho, "0"));
  }
  add(sufijo.toUpperCase());
  add(sufijo.toLowerCase());
  const m = /^([A-Za-z]+)(\d+)$/.exec(sufijo);
  if (m) for (const ancho of [2, 3]) add(m[1] + m[2].padStart(ancho, "0"));
  return [...vistos];
}

/**
 * Nombre reducido a lo que se puede comparar entre dos catálogos distintos.
 *
 * NO ES COSMÉTICA: sin esto la guardia de nombres daría falsos rechazos en
 * expansiones enteras. Las diferencias reales entre pokemontcg.io y TCGdex son
 * tres y ninguna significa que las cartas sean distintas: acentos ("Pokémon"),
 * apóstrofos y puntos ("Farfetch'd", "Mr. Mime"), y el subtítulo entre
 * paréntesis que TCGdex añade a algunos entrenadores.
 */
function normalizarNombre(valor: string): string {
  return String(valor ?? "")
    .normalize("NFD")
    // Los diacríticos ya separados por la NFD. Escrito con escapes y no con los
    // caracteres literales: son invisibles en un editor y cualquier copia y
    // pega los perdería sin que se notara hasta que fallara una expansión.
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s*\([^)]*\)\s*$/, "")
    .replace(/[^a-z0-9]+/g, "");
}

/**
 * ¿Merece la pena gastar una petición en esta carta? Ver CORTE_TARIFA.
 *
 * UNA RAREZA DESCONOCIDA ENTRA. Parece contraintuitivo (lo desconocido no está
 * en SELL_PRICES y cobra la tarifa de respaldo de 10 monedas) pero es la
 * decisión segura: una rareza que no está en la tabla es casi siempre una
 * rareza NUEVA de una expansión recién salida, o sea justo la carta cara que
 * este cron existe para tasar. Excluirla dejaría la cabeza de cada expansión
 * nueva sin precio hasta que alguien actualizara SELL_PRICES a mano.
 *
 * ESTE PREDICADO Y EL FILTRO SQL DE `construirCola` TIENEN QUE DECIDIR LO MISMO,
 * y lo hacen porque los dos salen de SELL_PRICES: allí `rarity <> ALL(baratas)`
 * deja pasar exactamente lo mismo que aquí deja pasar el `undefined`. Si se
 * separan, la cola ordenaría por unas cartas y se pedirían otras, y una
 * expansión se quedaría dando vueltas en cabeza para siempre.
 */
function mueveLaAguja(rareza: string | null | undefined): boolean {
  const r = (rareza ?? "").trim();
  if (!r) return false;
  const tarifa = SELL_PRICES[r];
  if (tarifa === undefined) return true;
  return tarifa >= CORTE_TARIFA;
}

/* ------------------------------------------------------------------ *
 * ESCRITURA
 * ------------------------------------------------------------------ */

interface FilaPrecio {
  cardId: string;
  /**
   * `null` = TCGdex respondió pero no hay precio utilizable. Es la forma en que
   * sale del lector; a `volcar` NO llega nunca (esas van por `marcarSinPrecio`,
   * que no toca el euro). El manejo del NULL de aquí abajo se queda como red:
   * el día que alguien llame a esta función desde otro sitio, que no fabrique
   * una fila fechada como "cambiada" sin precio dentro.
   */
  eur: number | null;
  estado: string;
}

/**
 * Vuelca un lote de PRECIOS. UNA SENTENCIA POR CADA 200 CARTAS, y esto es una
 * desviación consciente de idiomaIngest.ts, que escribe una fila suelta por
 * expansión.
 *
 * POR QUÉ: aquél escribe 46 filas por noche y puede permitirse un `INSERT` por
 * cada una. Éste escribe hasta 2.000, y a 10-20 ms de ida y vuelta contra
 * Vercel Postgres serían 20-40 s de los 45 del presupuesto gastados en latencia
 * de red, no en precios. Agrupando, las mismas 2.000 filas son diez sentencias.
 * El patrón de marcadores es el de `upsertLotes` de services/ingest.ts: los $n
 * los genera el índice del bucle, JAMÁS los datos.
 *
 * `cambiado_en` sólo se mueve si el euro cambió de verdad (`IS DISTINCT FROM`
 * también trata bien el NULL), así que esa columna sigue contando cuándo cambió
 * el precio y no cuándo pasó el cron por última vez: para eso está `revisado_en`.
 *
 * SE DEDUPLICA porque Postgres rechaza un `ON CONFLICT ... DO UPDATE` que toque
 * la misma fila dos veces en la misma sentencia (la trampa que documenta
 * `unicosPorId` en ingest.ts). Hoy no puede pasar —se recorren ids distintos—,
 * pero el día que pase se llevaría por delante el lote entero, no la fila.
 */
async function volcar(filas: FilaPrecio[]): Promise<void> {
  if (!filas.length) return;
  const unicas = new Map<string, FilaPrecio>();
  for (const f of filas) unicas.set(f.cardId, f);
  const lista = [...unicas.values()];

  for (let i = 0; i < lista.length; i += FILAS_POR_SENTENCIA) {
    const lote = lista.slice(i, i + FILAS_POR_SENTENCIA);
    // Los parametros de una sentencia parametrizada son de tipos mezclados
    // (texto, numero, null). `unknown[]` lo dice sin renunciar a comprobar nada:
    // aqui solo se acumulan y se pasan a Postgres, nunca se leen.
    const params: unknown[] = [];
    const tuplas = lote.map((fila, indice) => {
      const base = indice * 3;
      params.push(fila.cardId, fila.eur, fila.estado);
      // El CASE evita fechar como "cambiada" una carta que nace sin precio.
      return (
        `($${base + 1}, $${base + 2}::numeric, $${base + 3}, NOW(),` +
        ` CASE WHEN $${base + 2}::numeric IS NULL THEN NULL ELSE NOW() END)`
      );
    });
    await sql.query(
      `INSERT INTO card_prices (card_id, eur, estado, revisado_en, cambiado_en)
       VALUES ${tuplas.join(", ")}
       ON CONFLICT (card_id) DO UPDATE
         SET eur = EXCLUDED.eur,
             fuente = 'tcgdex',
             estado = EXCLUDED.estado,
             revisado_en = NOW(),
             cambiado_en = CASE
               WHEN card_prices.eur IS DISTINCT FROM EXCLUDED.eur THEN NOW()
               ELSE card_prices.cambiado_en END`,
      params,
    );
  }
}

/**
 * Marca cartas como revisadas SIN TOCAR SU PRECIO. Es lo que se escribe cuando
 * una expansión no tiene fuente o la rechaza una guardia.
 *
 * LAS DOS RAZONES DE QUE ESTO EXISTA, y las dos son importantes:
 *
 *  1. LA COLA SE ATASCARÍA. Si un rechazo no escribiera nada, las cartas de esa
 *     expansión se quedarían con `revisado_en` en 1970 y volverían a encabezar
 *     la cola CADA NOCHE, gastando el GET del set y dejando sin turno a las
 *     expansiones que sí se pueden tasar. Con la marca, la expansión se va al
 *     final y se reintenta mañana —que es lo que hay que hacer, porque el
 *     arreglo suele ser mapearla a mano en src/data/es/mapa-sets.json.
 *
 *  2. Y AUN ASÍ NO SE PUEDE ESCRIBIR `eur = NULL`. El `DO UPDATE` de abajo
 *     toca `estado` y `revisado_en` y NADA MÁS, a propósito: si TCGdex tiene
 *     un mal día y sirve `cards: []` para una expansión ya tasada, poner el
 *     precio a NULL borraría de golpe sesenta precios buenos. Un fallo
 *     transitorio de la fuente no puede empeorar lo que ya estaba bien; es el
 *     mismo criterio que la guardia CAIDA_SOSPECHOSA de idiomaIngest.ts.
 *
 * El precio sólo lo escribe `volcar`, y sólo cuando la expansión pasó TODAS las
 * guardias. Una fila marcada con eur NULL es invisible para preciosBD.ts, que
 * filtra por `eur IS NOT NULL AND eur > 0`.
 */
async function marcarSinPrecio(cardIds: string[], estado: string): Promise<void> {
  if (!cardIds.length) return;
  const unicos = [...new Set(cardIds)];
  for (let i = 0; i < unicos.length; i += FILAS_POR_SENTENCIA) {
    const lote = unicos.slice(i, i + FILAS_POR_SENTENCIA);
    const params: unknown[] = [];
    const tuplas = lote.map((cardId, indice) => {
      params.push(cardId, estado);
      return `($${indice * 2 + 1}, $${indice * 2 + 2}, NOW())`;
    });
    await sql.query(
      `INSERT INTO card_prices (card_id, estado, revisado_en)
       VALUES ${tuplas.join(", ")}
       ON CONFLICT (card_id) DO UPDATE
         SET estado = EXCLUDED.estado,
             revisado_en = NOW()`,
      params,
    );
  }
}

/* ------------------------------------------------------------------ *
 * LA COLA
 * ------------------------------------------------------------------ */

interface TrabajoSet {
  setId: string;
  /** `null` = ninguna vía dio un id que TCGdex reconozca. */
  tcgdexId: string | null;
  /** Cuántas cartas caras tiene, sólo para el registro. */
  caras: number;
}

/**
 * Qué expansión toca, de la que lleva más tiempo sin tasarse a la más reciente.
 *
 * LA UNIDAD DE TRABAJO ES LA EXPANSIÓN AUNQUE LA COLA SEA DE CARTAS, y no hay
 * alternativa: el precio está en el endpoint POR CARTA, pero el id de TCGdex de
 * una carta sólo se conoce bajando el set entero (una petición que devuelve el
 * mapeo completo <nuestro id> -> <id TCGdex>). Ordenar por cartas sueltas
 * obligaría a rebajar ese set una y otra vez.
 *
 * De ahí el `MIN(revisado_en)`: una expansión vale lo que valga su carta más
 * abandonada. Una recién ingerida (sin ninguna fila en card_prices) se sitúa
 * sola en cabeza porque el COALESCE la data en 1970, igual que en
 * idiomaIngest.ts — la propia tabla es la cola, no hay cursor que corromper —, y
 * lo que se quedó anoche sin turno sale primero mañana.
 *
 * EL FILTRO DE RAREZA VA EN SQL Y NO EN JS por una razón de orden, no de
 * eficiencia: si las Common contaran, TODAS las expansiones tendrían su mínimo
 * clavado en 1970 para siempre (nunca se les escribe fila) y el ORDER BY dejaría
 * de significar nada.
 */
async function construirCola(
  idsDeTcgdex: ReadonlySet<string>,
  forzado: string | null,
): Promise<TrabajoSet[]> {
  const { rows } = await sql.query(
    `SELECT c.set_id AS set_id,
            COUNT(*)::int AS caras,
            MIN(COALESCE(p.revisado_en, '1970-01-01'::timestamp)) AS mas_viejo
       FROM cards c
       LEFT JOIN card_prices p ON p.card_id = c.id
      WHERE c.rarity IS NOT NULL
        AND c.rarity <> ''
        AND c.rarity <> ALL($1::text[])
      GROUP BY c.set_id
      ORDER BY mas_viejo ASC, c.set_id ASC`,
    [RAREZAS_BARATAS],
  );

  /* LOS IDS YA CONFIRMADOS mandan sobre cualquier conjetura, igual que en
   * idiomaIngest.ts. PERO SÓLO LOS QUE ESTÁN EN 'ok': aquél guarda el
   * `tcgdex_id` que probó AUNQUE la guardia lo rechazara (su ON CONFLICT hace
   * `COALESCE(EXCLUDED.tcgdex_id, ...)`), así que una fila en estado 'guardia'
   * contiene precisamente el id EQUIVOCADO. Filtrarlo por estado es lo que
   * impide heredar aquí un mapeo que allí ya se descartó.
   *
   * En try/catch porque `set_translations` es de otro módulo: si ese cron no ha
   * corrido nunca en este despliegue, la tabla no existe y esto se degrada a la
   * conjetura de siempre en vez de tumbar los precios. */
  const confirmados = new Map<string, string>();
  try {
    const { rows: filas } = await sql.query(
      `SELECT set_id, tcgdex_id FROM set_translations
        WHERE lang = 'es' AND estado = $1 AND tcgdex_id IS NOT NULL`,
      [ESTADOS_IDIOMA.OK],
    );
    for (const f of filas) confirmados.set(String(f.set_id), String(f.tcgdex_id));
  } catch {
    // Sin traducciones todavía: se tira de mapa-sets.json y del candidato.
  }

  const cola: TrabajoSet[] = [];
  for (const fila of rows) {
    const setId = String(fila.set_id);
    if (forzado && setId !== forzado) continue;
    const candidato =
      confirmados.get(setId) ?? MAPA_SETS_ES[setId] ?? candidatoTcgdex(setId);
    cola.push({
      setId,
      // La lista blanca de TCGdex evita gastar un GET (y un 404) en preguntar
      // por ids que no existen; la conjetura se valida gratis contra ella.
      tcgdexId: idsDeTcgdex.has(candidato) ? candidato : null,
      caras: Number(fila.caras ?? 0),
    });
  }
  return cola;
}

/* ------------------------------------------------------------------ *
 * UNA EXPANSIÓN
 * ------------------------------------------------------------------ */

interface ResultadoSet {
  rechazo?: string;
  revisados: number;
  actualizados: number;
  sinCambios: number;
  sinPrecio: number;
  sinFuente: number;
  truncado: boolean;
}

async function procesarSet(
  trabajo: TrabajoSet,
  limite: number,
  anotarError: (mensaje: string) => void,
): Promise<ResultadoSet> {
  const r: ResultadoSet = {
    revisados: 0, actualizados: 0, sinCambios: 0,
    sinPrecio: 0, sinFuente: 0, truncado: false,
  };

  // Las cartas locales ENTERAS, no sólo las caras: las guardias se calculan
  // sobre la expansión completa. Con sólo las caras (unas 50 de 250) el
  // porcentaje de emparejamiento se mediría sobre una muestra sesgada —los
  // números altos, que es justo donde más difieren las numeraciones— y la
  // guardia perdería el poco filo que tiene. Son 250 filas, no cuesta nada.
  const { rows: locales } = await sql.query(
    `SELECT c.id, c.number, c.name, c.rarity,
            p.eur AS eur,
            COALESCE(p.revisado_en, '1970-01-01'::timestamp) AS revisado_en
       FROM cards c
       LEFT JOIN card_prices p ON p.card_id = c.id
      WHERE c.set_id = $1`,
    [trabajo.setId],
  );
  if (!locales.length) return { ...r, rechazo: "no hay cartas de esa expansión en la base" };

  const cartasLocales: CartaLocal[] = locales.map((f: Record<string, unknown>) => ({
    id: String(f.id),
    numero: String(f.number ?? ""),
    nombre: String(f.name ?? ""),
    rareza: String(f.rarity ?? ""),
    // Postgres devuelve TIMESTAMP como Date, pero según el camino puede llegar
    // como cadena. String() cubre los dos sin necesitar un `any`, y el `|| 0`
    // recoge el caso de que no haya fecha todavía (columna a su DEFAULT).
    revisadoEn: new Date(String(f.revisado_en ?? "")).getTime() || 0,
    eur: f.eur === null || f.eur === undefined ? null : Number(f.eur),
  }));
  const idsCaros = cartasLocales.filter((c) => mueveLaAguja(c.rareza)).map((c) => c.id);

  // SIN FUENTE: ni el mapa, ni el candidato, ni el id confirmado existen en
  // TCGdex. Se marca para que la cola avance (ver `marcarSinPrecio`).
  if (!trabajo.tcgdexId) {
    await marcarSinPrecio(idsCaros, ESTADOS_PRECIO.sinFuente);
    r.sinFuente = idsCaros.length;
    return { ...r, rechazo: "ningún id de TCGdex conocido para esta expansión" };
  }

  const remoto = await pedirJson<SetRemoto>(
    API_EN + "/sets/" + encodeURIComponent(trabajo.tcgdexId),
    limite,
  );
  if (!remoto) {
    await marcarSinPrecio(idsCaros, ESTADOS_PRECIO.noEncontrada);
    r.sinFuente = idsCaros.length;
    return { ...r, rechazo: "TCGdex no conoce " + trabajo.tcgdexId };
  }

  /* GUARDIA 1: que responda 200 no prueba que sea el set pedido. Si devuelve
   * otro id, el candidato estaba mal y todo lo que venga detrás es de otra
   * expansión. Calcada de idiomaIngest.ts. */
  if (String(remoto.id) !== trabajo.tcgdexId) {
    await marcarSinPrecio(idsCaros, ESTADOS_PRECIO.sinFuente);
    r.sinFuente = idsCaros.length;
    return { ...r, rechazo: `pedí ${trabajo.tcgdexId} y respondió ${remoto.id}` };
  }

  const cartasRemotas: CartaRemota[] = Array.isArray(remoto.cards) ? remoto.cards : [];
  if (!cartasRemotas.length) {
    // Pasa de verdad: TCGdex lista la expansión pero sirve `cards: []`.
    await marcarSinPrecio(idsCaros, ESTADOS_PRECIO.sinFuente);
    r.sinFuente = idsCaros.length;
    return { ...r, rechazo: "TCGdex la lista pero no sirve cartas" };
  }

  const porLocalId = new Map<string, CartaRemota>();
  for (const c of cartasRemotas) {
    if (c?.localId !== undefined && !porLocalId.has(String(c.localId))) {
      porLocalId.set(String(c.localId), c);
    }
  }

  const parejas = new Map<string, CartaRemota>();
  let nombresIdenticos = 0;
  for (const local of cartasLocales) {
    const sufijo = local.id.startsWith(trabajo.setId + "-")
      ? local.id.slice(trabajo.setId.length + 1)
      : local.numero;
    let pareja: CartaRemota | undefined;
    for (const clave of candidatosDeNumero(sufijo)) {
      pareja = porLocalId.get(clave);
      if (pareja) break;
    }
    if (!pareja || !pareja.id) continue;
    parejas.set(local.id, pareja);
    if (normalizarNombre(pareja.name) === normalizarNombre(local.nombre)) nombresIdenticos++;
  }

  /* LAS GUARDIAS ANTIMAPEO, OBLIGATORIAS Y NO NEGOCIABLES. El fallo que
   * previenen no es "no hay precio", es "esta carta tiene el precio de OTRA":
   * emparejar sv10 contra sv08 casa el 100% de las cartas POR NÚMERO —las
   * numeraciones son densas y las dos llegan hasta 250— y escribiría el precio
   * de una Special Illustration Rare de 271 € sobre una Double Rare de 2 €. La
   * tienda pagaría esa carta a un precio inventado y nadie lo notaría, porque
   * un precio en euros no tiene nada de raro visto de uno en uno.
   *
   * GUARDIA 2, el 90% de emparejamiento: es el umbral de idiomaIngest.ts,
   * medido allí sobre las 46 expansiones correctas.
   *
   * GUARDIA 3, la de nombres, y aquí es MÁS FUERTE que en traducciones: contra
   * /v2/en los nombres son los mismos catálogos en el mismo idioma y deberían
   * coincidir casi todos, mientras que dos expansiones cruzadas dan casi cero
   * (empareja "Charizard" con "Bulbasaur"). El umbral se deja en el 50% y no en
   * el 95% a propósito: no tengo medición propia de cuánto difieren TCGdex y
   * pokemontcg.io en subtítulos de entrenadores y cartas promocionales, y un
   * umbral demasiado alto rechazaría expansiones buenas —que es un fallo mudo:
   * se quedarían sin precio para siempre y nadie miraría por qué—. Al 50% sigue
   * habiendo un abismo entre lo correcto y lo cruzado. Si alguna vez se mide de
   * verdad, súbase. */
  const fEmparejadas = parejas.size / cartasLocales.length;
  if (fEmparejadas < 0.9) {
    const motivo = `sólo empareja ${(100 * fEmparejadas).toFixed(1)}% con ${trabajo.tcgdexId}`;
    await marcarSinPrecio(idsCaros, ESTADOS_PRECIO.sinFuente);
    r.sinFuente = idsCaros.length;
    return { ...r, rechazo: motivo };
  }
  const fIdenticas = parejas.size ? nombresIdenticos / parejas.size : 0;
  if (fIdenticas < 0.5) {
    const motivo =
      `sólo ${(100 * fIdenticas).toFixed(1)}% de los nombres ingleses coincide con ` +
      `${trabajo.tcgdexId}: casi seguro que es OTRA expansión`;
    await marcarSinPrecio(idsCaros, ESTADOS_PRECIO.sinFuente);
    r.sinFuente = idsCaros.length;
    return { ...r, rechazo: motivo };
  }

  /* A PARTIR DE AQUÍ EL MAPEO ESTÁ VALIDADO y ya se pueden escribir precios.
   * Sólo las caras, y de ellas las más abandonadas primero: si el presupuesto
   * se acaba a mitad de expansión, mañana se sigue por donde se quedó sin
   * guardar ningún cursor. */
  const elegibles = cartasLocales
    .filter((c) => mueveLaAguja(c.rareza) && parejas.has(c.id))
    .sort((a, b) => a.revisadoEn - b.revisadoEn);

  // Las caras que la guardia dio por buenas pero que no tienen pareja remota:
  // se marcan para que no encabecen la cola eternamente.
  const huerfanas = cartasLocales
    .filter((c) => mueveLaAguja(c.rareza) && !parejas.has(c.id))
    .map((c) => c.id);
  if (huerfanas.length) {
    await marcarSinPrecio(huerfanas, ESTADOS_PRECIO.sinFuente);
    r.sinFuente += huerfanas.length;
  }

  // El euro que YA había, para poder decir si esta pasada cambió algo. Se saca
  // a un mapa y no se busca en la lista: son hasta 120 cartas por expansión y
  // un `find` dentro del bucle de oleadas es cuadrático sin motivo.
  const eurAnterior = new Map<string, number | null>();
  for (const c of elegibles) eurAnterior.set(c.id, c.eur);

  /* DOS MONTONES, Y LA SEPARACIÓN ES LA REGLA DE SEGURIDAD DE TODO EL FICHERO:
   * lo que trae precio se escribe con `volcar`, y lo que NO trae precio se
   * apunta con `marcarSinPrecio`, que deja `eur` como estaba.
   *
   * Podría parecer más simple escribir NULL y ya. Sería un error: una carta que
   * ayer valía 12 € y hoy vuelve sin bloque de Cardmarket —porque TCGdex tiene
   * un mal rato, que los tiene— se quedaría sin precio hasta la vuelta
   * siguiente, cuatro noches después. Mantener el precio de anteayer no cuesta
   * nada (es una media de 30 días, no se mueve) y perderlo sí. Es el mismo
   * criterio que la guardia CAIDA_SOSPECHOSA de idiomaIngest.ts: una respuesta
   * degradada nunca puede empeorar una fila que ya estaba bien. */
  let porEscribir: FilaPrecio[] = [];
  let porMarcar: { cardId: string; estado: string }[] = [];

  const descargar = async () => {
    await volcar(porEscribir);
    porEscribir = [];
    // Agrupadas por estado: `marcarSinPrecio` escribe un estado por sentencia.
    for (const estado of new Set(porMarcar.map((m) => m.estado))) {
      await marcarSinPrecio(
        porMarcar.filter((m) => m.estado === estado).map((m) => m.cardId),
        estado,
      );
    }
    porMarcar = [];
  };

  for (let i = 0; i < elegibles.length; i += OLEADA) {
    if (Date.now() > limite - MARGEN_OLEADA_MS - MARGEN_ESCRITURA_MS) {
      r.truncado = true;
      break;
    }
    const ola = elegibles.slice(i, i + OLEADA);
    // Peticiones en paralelo, escrituras en serie: el desperdicio máximo si el
    // presupuesto muere a mitad son siete respuestas ya bajadas.
    const leidas = await Promise.all(
      ola.map(async (carta): Promise<FilaPrecio | null> => {
        const remota = parejas.get(carta.id);
        if (!remota) return null;
        try {
          const datos = await pedirJson(
            API_EN + "/cards/" + encodeURIComponent(String(remota.id)),
            limite,
          );
          if (!datos) return { cardId: carta.id, eur: null, estado: ESTADOS_PRECIO.noEncontrada };
          const eur = precioDe(datos);
          return {
            cardId: carta.id,
            eur,
            estado: eur === null ? ESTADOS_PRECIO.sinPrecio : ESTADOS_PRECIO.ok,
          };
        } catch (e) {
          // Sin fila: la carta se queda en cabeza de cola y se reintenta
          // mañana. Escribirle un estado la mandaría al final por un fallo de
          // red que no dice nada de ella.
          anotarError(`${carta.id}: ${e instanceof Error ? e.message : String(e)}`);
          return null;
        }
      }),
    );

    for (const fila of leidas) {
      if (!fila) continue;
      r.revisados++;
      if (fila.eur === null) {
        r.sinPrecio++;
        porMarcar.push({ cardId: fila.cardId, estado: fila.estado });
      } else {
        // Medio céntimo de tolerancia: la columna es NUMERIC(10,2) y vuelve de
        // Postgres como cadena. Comparar con `!==` contaría como "cambio" un
        // 3.4 leído contra un 3.40 guardado, y el registro diría cada noche que
        // cambiaron dos mil precios que no se han movido.
        const antes = eurAnterior.get(fila.cardId) ?? null;
        if (antes !== null && Math.abs(antes - fila.eur) < 0.005) r.sinCambios++;
        else r.actualizados++;
        porEscribir.push(fila);
      }
    }

    if (porEscribir.length + porMarcar.length >= FILAS_POR_SENTENCIA) await descargar();
  }

  // El volcado final va SIEMPRE, incluso truncando por tiempo: para eso está
  // reservado MARGEN_ESCRITURA_MS. Perder aquí lo ya bajado sería tirar las
  // peticiones que más han costado y repetirlas mañana.
  await descargar();
  return r;
}

/* ------------------------------------------------------------------ *
 * ENTRADA
 * ------------------------------------------------------------------ */

/**
 * Baja precios hasta agotar `presupuestoMs` y devuelve lo que hizo.
 *
 * REANUDABLE POR CONSTRUCCIÓN: no guarda cursor ninguno. El orden sale de
 * `card_prices.revisado_en` (con su índice idx_card_prices_cola) y cada carta
 * escrita se va al final de la cola sola. Una ejecución cortada por la mitad no
 * deja nada a medias: lo escrito está escrito y lo demás sigue esperando turno.
 *
 * CUÁNTAS NOCHES TARDA UNA VUELTA: unas 2.000 cartas por pasada de 45 s contra
 * las ~50 caras de cada una de las ~180 expansiones del catálogo, o sea unas
 * 9.000; el ciclo completo son cuatro o cinco noches. No pasa nada: `avg30` es
 * una media de 30 días y no se mueve de un día para otro. Si algún día urgiera,
 * lo que se sube es el corte de rareza, no la frecuencia.
 */
export async function sincronizarPrecios(opciones: {
  presupuestoMs: number;
  soloSetId?: string | null;
}): Promise<ResumenPrecios> {
  const limite = Date.now() + opciones.presupuestoMs;
  const forzado = opciones.soloSetId || null;
  const resumen: ResumenPrecios = {
    setsRevisados: [],
    setsRechazados: [],
    revisados: 0,
    actualizados: 0,
    sinCambios: 0,
    sinPrecio: 0,
    sinFuente: 0,
    truncadoPorTiempo: false,
    errores: [],
    erroresOmitidos: 0,
  };

  const anotarError = (mensaje: string) => {
    if (resumen.errores.length < MAX_ERRORES) resumen.errores.push(mensaje);
    else resumen.erroresOmitidos++;
  };

  /* SALIDA TEMPRANA CON PRESUPUESTO RIDÍCULO. Importa porque el que llama
   * normalmente es el cron de traducciones con LAS SOBRAS (ver el comentario de
   * app/api/cron/sync-es/route.ts): con tres segundos no cabe ni el GET del
   * listado, y abrir conexión para no hacer nada sólo sirve para arriesgarse a
   * que la función muera sin responder. */
  if (opciones.presupuestoMs < PRESUPUESTO_MINIMO_MS) {
    resumen.truncadoPorTiempo = true;
    return resumen;
  }

  await asegurarTablas();

  // Una sola petición que sirve de lista blanca: con ella no se gasta ni un GET
  // en un id inventado, y la conjetura de `candidatoTcgdex` se valida gratis.
  const listado = await pedirJson<{ id: string }[]>(API_EN + "/sets", limite);
  const idsDeTcgdex = new Set<string>(
    (Array.isArray(listado) ? listado : []).map((s: { id: string }) => String(s.id)),
  );
  if (!idsDeTcgdex.size) {
    anotarError("TCGdex no devolvió la lista de expansiones");
    return resumen;
  }

  const cola = await construirCola(idsDeTcgdex, forzado);

  for (const trabajo of cola) {
    if (Date.now() > limite - MARGEN_SET_MS - MARGEN_ESCRITURA_MS) {
      resumen.truncadoPorTiempo = true;
      break;
    }
    resumen.setsRevisados.push(trabajo.setId);
    try {
      const r = await procesarSet(trabajo, limite, anotarError);
      resumen.revisados += r.revisados;
      resumen.actualizados += r.actualizados;
      resumen.sinCambios += r.sinCambios;
      resumen.sinPrecio += r.sinPrecio;
      resumen.sinFuente += r.sinFuente;
      if (r.truncado) resumen.truncadoPorTiempo = true;
      if (r.rechazo) resumen.setsRechazados.push({ setId: trabajo.setId, motivo: r.rechazo });
    } catch (e) {
      anotarError(`${trabajo.setId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return resumen;
}
