// components/vitrina/modelo.ts
//
// EL MODELO DEL ARCHIVADOR: qué carta hay en cada funda. Sin una línea de
// React, a propósito.
//
// ============================================================================
// POR QUÉ EXISTE ESTE FICHERO
// ============================================================================
//
// El archivador se lee de DOS SITIOS con formas distintas:
//
//  · Con sesión, de `getArchivador()` (app/action.ts), que devuelve las fundas
//    ocupadas YA CRUZADAS con la tabla `cards`: nombre, rareza, ilustración y
//    las copias que se tienen HOY.
//  · Sin sesión, de `leerArchivadorLocal()` (utils/archivadorLocal.ts), que
//    sólo guarda {hoja, ranura, cardId} — el navegador del invitado no tiene
//    catálogo, así que el resto hay que cruzarlo a mano con su colección de
//    localStorage.
//
// La pantalla no puede saber de esa diferencia: LA VITRINA TIENE QUE
// FUNCIONAR IGUAL CON CUENTA Y SIN ELLA, y la única forma de que eso no se
// rompa a la primera es que las dos rutas produzcan exactamente el mismo tipo
// (`FundaVitrina`) y que todo lo de arriba trabaje sólo con él.
//
// Vive en components/vitrina/ y no en utils/ porque es el modelo de ESTA
// pantalla y de ninguna más; sacarlo a utils/ invitaría a que otra pantalla lo
// importase y a que dejara de poder cambiar sin romper nada.
//
// ============================================================================
// LO QUE NO SE GUARDA
// ============================================================================
//
// Las fundas VACÍAS no existen como dato, ni aquí ni en el servidor. La rejilla
// de nueve la dibuja siempre la hoja y encima se coloca lo que haya. Guardar
// las vacías significaría escribir 531 filas por archivador para no decir nada,
// y tener que filtrarlas en cada lectura.

import type { CartaEnColeccion } from "../../utils/tipos";
import {
  MAX_HOJAS,
  RANURAS_POR_HOJA,
  type FundaLocal,
} from "../../utils/archivadorLocal";

export { MAX_HOJAS, RANURAS_POR_HOJA };

/**
 * Una funda OCUPADA.
 *
 * `carta.quantity` NO son las copias que hay en esta funda —siempre es una—,
 * sino las que el jugador tiene hoy de esa carta. Puede ser 0: la funda no se
 * vacía sola cuando se vende la carta (sería borrarle algo que él puso), así
 * que la pantalla la marca en vez de hacerla desaparecer.
 */
export interface FundaVitrina {
  hoja: number;
  ranura: number;
  carta: CartaEnColeccion;
}

/** Dónde va a parar una carta: la funda que se está tocando. */
export interface Destino {
  hoja: number;
  ranura: number;
}

/** Clave de una funda para los mapas. `hoja:ranura` es única por archivador. */
export function claveFunda(hoja: number, ranura: number): string {
  return `${hoja}:${ranura}`;
}

/**
 * El id de una carta es `set-numero`: el set es todo lo anterior al ÚLTIMO
 * guion. Se saca aquí porque el selector filtra por expansión y la colección
 * del invitado no trae `set` como campo aparte.
 */
export function setDeCarta(id: string): string {
  const guion = String(id).lastIndexOf("-");
  return guion > 0 ? String(id).slice(0, guion) : "";
}

/**
 * Índice funda→contenido. La hoja pide sus nueve posiciones en cada pintado y
 * durante un pase de página se pintan DOS hojas, así que recorrer la lista
 * entera por casilla serían 18 barridos por fotograma.
 */
export function mapaDeFundas(
  fundas: FundaVitrina[],
): Map<string, FundaVitrina> {
  const mapa = new Map<string, FundaVitrina>();
  for (const f of fundas) mapa.set(claveFunda(f.hoja, f.ranura), f);
  return mapa;
}

/**
 * Cuántas fundas ocupa ya cada carta.
 *
 * Es la cuenta que decide si una carta se puede ofrecer en el selector: la
 * misma puede ir en varias fundas —quien tiene tres Pikachu puede enseñar los
 * tres— pero nunca más veces que copias tenga. El servidor comprueba lo mismo
 * dentro de la sentencia (`sin-copias-libres`); esto es sólo para no OFRECER
 * algo que va a fallar.
 */
export function colocadasPorCarta(fundas: FundaVitrina[]): Map<string, number> {
  const mapa = new Map<string, number>();
  for (const f of fundas) {
    mapa.set(f.carta.id, (mapa.get(f.carta.id) ?? 0) + 1);
  }
  return mapa;
}

/**
 * Cuántas hojas se montan.
 *
 * Aquí no hay colección que paginar —el archivador nace vacío y crece a mano—
 * así que el total lo decide esta función con una sola regla: SIEMPRE UNA HOJA
 * VACÍA DESPUÉS DE LA ÚLTIMA OCUPADA, para que nunca haga falta un botón de
 * "añadir hoja" ni se pueda llegar a un archivador en el que ya no cabe nada.
 * Mínimo una (el archivador recién estrenado ya se ve, con sus nueve fundas
 * vacías) y tope `maxHojas`, que es el que impone el servidor.
 */
export function hojasMontadas(
  fundas: FundaVitrina[],
  maxHojas: number,
): number {
  let ultima = -1;
  for (const f of fundas) if (f.hoja > ultima) ultima = f.hoja;
  const tope = Math.max(1, maxHojas);
  return Math.min(Math.max(1, ultima + 2), tope);
}

/** Las nueve posiciones de una hoja, con `null` en las vacías. */
export function huecosDeHoja(
  mapa: Map<string, FundaVitrina>,
  hoja: number,
): (CartaEnColeccion | null)[] {
  return Array.from(
    { length: RANURAS_POR_HOJA },
    (_, r) => mapa.get(claveFunda(hoja, r))?.carta ?? null,
  );
}

/**
 * Orden de lectura del archivador: hoja y, dentro, ranura.
 *
 * Es el orden en el que el detalle navega de carta en carta al deslizar, y
 * tiene que ser el orden en el que se VEN, no el que devuelva la base de datos
 * ni el que tenga el array en memoria tras colocar una carta.
 */
export function enOrdenDeLectura(fundas: FundaVitrina[]): FundaVitrina[] {
  return [...fundas].sort((a, b) =>
    a.hoja !== b.hoja ? a.hoja - b.hoja : a.ranura - b.ranura,
  );
}

/* ------------------------------------------------------------------ */
/* NORMALIZACIÓN DE LAS DOS FUENTES                                    */
/* ------------------------------------------------------------------ */

/**
 * Forma cruda de una funda del servidor.
 *
 * Se declara con `unknown` campo a campo y no con el tipo de la acción porque
 * `getArchivador` devuelve lo que salga de `enIdiomaUsuario`, que está tipada
 * `Promise<any[]>`: dar por buena esa forma sería confiar en un `any` que
 * atraviesa la capa de traducción. Coercionar aquí cuesta diez líneas y a
 * cambio nada de lo que hay por encima puede recibir un `undefined` donde
 * espera un número.
 */
type FundaCruda = {
  hoja?: unknown;
  ranura?: unknown;
  id?: unknown;
  name?: unknown;
  rarity?: unknown;
  images?: unknown;
  copias?: unknown;
};

/** Las dos variantes de ilustración, siempre como cadenas. */
function aImagenes(valor: unknown): { small: string; large: string } {
  const o = (valor ?? {}) as { small?: unknown; large?: unknown };
  const small = typeof o.small === "string" ? o.small : "";
  const large = typeof o.large === "string" ? o.large : "";
  // Si sólo viene una, sirve para las dos: PokemonCard cae de una a otra.
  return { small: small || large, large: large || small };
}

/** ¿Cae la funda dentro de la rejilla que esta pantalla sabe pintar? */
function enRango(hoja: number, ranura: number, maxHojas: number): boolean {
  return (
    Number.isInteger(hoja) &&
    Number.isInteger(ranura) &&
    hoja >= 0 &&
    hoja < maxHojas &&
    ranura >= 0 &&
    ranura < RANURAS_POR_HOJA
  );
}

/** Fundas del usuario con sesión, tal y como las devuelve `getArchivador`. */
export function fundasDelServidor(
  crudas: readonly FundaCruda[],
  maxHojas: number,
): FundaVitrina[] {
  const fundas: FundaVitrina[] = [];
  for (const c of crudas) {
    const hoja = Math.floor(Number(c.hoja));
    const ranura = Math.floor(Number(c.ranura));
    const id = typeof c.id === "string" ? c.id : "";
    // Una fila fuera de rango o sin id no se pinta: son datos de una versión
    // anterior del tope de hojas, y colarlos reventaría la rejilla en vez de
    // fallar en silencio.
    if (!id || !enRango(hoja, ranura, maxHojas)) continue;
    fundas.push({
      hoja,
      ranura,
      carta: {
        id,
        name: typeof c.name === "string" ? c.name : "",
        rarity: typeof c.rarity === "string" ? c.rarity : "",
        images: aImagenes(c.images),
        quantity: Math.max(0, Math.floor(Number(c.copias) || 0)),
      },
    });
  }
  return fundas;
}

/**
 * Fundas del invitado: {hoja, ranura, cardId} cruzado con su colección.
 *
 * LA CARTA QUE YA NO ESTÁ. Si el invitado vendió la carta después de colocarla,
 * su localStorage sigue teniendo la funda pero la colección ya no tiene la
 * carta, así que no hay ni nombre ni ilustración que pintar. La funda NO se
 * descarta —sería borrarle en silencio algo que él puso, y encima sin poder
 * deshacerlo— sino que se monta con `quantity: 0` y sin datos: la pantalla la
 * marca igual que marca las del servidor con copias 0, y PokemonCard ya sabe
 * pintar una carta sin ilustración. Es exactamente lo que hace el servidor, que
 * conserva la fila y devuelve `copias: 0`.
 */
export function fundasDelInvitado(
  locales: readonly FundaLocal[],
  cartas: readonly CartaEnColeccion[],
  maxHojas: number,
): FundaVitrina[] {
  const porId = new Map<string, CartaEnColeccion>();
  for (const c of cartas) porId.set(c.id, c);

  const fundas: FundaVitrina[] = [];
  for (const f of locales) {
    if (!f.cardId || !enRango(f.hoja, f.ranura, maxHojas)) continue;
    const carta = porId.get(f.cardId);
    fundas.push({
      hoja: f.hoja,
      ranura: f.ranura,
      carta: carta ?? {
        id: f.cardId,
        name: "",
        rarity: "",
        images: { small: "", large: "" },
        quantity: 0,
      },
    });
  }
  return fundas;
}
