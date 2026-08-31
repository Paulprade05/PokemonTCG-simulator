/**
 * CAPA DE TRADUCCIONES DE BASE DE DATOS, superpuesta a los ficheros estáticos.
 *
 * POR QUÉ EXISTE: `src/data/es/*.json` son artefactos de DESPLIEGUE, y en Vercel
 * el sistema de ficheros es de sólo lectura. El cron de traducciones descubre
 * cada día expansiones que TCGdex ya ha traducido, pero no puede escribirlas
 * ahí; las escribe en `set_translations` y este módulo las aplica encima.
 *
 * POR QUÉ AQUÍ Y NO EN services/idioma.ts: aquél es PURO —sin fs, sin base de
 * datos, sin `next/headers`— y esa pureza es lo que le permite funcionar igual
 * en servidor y en cliente, lo que hace que su `import()` con plantilla resuelva
 * a un chunk por expansión, y lo que deja que `scripts/probar-idioma.mjs` lo
 * pruebe fuera de Next. Meter Postgres allí rompería las tres cosas.
 *
 * EL SUELO NO SE MUEVE. Los ficheros estáticos siguen siendo la base: esta capa
 * sólo AÑADE. Si Postgres falla, si la tabla no existe todavía o si está vacía,
 * todas las funciones devuelven exactamente lo que devolvían antes —incluida la
 * misma REFERENCIA cuando no hay nada que traducir, que es el contrato que evita
 * repintados en React—. Cuatro puertas lo garantizan: `leerManifiesto`,
 * `parchesDeSets`, `fusionar` y `capaEs`.
 *
 * Y LO QUE NO TOCA: ni id, ni rarity, ni number, ni set.id, ni precios. Igual
 * que la capa estática, sólo `name` e `images`.
 */
import { sql } from "@vercel/postgres";
import {
  SETS_CON_ES,
  cargarDiccionario,
  construirLogoEs,
  nombreSetEs as nombreSetEstatico,
  traducirCartaCon,
  traducirSet as traducirSetEstatico,
  type DiccionarioSet,
  type CartaTraducible,
  type Idioma,
  type RespaldoIngles,
  type SetTraducible,
} from "./idioma";
import { ESTADOS_IDIOMA } from "./idiomaEsquema";

/** Entradas de carta tal y como las guarda la tabla: la forma del fichero. */
type CartasEs = DiccionarioSet["cartas"];

interface ParcheSet {
  nombre: string | null;
  logo: string | null;
  serie: string | null;
  cartas: CartasEs;
}

/**
 * Qué expansiones tiene traducidas la tabla, SIN traerse sus cartas.
 *
 * Es una consulta deliberadamente flaca: `cartas` es un JSONB grande que vive en
 * TOAST, así que no seleccionarlo significa no leerlo. Con esto se resuelven el
 * chip «EN» de la tienda, `nombreSetEs` y `traducirSet` sin tocar el peso.
 */
interface Manifiesto {
  /** Expansiones con al menos una CARTA traducida en la tabla. */
  conCartas: ReadonlySet<string>;
  /** Metadatos de expansión (nombre, logo, serie) por id. */
  sets: ReadonlyMap<string, { nombre: string | null; logo: string | null; serie: string | null }>;
}

const MANIFIESTO_VACIO: Manifiesto = { conCartas: new Set(), sets: new Map() };

/* ------------------------------------------------------------------ *
 * CACHÉ POR INSTANCIA
 * ------------------------------------------------------------------
 * Mismo patrón que `catalogoDeSet` en app/action.ts: sin caché, cada pantalla
 * que pinta cartas pagaría una consulta. El TTL corto del fallo es lo que evita
 * que una caída de Postgres se convierta en una consulta por render.
 */
const TTL_MS = 10 * 60 * 1000;
const TTL_FALLO_MS = 60 * 1000;

let manifiestoCache: { valor: Promise<Manifiesto>; expira: number } | null = null;

async function leerManifiesto(): Promise<Manifiesto> {
  const ahora = Date.now();
  if (manifiestoCache && manifiestoCache.expira > ahora) return manifiestoCache.valor;

  const entrada = { expira: ahora + TTL_MS, valor: null as unknown as Promise<Manifiesto> };
  entrada.valor = (async () => {
    const { rows } = await sql`
      SELECT set_id, nombre, logo, serie, traducidas
        FROM set_translations
       WHERE lang = 'es' AND estado = ${ESTADOS_IDIOMA.OK}
    `;
    const conCartas = new Set<string>();
    const sets = new Map<string, { nombre: string | null; logo: string | null; serie: string | null }>();
    for (const r of rows) {
      const id = String(r.set_id);
      // `conCartas` filtra por traducidas > 0 a propósito: una expansión con
      // sólo el nombre traducido pintaría su álbum entero en inglés, así que
      // debe seguir marcada con el chip «EN».
      if (Number(r.traducidas) > 0) conCartas.add(id);
      sets.set(id, {
        nombre: r.nombre ? String(r.nombre) : null,
        logo: r.logo ? String(r.logo) : null,
        serie: r.serie ? String(r.serie) : null,
      });
    }
    return { conCartas, sets };
  })().catch((e) => {
    // Sin tabla todavía (despliegue nuevo sin /migrate-core) o Postgres caído:
    // se degrada al diccionario estático, que es lo que había antes de esto.
    console.error("[idiomaBD] manifiesto:", e instanceof Error ? e.message : e);
    entrada.expira = Date.now() + TTL_FALLO_MS;
    return MANIFIESTO_VACIO;
  });

  manifiestoCache = entrada;
  return entrada.valor;
}

const parcheCache = new Map<string, { valor: Promise<ParcheSet | null>; expira: number }>();

/** Trae los parches de varias expansiones, saltándose las que no tienen. */
async function parchesDeSets(ids: Iterable<string>): Promise<Map<string, ParcheSet | null>> {
  const salida = new Map<string, ParcheSet | null>();
  const ahora = Date.now();

  // El manifiesto evita por completo la consulta de las expansiones sin parche,
  // que son la inmensa mayoría en cualquier colección.
  const manifiesto = await leerManifiesto();
  const pendientes: string[] = [];
  for (const id of new Set(ids)) {
    if (!manifiesto.conCartas.has(id)) {
      salida.set(id, null);
      continue;
    }
    const cacheada = parcheCache.get(id);
    if (cacheada && cacheada.expira > ahora) {
      salida.set(id, await cacheada.valor);
      continue;
    }
    pendientes.push(id);
  }
  if (pendientes.length === 0) return salida;

  try {
    const { rows } = await sql.query(
      `SELECT set_id, nombre, logo, serie, cartas
         FROM set_translations
        WHERE lang = 'es' AND estado = $2 AND set_id = ANY($1::text[])`,
      [pendientes, ESTADOS_IDIOMA.OK],
    );
    const porId = new Map<string, ParcheSet>();
    for (const r of rows) {
      const cartas = (typeof r.cartas === "string" ? JSON.parse(r.cartas) : r.cartas) as CartasEs;
      porId.set(String(r.set_id), {
        nombre: r.nombre ? String(r.nombre) : null,
        logo: r.logo ? String(r.logo) : null,
        serie: r.serie ? String(r.serie) : null,
        cartas: cartas ?? {},
      });
    }
    for (const id of pendientes) {
      const p = porId.get(id) ?? null;
      salida.set(id, p);
      parcheCache.set(id, { valor: Promise.resolve(p), expira: ahora + TTL_MS });
    }
  } catch (e) {
    console.error("[idiomaBD] parches:", e instanceof Error ? e.message : e);
    for (const id of pendientes) salida.set(id, null);
  }
  return salida;
}

/**
 * Funde el diccionario estático con el parche de la tabla.
 *
 * EL ESTÁTICO GANA carta a carta: viene revisado y commiteado, mientras que el
 * parche lo escribió un cron contra una API viva. Así una traducción que ya
 * estaba no puede empeorar, y el parche sólo rellena huecos.
 *
 * Devuelve LA MISMA REFERENCIA cuando no hay nada que fundir, para no romper el
 * contrato de identidad de `traducirCartas`.
 */
function fusionar(
  setId: string,
  base: DiccionarioSet | null,
  parche: ParcheSet | null | undefined,
): DiccionarioSet | null {
  if (!parche) return base;
  const suyas = parche.cartas ?? {};
  if (Object.keys(suyas).length === 0) return base;
  if (!base) {
    return {
      set: {
        id: setId,
        idEs: setId,
        nombre: parche.nombre ?? setId,
        nombreEn: null,
        logo: parche.logo,
        serie: parche.serie,
      },
      sinPareja: [],
      cartas: suyas,
    };
  }
  return { ...base, cartas: { ...suyas, ...base.cartas } };
}

/**
 * Traduce una lista de cartas aplicando estático + tabla.
 *
 * Sustituye a `traducirCartas` en todos los puntos del servidor. Mismo contrato:
 * con idioma inglés, o si no hay nada que traducir, devuelve el MISMO array.
 */
export async function traducirCartasEs<T extends CartaTraducible>(
  cartas: readonly T[],
  idioma: Idioma,
): Promise<readonly (T & RespaldoIngles)[]> {
  if (idioma !== "es" || cartas.length === 0) return cartas;

  const setDe = (c: T) => {
    const declarado = c.set?.id;
    if (declarado) return declarado;
    const guion = c.id.indexOf("-");
    return guion > 0 ? c.id.slice(0, guion) : c.id;
  };

  const ids = new Set(cartas.map(setDe));
  const [estaticos, parcheados] = await Promise.all([
    Promise.all([...ids].map(async (id) => [id, await cargarDiccionario(id, "es")] as const)),
    parchesDeSets(ids),
  ]);

  const porSet = new Map<string, DiccionarioSet | null>();
  for (const [id, base] of estaticos) porSet.set(id, fusionar(id, base, parcheados.get(id)));

  let cambio = false;
  const salida = cartas.map((c) => {
    const t = traducirCartaCon(c, porSet.get(setDe(c)));
    if (t !== c) cambio = true;
    return t;
  });
  return cambio ? salida : cartas;
}

/**
 * FOTO SÍNCRONA DE LA CAPA DE EXPANSIONES.
 *
 * `nombreSetEs` y `traducirSet` son SÍNCRONAS a propósito y se llaman dentro de
 * bucles. Volverlas asíncronas obligaría a reescribir esos bucles y abriría la
 * puerta a una consulta por expansión pintada. Con esto, cada función hace UN
 * `await capaEs(idioma)` al lado del `await idiomaActual()` que ya hacía, y el
 * resto del código no cambia de forma.
 */
export interface CapaEs {
  readonly setsConEs: ReadonlySet<string>;
  tieneEspanol(setId: string): boolean;
  nombreSet(setId: string): string | null;
  traducirSet<T extends SetTraducible>(s: T): T & { nameEn?: string; serieEs?: string | null };
  traducirSets<T extends SetTraducible>(
    s: readonly T[],
  ): readonly (T & { nameEn?: string; serieEs?: string | null })[];
}

/** En inglés no se toca Postgres: identidad pura, exactamente como hoy. */
const CAPA_EN: CapaEs = {
  setsConEs: SETS_CON_ES,
  tieneEspanol: (id) => SETS_CON_ES.has(id),
  nombreSet: () => null,
  traducirSet: (s) => s,
  traducirSets: (s) => s,
};

export async function capaEs(idioma: Idioma): Promise<CapaEs> {
  if (idioma !== "es") return CAPA_EN;
  const manifiesto = await leerManifiesto();
  const setsConEs: ReadonlySet<string> = new Set([...SETS_CON_ES, ...manifiesto.conCartas]);

  const capa: CapaEs = {
    setsConEs,
    tieneEspanol: (id) => setsConEs.has(id),
    nombreSet: (id) => manifiesto.sets.get(id)?.nombre ?? nombreSetEstatico(id, "es"),
    traducirSet<T extends SetTraducible>(set: T) {
      // Primero lo de siempre, para no perder nada de lo estático.
      const estatico = traducirSetEstatico(set, "es");
      const meta = manifiesto.sets.get(set.id);
      if (!meta?.nombre) return estatico;
      return {
        ...estatico,
        name: meta.nombre,
        images: {
          ...(estatico.images ?? {}),
          ...(meta.logo ? { logo: construirLogoEs(meta.logo) } : {}),
        },
        // El respaldo inglés sale SIEMPRE del original y nunca del estático: la
        // tienda decide con `nameEn` qué sobres vende, y ese filtro no puede
        // depender del idioma en que se mire.
        nameEn: set.name,
        serieEs: meta.serie ?? (estatico as { serieEs?: string | null }).serieEs ?? null,
      } as T & { nameEn?: string; serieEs?: string | null };
    },
    traducirSets<T extends SetTraducible>(sets: readonly T[]) {
      return sets.map((s) => capa.traducirSet(s));
    },
  };
  return capa;
}

/** Expansiones con español por cualquiera de las dos vías. Lo usa el aviso del cron. */
export async function setsConEspanol(): Promise<ReadonlySet<string>> {
  const manifiesto = await leerManifiesto();
  return new Set([...SETS_CON_ES, ...manifiesto.conCartas]);
}

/** Diccionario fusionado de UNA expansión. Lo usa el índice del buscador. */
export async function diccionarioEs(setId: string): Promise<DiccionarioSet | null> {
  const [base, parches] = await Promise.all([
    cargarDiccionario(setId, "es"),
    parchesDeSets([setId]),
  ]);
  return fusionar(setId, base, parches.get(setId));
}
