/**
 * CUÁNTAS REPETIDAS HAY Y CUÁNTO DARÍAN, VISTO DESDE LA TIENDA.
 *
 * POR QUÉ EXISTE. La tienda reducía la colección a una lista de ids, y con eso
 * no podía contestar dos preguntas que el jugador se hace justo aquí:
 *
 *   · "¿cuánto me dan por las repetidas de este sobre?" — el botón del resumen
 *     vendía al toque sin decirlo, y el importe sólo aparecía después;
 *   · "no me llega para el sobre, ¿de dónde saco monedas?" — la respuesta casi
 *     siempre es "tienes repetidas por valor de X", y sólo se veía en Colección,
 *     detrás de un icono y dentro de una hoja de confirmación.
 *
 * QUÉ ES ESTO Y QUÉ NO. Es una ESTIMACIÓN para pintar, con la misma regla que
 * aplican `sellPackDuplicates` (servidor) y `venderRepetidasEnLocal` (invitado):
 * nunca se vende la última copia libre, y el precio sale de `valorDeVenta`, que
 * baja con cada copia. NO decide nada: quien cobra y abona sigue siendo el
 * servidor, con sus propios datos.
 *
 * LO QUE NO SABE, y por eso con sesión la cifra se rotula como aproximada: el
 * precio real de Cardmarket (`precioEur`) no baja al navegador —es deliberado,
 * ver `getFullCollection`—, así que el servidor puede abonar un pelín más en
 * las cartas que lo tienen. Medido en utils/constanst.ts: menos de un 1% en
 * casi todas las rarezas. Cuando el servidor SÍ manda el importe ya hecho
 * (`valorDeVentaRepetidas`, por montón) se usa ése tal cual hasta que el montón
 * cambia. Para el invitado no hay precio real que valga y la cifra es exacta.
 */
import { valorDeVenta } from "../../utils/constanst";

/** Lo que hace falta saber de un montón de copias de la misma carta. */
export interface Monton {
  /** Copias en propiedad. */
  q: number;
  /** De ellas, graduadas: están en la vitrina y no se venden desde aquí. */
  g: number;
  /** De ellas, anunciadas en el bazar (anuncio suelto abierto): están
   *  apalabradas y el servidor tampoco las vende mientras siga el anuncio. */
  a: number;
  fav: boolean;
  rareza: string;
  /** Importe de TODAS las repetidas calculado por el servidor, mientras el
   *  montón no haya cambiado desde que lo mandó. `null` = hay que estimarlo. */
  v: number | null;
}

export type Inventario = Map<string, Monton>;

/** Una fila de `getInventarioColeccion` (o de `getFullCollection`: los campos
 *  se llaman igual) o de la colección local del invitado. */
interface FilaDeColeccion {
  id?: unknown;
  rarity?: unknown;
  quantity?: unknown;
  graduadas?: unknown;
  anunciadas?: unknown;
  is_favorite?: unknown;
  valorDeVentaRepetidas?: unknown;
}

const entero = (v: unknown): number => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
};

export function inventarioDe(filas: readonly unknown[]): Inventario {
  const inv: Inventario = new Map();
  for (const cruda of filas) {
    if (!cruda || typeof cruda !== "object") continue;
    const fila = cruda as FilaDeColeccion;
    if (typeof fila.id !== "string") continue;
    const q = entero(fila.quantity);
    if (q <= 0) continue;
    const v = fila.valorDeVentaRepetidas;
    const g = Math.min(q, entero(fila.graduadas));
    inv.set(fila.id, {
      q,
      g,
      // Nunca más de las que quedan tras las graduadas: un dato raro no puede
      // dejar las vendibles en negativo.
      a: Math.min(q - g, entero(fila.anunciadas)),
      fav: fila.is_favorite === true,
      rareza: typeof fila.rarity === "string" ? fila.rarity : "",
      v: typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null,
    });
  }
  return inv;
}

/**
 * Repetidas que se pueden vender de un montón: todas las libres menos una.
 *
 * LIBRES SON LAS QUE NO ESTÁN NI EN LA VITRINA NI EN EL BAZAR. Aquí se restaban
 * sólo las graduadas, y el servidor resta también las anunciadas (ver
 * `copiasComprometidas` en app/action.ts): con 3 y 5 copias y tres anuncios, el
 * aviso de la tienda decía "6 repetidas por 72 monedas" y el vaciado real
 * vendía 3 por 32.
 */
const vendibles = (m: Monton): number => Math.max(0, m.q - m.g - m.a - 1);

/** Un sobre recién acreditado: cada carta suma una copia a su montón. */
export function sumarSobre(
  inv: Inventario,
  cartas: readonly { id: string; rarity?: string }[],
): void {
  for (const c of cartas) {
    const m = inv.get(c.id);
    if (m) {
      m.q += 1;
      m.v = null; // el importe del servidor era el del montón de antes
    } else {
      inv.set(c.id, { q: 1, g: 0, a: 0, fav: false, rareza: c.rarity ?? "", v: null });
    }
  }
}

/** Ids pedidos → cuántas copias de cada uno. */
function contar(ids: readonly string[]): Map<string, number> {
  const pedidas = new Map<string, number>();
  for (const id of ids) pedidas.set(id, (pedidas.get(id) ?? 0) + 1);
  return pedidas;
}

/**
 * Lo que daría vender estas repetidas (una copia por aparición del id), con la
 * regla de `sellPackDuplicates`. `sold` son las que de verdad saldrían.
 */
export function tasarRepetidas(
  inv: Inventario,
  ids: readonly string[],
): { importe: number; sold: number } {
  let importe = 0;
  let sold = 0;
  for (const [id, cuantas] of contar(ids)) {
    const m = inv.get(id);
    if (!m) continue;
    const salen = Math.min(cuantas, vendibles(m));
    if (salen <= 0) continue;
    importe += valorDeVenta(m.rareza, m.q, salen);
    sold += salen;
  }
  return { importe, sold };
}

/** Tras una venta confirmada: descuenta las copias que salieron. */
export function restarVenta(inv: Inventario, ids: readonly string[]): void {
  for (const [id, cuantas] of contar(ids)) {
    const m = inv.get(id);
    if (!m) continue;
    const salen = Math.min(cuantas, vendibles(m));
    if (salen <= 0) continue;
    m.q -= salen;
    m.v = null;
  }
}

/**
 * Todas las repetidas vendibles de la colección y lo que valen. Las favoritas
 * quedan fuera, igual que en "Limpiar duplicados" de la Colección, que es a
 * donde manda el aviso que pinta esta cifra.
 */
export function resumenDeRepetidas(inv: Inventario): { n: number; valor: number } {
  let n = 0;
  let valor = 0;
  for (const m of inv.values()) {
    if (m.fav) continue;
    const salen = vendibles(m);
    if (salen <= 0) continue;
    n += salen;
    valor += m.v ?? valorDeVenta(m.rareza, m.q, salen);
  }
  return { n, valor };
}
