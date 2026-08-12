// services/ingest.ts
// Motor de ingesta desde la API pública de Pokémon TCG. No sabe nada de HTTP de
// entrada (ni Request, ni NextResponse): lo usa la ruta de cron y puede usarlo
// cualquier otro disparador.

import { sql } from "@vercel/postgres";

const API = "https://api.pokemontcg.io/v2";
const PAGE_SIZE = 250;

// Postgres admite 65535 parámetros por sentencia; con 28 columnas por carta,
// 100 filas son 2800 marcadores, muy lejos del tope y con payloads manejables.
const FILAS_POR_SENTENCIA = 100;

// Antes de empezar un set nuevo hace falta margen para su primera página y sus
// escrituras; entre páginas basta con menos.
const MARGEN_SET_MS = 8000;
const MARGEN_PAGINA_MS = 6000;
// Un reintento sólo compensa si además queda tiempo para la petición que sigue.
const MARGEN_REINTENTO_MS = 3000;
// Tope por petición: una respuesta que nunca llega no la detecta ningún reintento.
const TIMEOUT_PETICION_MS = 20000;

export type SetPendiente = {
  id: string;
  nombre: string;
  total: number;
  enBD: number;
  releaseDate: string | null;
  /** No existe fila suya en la tabla `sets`: es un set que la app aún no muestra. */
  esNuevo: boolean;
};

export type ResumenSincronizacion = {
  setsRemotos: number;
  setsNuevos: string[];
  setsCompletados: string[];
  cartasInsertadas: number;
  pendientes: SetPendiente[];
  truncadoPorTiempo: boolean;
  errores: { setId: string; mensaje: string }[];
};

function cabeceras(): HeadersInit {
  const h: Record<string, string> = { Accept: "application/json" };
  if (process.env.POKEMONTCG_API_KEY) h["X-Api-Key"] = process.env.POKEMONTCG_API_KEY;
  return h;
}

function dormir(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** `limite` es un instante absoluto (Date.now()): nunca dormimos más allá de él. */
function cabeEspera(espera: number, limite?: number) {
  if (limite === undefined) return true;
  return Date.now() + espera + MARGEN_REINTENTO_MS < limite;
}

/**
 * Cada intento lleva su propio tope y nunca se estira más allá de `limite`: sin
 * él una petición colgada agota el maxDuration de la función y la ejecución
 * muere sin responder ni dejar resumen.
 */
function senalConTiempo(limite?: number): AbortSignal {
  const restante = limite === undefined ? TIMEOUT_PETICION_MS : limite - Date.now();
  return AbortSignal.timeout(Math.max(1000, Math.min(TIMEOUT_PETICION_MS, restante)));
}

/**
 * Reintentos con respaldo exponencial ante 429/5xx y errores de red.
 *
 * A diferencia del original de app/ingest-tcg, respeta un `limite` temporal: una
 * sola espera puede llegar a 60 s y la ruta de cron muere a los 60 s, así que
 * sin esto el presupuesto de tiempo no se podría cumplir. Al quedarse sin
 * margen aborta en vez de dormir, y la siguiente ejecución retoma el trabajo.
 */
export async function fetchJson(
  url: string,
  opciones: { reintentos?: number; limite?: number } = {},
): Promise<any> {
  const reintentos = opciones.reintentos ?? 6;
  const { limite } = opciones;

  for (let i = 0; i < reintentos; i++) {
    let res: Response;
    try {
      res = await fetch(url, {
        headers: cabeceras(),
        cache: "no-store",
        signal: senalConTiempo(limite),
      });
    } catch {
      const espera = 2000 * (i + 1);
      if (!cabeEspera(espera, limite)) throw new Error(`sin tiempo para reintentar: ${url}`);
      console.warn(`error de red, reintento en ${espera}ms`);
      await dormir(espera);
      continue;
    }
    if (res.ok) return res.json();
    if ([429, 500, 502, 503, 504].includes(res.status)) {
      const espera = Math.min(60000, 3000 * Math.pow(2, i));
      if (!cabeEspera(espera, limite)) throw new Error(`sin tiempo para reintentar: ${url}`);
      console.warn(`${res.status}, reintento en ${espera}ms (${i + 1}/${reintentos})`);
      await dormir(espera);
      continue;
    }
    throw new Error(`fetch ${url} -> ${res.status}: ${await res.text()}`);
  }
  throw new Error(`reintentos agotados: ${url}`);
}

/** Catálogo completo de sets de la API, paginando por si algún día pasan de 250. */
export async function listarSetsRemotos(limite?: number): Promise<any[]> {
  const sets: any[] = [];
  for (let page = 1; ; page++) {
    const data = await fetchJson(`${API}/sets?page=${page}&pageSize=${PAGE_SIZE}`, { limite });
    const lote: any[] = data.data || [];
    sets.push(...lote);
    if (lote.length < PAGE_SIZE) break;
  }
  return sets;
}

/**
 * Cuántas cartas sirve REALMENTE la API para un set, con una petición mínima.
 *
 * El `total` que declara un set no siempre coincide con las cartas que la API
 * devuelve. Cuando declara de más, "cartas en BD < total" no se cumple jamás y
 * el set se volvería a descargar entero en cada ejecución diaria, robándole el
 * presupuesto a los que sí faltan. Contrastar contra este número lo cierra.
 */
export async function contarCartasRemotas(setId: string, limite?: number): Promise<number> {
  const url = `${API}/cards?q=set.id:${encodeURIComponent(setId)}&pageSize=1&select=id`;
  const data = await fetchJson(url, { limite, reintentos: 2 });
  return Number(data?.totalCount) || 0;
}

/**
 * Qué falta por descargar: sets sin ninguna carta y sets incompletos.
 *
 * Dos consultas agrupadas y ya: una por set serían ~170 idas y vueltas.
 */
export async function detectarPendientes(
  setsRemotos: any[],
  opciones: { incluirCompletos?: boolean } = {},
): Promise<SetPendiente[]> {
  const { rows: conteos } = await sql`SELECT set_id, count(*)::int AS n FROM cards GROUP BY set_id`;
  const cartasPorSet = new Map<string, number>();
  for (const fila of conteos) cartasPorSet.set(fila.set_id, Number(fila.n));

  const { rows: filasSets } = await sql`SELECT id FROM sets`;
  const setsEnBD = new Set<string>(filasSets.map((f: any) => f.id));

  const pendientes: SetPendiente[] = [];
  for (const s of setsRemotos) {
    if (!s?.id) continue;
    const total = Number(s.total) || 0;
    const enBD = cartasPorSet.get(s.id) ?? 0;
    // Con `total` desconocido (0 o ausente) sólo lo intentamos si no hay nada
    // guardado; si no, el set quedaría pendiente para siempre.
    const incompleto = total > 0 ? enBD < total : enBD === 0;
    if (!incompleto && !opciones.incluirCompletos) continue;
    pendientes.push({
      id: s.id,
      nombre: s.name ?? s.id,
      total,
      enBD,
      releaseDate: s.releaseDate || null,
      esNuevo: !setsEnBD.has(s.id),
    });
  }

  // Lo nuevo primero: es lo que el jugador está esperando ver en la app.
  pendientes.sort((a, b) => (b.releaseDate || "").localeCompare(a.releaseDate || ""));
  return pendientes;
}

function trocear<T>(lista: T[], tamano: number): T[][] {
  const lotes: T[][] = [];
  for (let i = 0; i < lista.length; i += tamano) lotes.push(lista.slice(i, i + tamano));
  return lotes;
}

/**
 * Postgres rechaza un ON CONFLICT ... DO UPDATE que toque la misma fila dos
 * veces dentro de una misma sentencia, así que un id repetido en la respuesta
 * de la API haría fallar el lote entero.
 */
function unicosPorId(items: any[]): any[] {
  const mapa = new Map<string, any>();
  for (const it of items) if (it?.id) mapa.set(it.id, it);
  return Array.from(mapa.values());
}

function marcadores(indiceFila: number, columnas: number): string {
  const base = indiceFila * columnas;
  return `(${Array.from({ length: columnas }, (_, k) => `$${base + k + 1}`).join(", ")})`;
}

function clausulaActualizacion(columnas: readonly string[]): string {
  return columnas
    .filter((c) => c !== "id")
    .map((c) => `${c} = EXCLUDED.${c}`)
    .concat("updated_at = NOW()")
    .join(", ");
}

const COLUMNAS_SETS = [
  "id", "name", "series", "printed_total", "total",
  "legalities", "ptcgo_code", "release_date", "images",
] as const;

const COLUMNAS_CARDS = [
  "id", "name", "supertype", "subtypes", "level", "hp", "types",
  "evolves_from", "evolves_to", "rules", "ancient_trait",
  "abilities", "attacks", "weaknesses", "resistances",
  "retreat_cost", "converted_retreat_cost",
  "set_id", "number", "artist", "rarity", "flavor_text",
  "national_pokedex_numbers", "legalities", "regulation_mark",
  "images", "tcgplayer", "cardmarket",
] as const;

const j = (v: any) => JSON.stringify(v ?? null);

function valoresSet(s: any): any[] {
  return [
    s.id, s.name, s.series ?? null, s.printedTotal ?? null, s.total ?? null,
    JSON.stringify(s.legalities || {}), s.ptcgoCode || null,
    s.releaseDate || null, JSON.stringify(s.images || {}),
  ];
}

function valoresCarta(c: any): any[] {
  return [
    c.id, c.name, c.supertype || null, j(c.subtypes), c.level || null,
    c.hp || null, j(c.types),
    c.evolvesFrom || null, j(c.evolvesTo), j(c.rules), j(c.ancientTrait),
    j(c.abilities), j(c.attacks), j(c.weaknesses), j(c.resistances),
    j(c.retreatCost), c.convertedRetreatCost ?? null,
    c.set?.id || null, c.number || null, c.artist || null,
    c.rarity || "Common", c.flavorText || null,
    j(c.nationalPokedexNumbers), j(c.legalities), c.regulationMark || null,
    j(c.images), j(c.tcgplayer), j(c.cardmarket),
  ];
}

/** INSERT agrupado en lotes: los $n los genera el índice del bucle, nunca los datos. */
async function upsertLotes(
  tabla: string,
  columnas: readonly string[],
  filas: any[],
  aValores: (fila: any) => any[],
): Promise<number> {
  const unicas = unicosPorId(filas);
  let escritas = 0;

  for (const lote of trocear(unicas, FILAS_POR_SENTENCIA)) {
    const params: any[] = [];
    const tuplas = lote.map((fila, i) => {
      params.push(...aValores(fila));
      return marcadores(i, columnas.length);
    });
    await sql.query(
      `INSERT INTO ${tabla} (${columnas.join(", ")})
       VALUES ${tuplas.join(", ")}
       ON CONFLICT (id) DO UPDATE SET ${clausulaActualizacion(columnas)}`,
      params,
    );
    escritas += lote.length;
  }
  return escritas;
}

export async function upsertSets(sets: any[]): Promise<number> {
  return upsertLotes("sets", COLUMNAS_SETS, sets, valoresSet);
}

export async function upsertCards(cards: any[]): Promise<number> {
  return upsertLotes("cards", COLUMNAS_CARDS, cards, valoresCarta);
}

/**
 * Descarga lo que falte, empezando por los sets más recientes y parando antes de
 * agotar `presupuestoMs`.
 *
 * Es reanudable por construcción: el criterio de pendiente es "cartas en la BD <
 * total del set", así que la ejecución siguiente recalcula lo que queda y sigue
 * sin necesidad de guardar ningún estado intermedio. Un set interrumpido a
 * medias se completa en la siguiente pasada.
 */
export async function sincronizar(opciones: {
  presupuestoMs: number;
  soloSetId?: string | null;
}): Promise<ResumenSincronizacion> {
  const limite = Date.now() + opciones.presupuestoMs;
  const hayTiempo = (margen: number) => Date.now() + margen < limite;

  const resumen: ResumenSincronizacion = {
    setsRemotos: 0,
    setsNuevos: [],
    setsCompletados: [],
    cartasInsertadas: 0,
    pendientes: [],
    truncadoPorTiempo: false,
    errores: [],
  };

  const remotos = await listarSetsRemotos(limite);
  resumen.setsRemotos = remotos.length;

  const soloSetId = opciones.soloSetId || null;
  const candidatos = soloSetId ? remotos.filter((s) => s.id === soloSetId) : remotos;
  const porId = new Map<string, any>(candidatos.map((s) => [s.id, s]));

  // Con ?setId= se fuerza el set aunque ya esté completo (es para depurar).
  const trabajos = await detectarPendientes(candidatos, { incluirCompletos: !!soloSetId });
  const completados = new Set<string>();

  for (const trabajo of trabajos) {
    if (!hayTiempo(MARGEN_SET_MS)) {
      resumen.truncadoPorTiempo = true;
      break;
    }

    const setRemoto = porId.get(trabajo.id);
    if (!setRemoto) continue;

    // Un set ya empezado que sigue "incompleto" suele ser un `total` inflado de
    // la API. Se comprueba con una petición mínima en vez de bajarlo entero otra
    // vez; así el criterio de pendiente converge y deja de repetirse cada día.
    // Con ?setId= no se comprueba: ahí se fuerza la descarga a propósito.
    if (!soloSetId && !trabajo.esNuevo && trabajo.enBD > 0) {
      try {
        const totalReal = await contarCartasRemotas(trabajo.id, limite);
        if (totalReal > 0 && trabajo.enBD >= totalReal) {
          completados.add(trabajo.id);
          console.log(
            `sync: ${trabajo.id} ya está al día (${trabajo.enBD}/${totalReal} reales, declara ${trabajo.total})`,
          );
          continue;
        }
      } catch (err: any) {
        console.warn(`sync: no se pudo contar ${trabajo.id}: ${String(err?.message || err)}`);
      }
    }

    try {
      // La ficha del set va antes que sus cartas: así nunca quedan cartas
      // huérfanas si la ejecución se corta a mitad.
      await upsertSets([setRemoto]);
      if (trabajo.esNuevo) resumen.setsNuevos.push(trabajo.id);

      let traidas = 0;
      // Cuántas cartas hay que juntar para darlo por terminado: manda lo que la
      // API sirve de verdad, no lo que el set declara.
      let objetivo = trabajo.total;
      let cortado = false;
      for (let page = 1; ; page++) {
        if (!hayTiempo(MARGEN_PAGINA_MS)) {
          cortado = true;
          break;
        }
        const url = `${API}/cards?q=set.id:${encodeURIComponent(trabajo.id)}&page=${page}&pageSize=${PAGE_SIZE}&orderBy=number`;
        const data = await fetchJson(url, { limite });
        const cartas: any[] = data.data || [];
        // Un `totalCount` de 0 también es información: el set no tiene cartas
        // publicadas y darlo por terminado evita reintentarlo cada día.
        if (page === 1 && typeof data?.totalCount === "number") objetivo = data.totalCount;
        if (cartas.length === 0) break;

        resumen.cartasInsertadas += await upsertCards(cartas);
        traidas += cartas.length;
        if (cartas.length < PAGE_SIZE) break;
      }

      if (cortado) {
        resumen.truncadoPorTiempo = true;
        // El recuento del informe se hizo antes de escribir: se pone al día para
        // que la cola pendiente no mienta sobre lo que ya está guardado.
        trabajo.enBD = Math.max(trabajo.enBD, traidas);
        console.warn(`sync: ${trabajo.id} cortado por tiempo (${traidas}/${trabajo.total})`);
        break;
      }

      if (objetivo === 0 || traidas >= objetivo) completados.add(trabajo.id);
      console.log(`sync: ${trabajo.id} -> ${traidas} cartas`);
    } catch (err: any) {
      const mensaje = String(err?.message || err);
      resumen.errores.push({ setId: trabajo.id, mensaje });
      console.warn(`sync: ${trabajo.id} falló: ${mensaje}`);
      // Si el fallo fue por quedarnos sin margen, no tiene sentido seguir.
      if (!hayTiempo(MARGEN_SET_MS)) {
        resumen.truncadoPorTiempo = true;
        break;
      }
    }
  }

  resumen.setsCompletados = Array.from(completados);
  resumen.pendientes = trabajos.filter((t) => !completados.has(t.id));
  return resumen;
}
