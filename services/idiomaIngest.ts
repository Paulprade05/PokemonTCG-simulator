/**
 * INGESTA DE TRADUCCIONES: TCGdex -> Postgres.
 *
 * QUÉ RESUELVE: el diccionario español de `src/data/es` es un artefacto de
 * despliegue, y en Vercel el sistema de ficheros es de sólo lectura. El cron de
 * expansiones (services/ingest.ts) hace crecer el catálogo solo, así que cada
 * expansión nueva nacía en inglés hasta que alguien regeneraba el diccionario a
 * mano y volvía a desplegar. Esto lo automatiza: mira cada día si TCGdex ya
 * tiene traducida alguna de las que faltan y la guarda en `set_translations`,
 * de donde la lee `services/idiomaBD.ts` sin necesidad de desplegar nada.
 *
 * ESTÁ CALCADO DE services/ingest.ts a propósito: presupuesto de tiempo,
 * reanudable y resumen. Si aquél cambia de forma, éste debería seguirle.
 *
 * LO QUE NO HACE: tocar `cards`, `sets` ni nada de lo que dependa la economía.
 * Sólo escribe en su propia tabla, y ésa no tiene columnas donde quepan una
 * rareza o un precio.
 */
import { createHash } from "node:crypto";
import { sql } from "@vercel/postgres";
import { SETS_CON_ES } from "./idioma";
import { ESTADOS_IDIOMA, SENTENCIAS_IDIOMA, type EstadoIdioma } from "./idiomaEsquema";
import { MAPA_SETS_ES, candidatoTcgdex } from "./mapaSetsEs";

const API_ES = "https://api.tcgdex.net/v2/es";

/** Peticiones a TCGdex en vuelo. Medido: 6 en paralelo 181 ms, en serie 294. */
const OLEADA = 6;
/** Margen que se reserva por expansión: GET + SELECT de cards + UPSERT. */
const MARGEN_SET_MS = 4_000;
/** Margen para cerrar la oleada y responder sin que la función muera. */
const MARGEN_OLEADA_MS = 8_000;

/** Tope por petición: una respuesta que nunca llega no la detecta ningún reintento. */
const TIMEOUT_PETICION_MS = 10_000;
/**
 * Reintentos por petición (o sea, tres intentos). Cortos y pocos: aquí hay unas
 * decenas de peticiones por noche, y lo que se busca es sobrevivir a un 503
 * suelto de TCGdex, no insistirle a un servicio caído.
 */
const REINTENTOS = 2;
/** Base del respaldo exponencial: 600 ms y 1,2 s. */
const ESPERA_BASE_MS = 600;
/** Sólo se duerme si después queda tiempo para la petición que sigue. */
const MARGEN_REINTENTO_MS = 1_500;

/**
 * Cuánto puede encoger una traducción antes de sospechar. Una respuesta
 * degradada de TCGdex no puede empeorar una fila que ya estaba bien.
 */
const CAIDA_SOSPECHOSA = 0.8;

export interface ResumenIdioma {
  revisados: string[];
  actualizados: { setId: string; antes: number; ahora: number }[];
  rechazados: { setId: string; motivo: string }[];
  sinCambios: number;
  truncadoPorTiempo: boolean;
  errores: string[];
}

interface CartaTcgdex {
  localId: string;
  name: string;
  image?: string;
}

/* ------------------------------------------------------------------ *
 * ESQUEMA
 * ------------------------------------------------------------------ */

let tablasListas: Promise<void> | null = null;

/**
 * La tabla, memoizada por instancia. Va aquí y no en el `ensureSchema` de
 * app/action.ts porque aquél se espera antes de CADA compra de sobre, y esta
 * tabla no la toca ninguna: sólo la necesita este cron, una vez al día, dentro
 * de su propio presupuesto. El fallo no se cachea, para que el siguiente
 * intento vuelva a probar.
 */
function asegurarTablas(): Promise<void> {
  if (!tablasListas) {
    tablasListas = (async () => {
      for (const sentencia of SENTENCIAS_IDIOMA) await sql.query(sentencia);
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
 * COPIA DELIBERADA de `senalConTiempo` de services/ingest.ts y de
 * services/preciosIngest.ts: cada intento lleva su propio tope y nunca se
 * estira más allá de `limite` (un instante absoluto, Date.now()).
 */
function senalConTiempo(limite: number): AbortSignal {
  const restante = limite - Date.now();
  return AbortSignal.timeout(Math.max(1000, Math.min(TIMEOUT_PETICION_MS, restante)));
}

/**
 * Una petición a TCGdex, CON CORTE DE TIEMPO. Devuelve `null` para 404, que es
 * "TCGdex no conoce ese id" y no un fallo.
 *
 * EL AGUJERO QUE CIERRA: esto era un `fetch` pelado, sin `signal`. Las otras
 * tres ingestas recortan cada petición al presupuesto que queda; ésta no, y el
 * presupuesto de `sincronizarTraducciones` sólo se miraba ANTES de cada oleada.
 * Una sola respuesta colgada —la lista de expansiones a las 07:00, o un set de
 * la oleada— esperaba los 300 s por defecto de undici, Vercel mataba la función
 * a los 60 s, y esa noche no había resumen en el registro NI corrían los sobres
 * y los precios encadenados detrás (app/api/cron/sync-es/route.ts).
 *
 * LOS REINTENTOS SON POCOS Y CORTOS, y sólo ante lo que puede ser pasajero
 * (fallo de red, 429 y 5xx). Antes un 503 suelto en la lista tumbaba la noche
 * entera. Nunca se duerme más allá del presupuesto ni después del último
 * intento: una espera que no precede a nada es tiempo tirado.
 *
 * UN CORTE DE TIEMPO NO SE REINTENTA. Quien ha tardado diez segundos en no
 * contestar no va a contestar en el undécimo, y cada reintento costaría otros
 * diez: tres intentos sobre la lista colgada se comían los 30 s de las
 * traducciones enteros y dejaban a los sobres sin turno. Con uno, la noche mala
 * cuesta diez segundos y lo demás corre.
 */
async function pedir(url: string, limite: number): Promise<any | null> {
  for (let intento = 0; ; intento++) {
    const espera = ESPERA_BASE_MS * Math.pow(2, intento);
    // Se pregunta DESPUÉS de fallar, no antes de pedir: una petición que agota
    // su corte de tiempo se ha comido justo el margen que aquí se mira.
    const cabeReintento = () =>
      intento < REINTENTOS && Date.now() + espera + MARGEN_REINTENTO_MS <= limite;

    let res: Response;
    try {
      res = await fetch(url, {
        headers: { accept: "application/json" },
        cache: "no-store",
        signal: senalConTiempo(limite),
      });
    } catch (e) {
      // `AbortSignal.timeout` rechaza con un DOMException llamado TimeoutError.
      // Se mira el nombre y no la clase: es lo único que comparten los motores.
      const nombre = (e as { name?: unknown } | null)?.name;
      const porTiempo = nombre === "TimeoutError" || nombre === "AbortError";
      if (porTiempo || !cabeReintento()) {
        throw new Error("TCGdex no responde: " + (e instanceof Error ? e.message : String(e)));
      }
      await dormir(espera);
      continue;
    }
    if (res.status === 404) return null;
    if (res.ok) return res.json();
    if (![429, 500, 502, 503, 504].includes(res.status) || !cabeReintento()) {
      throw new Error("HTTP " + res.status);
    }
    await dormir(espera);
  }
}

/**
 * Huella del contenido traducido de una expansión.
 *
 * SUSTITUYE AL ETag, que TCGdex no honra (responde 200 con `no-cache` a un
 * If-None-Match). Es lo que hace barato el régimen permanente: si la huella no
 * cambió, la expansión se marca como revisada y no se toca ni `cards` ni el
 * UPSERT.
 *
 * Se ordena porque el orden del array no es contractual, e incluye `image`
 * porque una ilustración española nueva sobre un nombre ya traducido también es
 * traducción nueva.
 */
function huellaDe(cartas: CartaTcgdex[]): string {
  const h = createHash("sha256");
  for (const c of [...cartas].sort((a, b) => a.localId.localeCompare(b.localId))) {
    h.update(c.localId + "|" + c.name + "|" + (c.image ?? "") + "\n");
  }
  return h.digest("hex");
}

/**
 * Claves con las que buscar una carta inglesa dentro del set de TCGdex.
 * COPIADA de scripts/generar-diccionario-es.mjs: el repo escribe el número sin
 * ceros ("sv3pt5-1") y TCGdex con tres ("sv03.5-001"), pero los promos
 * alfanuméricos ("SWSH074", "TG01") coinciden tal cual.
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

/* ------------------------------------------------------------------ *
 * CONTABILIDAD
 * ------------------------------------------------------------------ */

async function marcar(setId: string, tcgdexId: string | null, estado: EstadoIdioma, error?: string) {
  await sql`
    INSERT INTO set_translations (set_id, lang, tcgdex_id, estado, error, revisado_en)
    VALUES (${setId}, 'es', ${tcgdexId}, ${estado}, ${error ?? null}, NOW())
    ON CONFLICT (set_id, lang) DO UPDATE
      SET tcgdex_id = COALESCE(EXCLUDED.tcgdex_id, set_translations.tcgdex_id),
          estado = EXCLUDED.estado,
          error = EXCLUDED.error,
          revisado_en = NOW()
  `;
}

/* ------------------------------------------------------------------ *
 * UNA EXPANSIÓN
 * ------------------------------------------------------------------ */

interface Trabajo {
  setId: string;
  tcgdexId: string;
  huella: string;
  traducidas: number;
}

async function procesar(t: Trabajo, forzado: boolean, limite: number): Promise<
  | { tipo: "sin-cambios" }
  | { tipo: "rechazado"; motivo: string }
  | { tipo: "actualizado"; antes: number; ahora: number }
> {
  const remoto = await pedir(API_ES + "/sets/" + encodeURIComponent(t.tcgdexId), limite);
  if (!remoto) {
    await marcar(t.setId, t.tcgdexId, ESTADOS_IDIOMA.NO_ENCONTRADO);
    return { tipo: "rechazado", motivo: "TCGdex no conoce " + t.tcgdexId };
  }
  // Que responda no basta: si devuelve OTRO id, el candidato estaba mal.
  if (String(remoto.id) !== t.tcgdexId) {
    await marcar(t.setId, t.tcgdexId, ESTADOS_IDIOMA.GUARDIA, `respondió ${remoto.id}`);
    return { tipo: "rechazado", motivo: `pedí ${t.tcgdexId} y respondió ${remoto.id}` };
  }

  const cartasRemotas: CartaTcgdex[] = Array.isArray(remoto.cards) ? remoto.cards : [];
  if (cartasRemotas.length === 0) {
    // Pasa de verdad: TCGdex lista la expansión pero sirve `cards: []`.
    await marcar(t.setId, t.tcgdexId, ESTADOS_IDIOMA.VACIO);
    return { tipo: "rechazado", motivo: "TCGdex la lista pero no sirve cartas" };
  }

  const huella = huellaDe(cartasRemotas);
  if (!forzado && huella === t.huella && t.traducidas > 0) {
    await marcar(t.setId, t.tcgdexId, ESTADOS_IDIOMA.OK);
    return { tipo: "sin-cambios" };
  }

  // Los nombres INGLESES salen de nuestra propia tabla, no de pokemontcg.io:
  // aquella API devuelve 500 y 502 de forma intermitente y meterla aquí sería
  // meter su tasa de fallo dentro del presupuesto de 45 s.
  const { rows: locales } = await sql`
    SELECT id, name, number FROM cards WHERE set_id = ${t.setId}
  `;
  if (locales.length === 0) {
    await marcar(t.setId, t.tcgdexId, ESTADOS_IDIOMA.SIN_INGLES);
    return { tipo: "rechazado", motivo: "todavía no hay cartas inglesas en la base" };
  }

  const porLocalId = new Map<string, CartaTcgdex>();
  for (const c of cartasRemotas) if (!porLocalId.has(c.localId)) porLocalId.set(c.localId, c);

  const cartas: Record<string, { n: string; i?: string }> = {};
  let sinPareja = 0;
  let nombresCambiados = 0;
  let emparejadas = 0;

  for (const local of locales) {
    const id = String(local.id);
    const sufijo = id.startsWith(t.setId + "-") ? id.slice(t.setId.length + 1) : String(local.number ?? "");
    let pareja: CartaTcgdex | undefined;
    for (const clave of candidatosDeNumero(sufijo)) {
      pareja = porLocalId.get(clave);
      if (pareja) break;
    }
    if (!pareja) { sinPareja++; continue; }
    emparejadas++;

    const cambia = pareja.name !== String(local.name);
    if (cambia) nombresCambiados++;
    // Sin nombre nuevo y sin ilustración española la entrada no aporta nada.
    if (!cambia && !pareja.image) continue;
    cartas[id] = pareja.image ? { n: pareja.name, i: pareja.image } : { n: pareja.name };
  }

  /* LAS GUARDIAS ANTIMAPEO, y aquí son OBLIGATORIAS: a diferencia del generador,
   * este cron prueba ids DERIVADOS que nadie ha revisado. Emparejar sv10 contra
   * sv08 casa el 100% de las cartas por número y escribiría 244 nombres de
   * OTRAS cartas. Los umbrales son los mismos que los del generador, medidos
   * sobre las 46 expansiones correctas (33-90% de nombres idénticos) contra
   * nueve emparejamientos falsos (0% los nueve). `sve` está exento: son las 16
   * energías básicas y sus 16 nombres cambian en español. */
  const fEmparejadas = locales.length ? emparejadas / locales.length : 0;
  const fIdenticas = emparejadas ? (emparejadas - nombresCambiados) / emparejadas : 0;
  if (t.setId !== "sve") {
    if (fEmparejadas < 0.9) {
      const motivo = `sólo empareja ${(100 * fEmparejadas).toFixed(1)}% con ${t.tcgdexId}`;
      await marcar(t.setId, t.tcgdexId, ESTADOS_IDIOMA.GUARDIA, motivo);
      return { tipo: "rechazado", motivo };
    }
    if (fIdenticas < 0.15) {
      const motivo =
        `sólo ${(100 * fIdenticas).toFixed(1)}% de los nombres coincide con ` +
        `${t.tcgdexId}: casi seguro que es OTRO set`;
      await marcar(t.setId, t.tcgdexId, ESTADOS_IDIOMA.GUARDIA, motivo);
      return { tipo: "rechazado", motivo };
    }
  }

  const ahora = Object.keys(cartas).length;
  // Una respuesta degradada no puede empeorar una fila buena.
  if (!forzado && t.traducidas > 0 && ahora < t.traducidas * CAIDA_SOSPECHOSA) {
    const motivo = `traería ${ahora} traducciones donde había ${t.traducidas}`;
    await marcar(t.setId, t.tcgdexId, ESTADOS_IDIOMA.GUARDIA, motivo);
    return { tipo: "rechazado", motivo };
  }

  await sql`
    INSERT INTO set_translations
      (set_id, lang, tcgdex_id, nombre, logo, serie, cartas, traducidas, sin_pareja,
       huella, estado, error, revisado_en, cambiado_en)
    VALUES
      (${t.setId}, 'es', ${t.tcgdexId}, ${remoto.name ?? null}, ${remoto.logo ?? null},
       ${remoto.serie?.name ?? null}, ${JSON.stringify(cartas)}::jsonb, ${ahora}, ${sinPareja},
       ${huella}, ${ESTADOS_IDIOMA.OK}, NULL, NOW(), NOW())
    ON CONFLICT (set_id, lang) DO UPDATE
      SET tcgdex_id = EXCLUDED.tcgdex_id,
          nombre = EXCLUDED.nombre,
          logo = EXCLUDED.logo,
          serie = EXCLUDED.serie,
          cartas = EXCLUDED.cartas,
          traducidas = EXCLUDED.traducidas,
          sin_pareja = EXCLUDED.sin_pareja,
          huella = EXCLUDED.huella,
          estado = EXCLUDED.estado,
          error = NULL,
          revisado_en = NOW(),
          cambiado_en = NOW()
  `;
  return { tipo: "actualizado", antes: t.traducidas, ahora };
}

/* ------------------------------------------------------------------ *
 * LA COLA
 * ------------------------------------------------------------------ */

/**
 * Qué expansiones toca revisar, de más antigua a más recientemente revisada.
 *
 * SE SIEMBRA SOLA: una expansión sin fila de contabilidad tiene la fecha cero
 * por defecto, así que es la primera de la cola. No hay cursor que se pueda
 * corromper — la propia tabla es la cola —, y lo que se quedó fuera anoche por
 * falta de tiempo sale primero mañana.
 */
async function construirCola(idsDeTcgdex: ReadonlySet<string>, forzado: string | null) {
  const { rows } = await sql`
    SELECT s.id,
           t.tcgdex_id,
           COALESCE(t.huella, '')   AS huella,
           COALESCE(t.traducidas, 0) AS traducidas
      FROM sets s
      LEFT JOIN set_translations t ON t.set_id = s.id AND t.lang = 'es'
     ORDER BY COALESCE(t.revisado_en, '1970-01-01'::timestamp) ASC,
              s.release_date DESC NULLS LAST
  `;

  const cola: Trabajo[] = [];
  const sinFuente: string[] = [];
  for (const fila of rows) {
    const setId = String(fila.id);
    if (forzado && setId !== forzado) continue;
    /* Las que ya tienen fichero estático NO se tocan: su diccionario viene
     * revisado en el despliegue y duplicarlo en la tabla no traduciría ni una
     * carta más. Con ?setId= se puede forzar una para corregirla sin desplegar. */
    if (!forzado && SETS_CON_ES.has(setId)) continue;

    // Un id ya CONFIRMADO manda sobre la conjetura.
    const tcgdexId =
      (fila.tcgdex_id ? String(fila.tcgdex_id) : null) ??
      MAPA_SETS_ES[setId] ??
      candidatoTcgdex(setId);

    if (!idsDeTcgdex.has(tcgdexId)) { sinFuente.push(setId); continue; }
    cola.push({
      setId,
      tcgdexId,
      huella: String(fila.huella ?? ""),
      traducidas: Number(fila.traducidas ?? 0),
    });
  }
  return { cola, sinFuente };
}

/* ------------------------------------------------------------------ *
 * ENTRADA
 * ------------------------------------------------------------------ */

export async function sincronizarTraducciones(opciones: {
  presupuestoMs: number;
  soloSetId?: string | null;
}): Promise<ResumenIdioma> {
  const limite = Date.now() + opciones.presupuestoMs;
  const forzado = opciones.soloSetId || null;
  const resumen: ResumenIdioma = {
    revisados: [],
    actualizados: [],
    rechazados: [],
    sinCambios: 0,
    truncadoPorTiempo: false,
    errores: [],
  };

  await asegurarTablas();

  // La lista blanca de TCGdex: una sola petición que evita preguntar por ids
  // que no existen, y con ella la conjetura del candidato se valida gratis.
  const listado = await pedir(API_ES + "/sets", limite);
  const idsDeTcgdex = new Set<string>(
    (Array.isArray(listado) ? listado : []).map((s: { id: string }) => String(s.id)),
  );
  if (idsDeTcgdex.size === 0) {
    resumen.errores.push("TCGdex no devolvió la lista de expansiones");
    return resumen;
  }

  const { cola, sinFuente } = await construirCola(idsDeTcgdex, forzado);
  for (const setId of sinFuente) {
    try {
      await marcar(setId, null, ESTADOS_IDIOMA.SIN_FUENTE);
    } catch (e) {
      resumen.errores.push(`${setId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  for (let i = 0; i < cola.length; i += OLEADA) {
    if (Date.now() > limite - MARGEN_OLEADA_MS) {
      resumen.truncadoPorTiempo = true;
      break;
    }
    const oleada = cola.slice(i, i + OLEADA);
    // Las peticiones en paralelo, las escrituras en serie: así el desperdicio
    // máximo si el presupuesto muere a mitad son cinco respuestas ya bajadas.
    await Promise.all(
      oleada.map(async (t) => {
        if (Date.now() > limite - MARGEN_SET_MS) return;
        resumen.revisados.push(t.setId);
        try {
          const r = await procesar(t, Boolean(forzado), limite);
          if (r.tipo === "sin-cambios") resumen.sinCambios++;
          else if (r.tipo === "rechazado") resumen.rechazados.push({ setId: t.setId, motivo: r.motivo });
          else resumen.actualizados.push({ setId: t.setId, antes: r.antes, ahora: r.ahora });
        } catch (e) {
          resumen.errores.push(`${t.setId}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }),
    );
  }

  return resumen;
}
