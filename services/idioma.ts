/**
 * Capa de presentación en español sobre las cartas y expansiones.
 *
 * POR QUÉ es sólo una capa y no un cambio de datos: el id canónico de la app
 * sigue siendo el de pokemontcg.io. Rareza, precios de venta, lógica de sobres y
 * los bonos de expansión (set_rewards) cuelgan de ese id y de ese vocabulario de
 * rarezas. Traducir de verdad los datos rompería el JOIN de la colección y
 * regalaría o robaría monedas. Aquí sólo se cambian `name` y `images`.
 *
 * REGLA DURA: este módulo NUNCA toca id, rarity, set.id, precios ni nada de lo
 * que dependa la economía. Si algún día hace falta un campo más, que sea sólo
 * texto visible.
 *
 * COSTE EN EL NAVEGADOR: el diccionario completo son ~623 KB repartidos en 38
 * ficheros. Meterlos todos en el bundle sería absurdo para enseñar una
 * expansión de 24 KB, así que:
 *   - `indice.json` (6,6 KB) se importa de forma estática: trae el nombre y el
 *     logo español de las 38 expansiones, que es lo que necesitan las pantallas
 *     de listado, y sirve de lista blanca para no lanzar imports que fallarían.
 *   - el diccionario de cartas de cada expansión se carga con `import()`
 *     dinámico, así que el empaquetador le da un chunk propio y el cliente sólo
 *     descarga la expansión que está mirando. En el servidor es un require
 *     normal y se queda cacheado en memoria.
 * Funciona igual en servidor y en cliente: no se usa `fs` en ningún punto.
 */

import indiceCrudo from "../src/data/es/indice.json";

export type Idioma = "en" | "es";

/** Entrada del índice: lo mínimo para pintar una expansión sin cargar su set. */
interface EntradaIndice {
  idEs: string;
  nombre: string;
  logo: string | null;
  serie: string | null;
  traducidas: number;
}

/** Una carta del diccionario: `n` nombre español, `i` URL base de la imagen. */
interface EntradaCarta {
  n: string;
  /** Ausente cuando TCGdex no tiene ilustración española (448 cartas). */
  i?: string;
}

export interface DiccionarioSet {
  set: {
    id: string;
    idEs: string;
    nombre: string;
    nombreEn: string | null;
    logo: string | null;
    serie: string | null;
  };
  /** Ids locales que TCGdex no tiene. Se quedan en inglés. */
  sinPareja: string[];
  cartas: Record<string, EntradaCarta | undefined>;
}

export interface ImagenesCarta {
  small?: string;
  large?: string;
}

/** Lo mínimo que este módulo necesita leer de una carta. */
export interface CartaTraducible {
  id: string;
  name?: string;
  images?: ImagenesCarta | null;
  set?: { id?: string } | null;
}

/** Lo mínimo que este módulo necesita leer de una expansión. */
export interface SetTraducible {
  id: string;
  name?: string;
  series?: string;
  images?: { logo?: string; symbol?: string } | null;
}

/** Respaldo inglés: hay expansiones enteras sin ilustración española. */
export interface RespaldoIngles {
  nameEn?: string;
  imagesEn?: ImagenesCarta | null;
  idioma?: Idioma;
}

const INDICE = indiceCrudo as Record<string, EntradaIndice>;

/** Expansiones con diccionario español generado. */
export const SETS_CON_ES: ReadonlySet<string> = new Set(Object.keys(INDICE));

export function tieneEspanol(setId: string): boolean {
  return SETS_CON_ES.has(setId);
}

export function esIdioma(valor: unknown): valor is Idioma {
  return valor === "en" || valor === "es";
}

/** Cualquier cosa que no sea "es" se trata como inglés: el inglés es el dato. */
export function normalizarIdioma(valor: unknown): Idioma {
  return valor === "es" ? "es" : "en";
}

/**
 * TCGdex sirve la imagen en <base>/<tamaño>.<extensión>; la URL base a secas da
 * 404.
 *
 * LAS DOS EN WEBP. Medido sobre las 31 expansiones con ilustración española
 * (una carta por expansión, cabecera Range): high.png suma 24,7 MB y high.webp
 * 1,75 MB — 14,2 veces menos, y ninguna de las dos falla. Con PNG la carta
 * ampliada española pesaba 887 KB frente a los 690 KB de la inglesa de
 * pokemontcg.io, y además a menos resolución (600 px contra 734): pasar al
 * español encarecía la pantalla de detalle, justo lo contrario de lo que
 * persigue el presupuesto de datos que documenta next.config.ts.
 *
 * Y no hay nada que "aceptar": la pequeña YA es webp (low.webp) y se pinta en
 * toda la rejilla, así que un navegador sin webp llevaba roto el español desde
 * el primer día. Nada del código mira la extensión: PokemonCard y
 * CardDetailModal sólo pasan la URL a `src`.
 */
export function construirImagenesEs(base: string): ImagenesCarta {
  return { small: base + "/low.webp", large: base + "/high.webp" };
}

/** El logo español también viene sin extensión. */
export function construirLogoEs(base: string): string {
  return base + ".png";
}

// Promesas cacheadas por expansión. Se guarda la promesa, no el valor, para que
// dos pantallas que piden el mismo set a la vez compartan una única descarga.
const enCurso = new Map<string, Promise<DiccionarioSet | null>>();

/**
 * Carga (una sola vez) el diccionario de una expansión. Devuelve null si el
 * idioma es inglés o si esa expansión no tiene español.
 */
export function cargarDiccionario(
  setId: string,
  idioma: Idioma,
): Promise<DiccionarioSet | null> {
  if (idioma !== "es" || !SETS_CON_ES.has(setId)) return Promise.resolve(null);

  const cacheada = enCurso.get(setId);
  if (cacheada) return cacheada;

  // El id ya está validado contra la lista blanca del índice, así que la
  // plantilla no puede apuntar fuera del directorio.
  const promesa = import(`../src/data/es/${setId}.json`)
    .then((mod) => (mod.default ?? mod) as DiccionarioSet)
    .catch(() => null);

  enCurso.set(setId, promesa);
  return promesa;
}

/** Deja listos varios diccionarios de golpe (p. ej. antes de pintar un mazo). */
export async function precargarIdioma(
  setIds: Iterable<string>,
  idioma: Idioma,
): Promise<void> {
  if (idioma !== "es") return;
  await Promise.all(
    [...new Set(setIds)].map((id) => cargarDiccionario(id, idioma)),
  );
}

/** El id de expansión de una carta: del campo `set`, o del prefijo del id. */
function setDeCarta(carta: CartaTraducible): string {
  const declarado = carta.set?.id;
  if (declarado) return declarado;
  const guion = carta.id.indexOf("-");
  return guion > 0 ? carta.id.slice(0, guion) : carta.id;
}

/**
 * Traducción síncrona con un diccionario ya cargado. Es el núcleo: todo lo
 * demás sólo se encarga de conseguir el diccionario.
 *
 * Devuelve LA MISMA REFERENCIA cuando no hay nada que traducir, para que React
 * no vuelva a pintar de balde.
 */
export function traducirCartaCon<T extends CartaTraducible>(
  carta: T,
  dicc: DiccionarioSet | null | undefined,
): T & RespaldoIngles {
  const entrada = dicc?.cartas[carta.id];
  if (!entrada) return carta;

  const imagenesEn = carta.images ?? null;
  // Sólo `name` e `images`. Nada de id, rarity, number, precios ni set.id: de
  // ahí cuelga la economía y se copia tal cual con el spread.
  return {
    ...carta,
    name: entrada.n,
    images: entrada.i ? construirImagenesEs(entrada.i) : imagenesEn,
    // Respaldo accesible: swsh45sv, sve, las Trainer Gallery y swsh12pt5gg no
    // tienen ninguna ilustración española.
    nameEn: carta.name,
    imagesEn: imagenesEn,
    idioma: "es" as const,
  };
}

/** Traduce una carta. Con "en" devuelve la misma referencia sin cargar nada. */
export async function traducirCarta<T extends CartaTraducible>(
  carta: T,
  idioma: Idioma,
): Promise<T & RespaldoIngles> {
  if (idioma !== "es") return carta;
  const dicc = await cargarDiccionario(setDeCarta(carta), idioma);
  return traducirCartaCon(carta, dicc);
}

/**
 * Traduce una lista. Agrupa por expansión para cargar cada diccionario una vez,
 * aunque la lista mezcle sets (la colección y el mercado lo hacen).
 */
export async function traducirCartas<T extends CartaTraducible>(
  cartas: readonly T[],
  idioma: Idioma,
): Promise<readonly (T & RespaldoIngles)[]> {
  if (idioma !== "es" || cartas.length === 0) return cartas;

  const ids = new Set(cartas.map(setDeCarta));
  const cargados = await Promise.all(
    [...ids].map(async (id) => [id, await cargarDiccionario(id, idioma)] as const),
  );
  const porSet = new Map(cargados);

  let algunaCambio = false;
  const salida = cartas.map((c) => {
    const t = traducirCartaCon(c, porSet.get(setDeCarta(c)));
    if (t !== c) algunaCambio = true;
    return t;
  });
  // Si ninguna carta tenía traducción devolvemos el array original: quien lo
  // use como dependencia de un efecto no verá un cambio falso.
  return algunaCambio ? salida : cartas;
}

/**
 * Traduce una expansión. Es SÍNCRONA a propósito: el nombre y el logo españoles
 * están en el índice estático, así que la pantalla de expansiones traduce las
 * 38 sin descargar ningún diccionario de cartas.
 */
export function traducirSet<T extends SetTraducible>(
  set: T,
  idioma: Idioma,
): T & { nameEn?: string; serieEs?: string | null } {
  if (idioma !== "es") return set;
  const entrada = INDICE[set.id];
  if (!entrada) return set;

  const logoEn = set.images?.logo;
  return {
    ...set,
    name: entrada.nombre,
    images: {
      ...(set.images ?? {}),
      // Sin logo español (swsh45sv) se queda el inglés.
      logo: entrada.logo ? construirLogoEs(entrada.logo) : logoEn,
    },
    nameEn: set.name,
    serieEs: entrada.serie,
  };
}

export function traducirSets<T extends SetTraducible>(
  sets: readonly T[],
  idioma: Idioma,
): readonly (T & { nameEn?: string; serieEs?: string | null })[] {
  if (idioma !== "es") return sets;
  return sets.map((s) => traducirSet(s, idioma));
}

/** Nombre español de una expansión sin construir el objeto entero. */
export function nombreSetEs(setId: string, idioma: Idioma): string | null {
  if (idioma !== "es") return null;
  return INDICE[setId]?.nombre ?? null;
}
