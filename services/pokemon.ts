// services/pokemon.ts
'use server'

import { sql } from '@vercel/postgres';
import { loadLocalCards } from './localData';
import { traducirCartasEs } from './idiomaBD';
import { idiomaActual } from './idiomaServidor';

/* ==================================================================== *
 * EL CATÁLOGO DE UNA EXPANSIÓN, VALIDADO Y EN MEMORIA
 * ====================================================================
 *
 * OJO: ESTE FICHERO ES 'use server', así que cada función que exporta es un
 * endpoint POST público, sin sesión. Lo que sigue son las tres cosas que le
 * faltaban a `getCardsFromSet` para serlo sin ser un regalo:
 *
 *  1. VALIDAR EL ID. Llegaba tal cual a la consulta y a un `console.log`. La
 *     consulta va parametrizada, pero el registro no: un setId con saltos de
 *     línea escribía líneas inventadas en el log de Vercel. Es la misma
 *     expresión que exige la compra de sobres (app/action.ts).
 *  2. PEDIR SÓLO LO QUE SE USA. Era `SELECT *`: unas 250 filas con
 *     `legalities`, `cardmarket`, `abilities`, `rules`, `evolves_to`... que el
 *     mapeo tiraba acto seguido. Cientos de KB de JSONB por llamada.
 *  3. RECORDARLO. Las cartas de una expansión no cambian salvo ingesta, y esto
 *     se pide en cada cambio de expansión de la tienda y en cada visita a un
 *     álbum. Mismo TTL que el catálogo del sorteo (`cartasDelSet`).
 *
 * LO QUE SE GUARDA ES EL CATÁLOGO EN INGLÉS, antes de traducir: la capa de
 * idioma se aplica en cada llamada, sobre una copia, porque el idioma es de
 * quien pregunta y no del catálogo.
 */
const SET_ID_SANO = /^[a-z0-9._-]{1,40}$/i;

/** El de `CATALOGO_TTL_MS` de app/action.ts: una resiembra se recoge sola. */
const CATALOGO_TTL_MS = 10 * 60 * 1000;
/**
 * Una expansión sin cartas en la base se recuerda poco: es lo que hay justo
 * antes de que el cron la traiga. Basta para que una ráfaga de ids inventados
 * no sea una consulta por petición.
 */
const CATALOGO_VACIO_TTL_MS = 60 * 1000;
/**
 * Entradas como mucho, contando las dos variantes. Una rica son unos cientos
 * de KB; con ids inventados sin tope, esto sería una fuga de memoria a medida.
 */
const MAX_CATALOGOS = 16;

type Variante = 'rica' | 'ligera';
const catalogos = new Map<string, { cartas: any[]; expira: number }>();

function recordar(llave: string, cartas: any[], ttl: number) {
  catalogos.delete(llave);
  catalogos.set(llave, { cartas, expira: Date.now() + ttl });
  // El Map conserva el orden de inserción: el primero es el más viejo.
  while (catalogos.size > MAX_CATALOGOS) {
    const masVieja = catalogos.keys().next().value;
    if (masVieja === undefined) break;
    catalogos.delete(masVieja);
  }
}

const parseJson = (v: any) => (typeof v === 'string' ? JSON.parse(v) : v);
// Las columnas JSONB guardan `null` cuando la carta no traía el dato (la
// ingesta escribe JSON.stringify(v ?? null)). Quien consume estas listas las
// recorre con .some()/.map(), así que un null reventaría: se normaliza a [].
const parseArray = (v: unknown): unknown[] => {
  const parsed = parseJson(v);
  return Array.isArray(parsed) ? parsed : [];
};

/** Los cinco campos que usan la tienda y la apertura de un sobre. */
const aCartaLigera = (row: any) => ({
  id: row.id,
  name: row.name,
  rarity: row.rarity,
  set: { id: row.set_id },
  images: parseJson(row.images),
  number: row.number,
});

const aCartaRica = (row: any) => ({
  ...aCartaLigera(row),
  tcgplayer: parseJson(row.tcgplayer),
  artist: row.artist,
  flavorText: row.flavor_text,
  hp: row.hp,
  types: parseArray(row.types),
  attacks: parseArray(row.attacks),
  weaknesses: parseArray(row.weaknesses),
  retreatCost: parseArray(row.retreat_cost),
  supertype: row.supertype,
  // Estos tres los escribe la ingesta (columnas subtypes, evolves_from y
  // national_pokedex_numbers) pero el mapeo los descartaba. Sin ellos los
  // filtros del mercado de "etapa", "evolucion" y "pokedex" no casan con
  // ninguna carta: la oferta se vuelve imposible sin decir por qué.
  subtypes: parseArray(row.subtypes),
  evolvesFrom: row.evolves_from ?? undefined,
  nationalPokedexNumbers: parseArray(row.national_pokedex_numbers),
});

/** El respaldo local, recortado a la variante ligera si es la que se pide. */
async function catalogoLocal(setId: string, variante: Variante): Promise<any[]> {
  const locales = (await loadLocalCards(setId)) as any[];
  if (variante === 'rica') return locales;
  return locales.map((c) => ({
    id: c.id,
    name: c.name,
    rarity: c.rarity,
    set: c.set,
    images: c.images,
    number: c.number,
  }));
}

/**
 * Catálogo EN INGLÉS de una expansión, de la memoria o de Postgres. `setId` ya
 * viene validado. Nunca lanza: sin base, o con la expansión sin sembrar, sirve
 * las cartas del repositorio.
 */
async function catalogoDeSet(setId: string, variante: Variante): Promise<any[]> {
  const llave = `${variante}:${setId}`;
  const ahora = Date.now();
  const guardado = catalogos.get(llave);
  if (guardado && guardado.expira > ahora) return guardado.cartas;

  // La ligera se saca de la rica si ya está en memoria: cero consultas.
  if (variante === 'ligera') {
    const rica = catalogos.get(`rica:${setId}`);
    if (rica && rica.expira > ahora) {
      const ligeras = rica.cartas.map((c) => ({
        id: c.id,
        name: c.name,
        rarity: c.rarity,
        set: c.set,
        images: c.images,
        number: c.number,
      }));
      recordar(llave, ligeras, rica.expira - ahora);
      return ligeras;
    }
  }

  try {
    // Una sentencia por variante, cada una con las columnas que su mapeo lee y
    // ni una más. El ORDER BY ordena los números como números (1, 2, 10) y deja
    // detrás los que no lo son ("GG01", "TG12"). `{1,9}` y no `+`: un número
    // de diez cifras desbordaría el `::int` y tumbaría la consulta entera.
    const { rows } =
      variante === 'rica'
        ? await sql`
            SELECT id, name, rarity, set_id, images, number,
                   tcgplayer, artist, flavor_text, hp, types, attacks,
                   weaknesses, retreat_cost, supertype, subtypes,
                   evolves_from, national_pokedex_numbers
              FROM cards
             WHERE set_id = ${setId}
             ORDER BY
               CASE WHEN number ~ '^[0-9]{1,9}$' THEN number::int ELSE 999999999 END ASC,
               number ASC
          `
        : await sql`
            SELECT id, name, rarity, set_id, images, number
              FROM cards
             WHERE set_id = ${setId}
             ORDER BY
               CASE WHEN number ~ '^[0-9]{1,9}$' THEN number::int ELSE 999999999 END ASC,
               number ASC
          `;

    if (rows.length === 0) {
      // Sin sembrar todavía: el JSON local, y se recuerda poco rato.
      const locales = await catalogoLocal(setId, variante);
      recordar(llave, locales, CATALOGO_VACIO_TTL_MS);
      return locales;
    }

    const cartas = rows.map(variante === 'rica' ? aCartaRica : aCartaLigera);
    /* SÓLO SE RECUERDA UN CATÁLOGO COMPLETO, con el mismo criterio que
     * `cartasDelSet` en app/action.ts: una expansión a medio sembrar tiene
     * menos cartas en la base que su fichero del repositorio, y guardarla diez
     * minutos sería enseñar diez minutos un álbum con huecos que no existen. */
    const locales = (await loadLocalCards(setId)) as any[];
    if (cartas.length >= locales.length) recordar(llave, cartas, CATALOGO_TTL_MS);
    return cartas;
  } catch (error) {
    // Sin Postgres configurado seguimos sirviendo las cartas del repositorio.
    // El fallo NO se recuerda: la siguiente llamada vuelve a probar la base.
    // El setId ya pasó la validación: no puede traer saltos de línea al log.
    console.error(`❌ Error leyendo el catálogo de ${setId}, uso el JSON local:`, error);
    return catalogoLocal(setId, variante);
  }
}

/** Aplica la capa de idioma sobre una COPIA: la lista guardada no se toca. */
async function enIdiomaDelUsuario(cartas: any[]): Promise<any[]> {
  const idioma = await idiomaActual();
  // Array MUTABLE: `traducirCartas` devuelve readonly para que React no repinte
  // de balde, pero el álbum y la tienda ordenan y filtran la lista en sitio.
  return idioma === "es" ? [...(await traducirCartasEs(cartas, idioma))] : cartas.slice();
}

/**
 * Cartas de una expansión, YA EN EL IDIOMA DEL USUARIO.
 *
 * DÓNDE ENTRA LA CAPA Y POR QUÉ AQUÍ: ésta es la frontera por la que las cartas
 * de un set salen hacia la interfaz (la tienda de la portada y el álbum), así
 * que traducir en este `return` cubre las dos pantallas de una vez y el
 * diccionario no sale del servidor. NO se traduce en `loadLocalCards`, que es
 * la fuente cruda: de ella beben también comprobaciones internas (el respaldo
 * del mercado en app/action.ts) que emparejan por nombre INGLÉS —`evolvesFrom`,
 * la inicial del nombre— y que se romperían con nombres traducidos.
 *
 * `traducirCartas` sólo cambia `name` e `images`: id, rareza y expansión —de
 * donde cuelga toda la economía— se copian tal cual.
 */
export async function getCardsFromSet(setId: string) {
  // Un id que no puede ser de ninguna expansión no llega ni a la base ni al
  // registro. `typeof` porque esto es un endpoint: llega lo que mande el cliente.
  if (typeof setId !== "string" || !SET_ID_SANO.test(setId)) return [];
  return enIdiomaDelUsuario(await catalogoDeSet(setId, 'rica'));
}

/**
 * Lo mismo, con SÓLO los campos que usan la tienda y la apertura de un sobre:
 * id, name, rarity, images, number y set.
 *
 * POR QUÉ EXISTE: la portada pide el catálogo RICO de cada expansión que se
 * toca —ataques, debilidades, coste de retirada, texto de ambiente, precios de
 * tcgplayer...— y de todo eso usa estos campos. Medido sobre las 252 cartas de
 * sv8, en JSON sin comprimir: 167 KB la rica, 53 KB ésta. Es menos de un
 * tercio, por datos móviles y justo en el momento en que se espera abrir un
 * sobre. El álbum sí necesita la ficha rica y sigue con `getCardsFromSet`; el
 * detalle de una carta la vuelve a pedir entera de todas formas
 * (`getCardFromDB`).
 *
 * A FECHA DEL COMMIT d4d558e TODAVÍA NO LA LLAMA NADIE: la portada
 * (app/page.tsx) sigue pasando `getCardsFromSet` a su caché de catálogos.
 * Cambiar esa referencia por ésta es lo único que falta.
 *
 * `traducirCartasEs` sólo toca `name` e `images`, así que la capa de idioma
 * funciona igual sobre esta forma.
 */
export async function getCartasLigerasDeSet(setId: string) {
  if (typeof setId !== "string" || !SET_ID_SANO.test(setId)) return [];
  return enIdiomaDelUsuario(await catalogoDeSet(setId, 'ligera'));
}
