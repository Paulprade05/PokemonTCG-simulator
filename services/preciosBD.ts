// services/preciosBD.ts
//
// La capa de lectura de los precios reales de Cardmarket.
//
// SIN 'use server' A PROPÓSITO, igual que services/idiomaBD.ts y
// services/ingest.ts: en un fichero 'use server' CADA función exportada es un
// endpoint POST vivo contra el que cualquiera puede disparar. Esto lo importa
// código de servidor y no lo necesita. Es la lección que atraviesa app/action.ts
// y que costó retirar cuatro funciones de amigos y `syncSetToDatabase`.
//
// LO QUE HACE Y LO QUE NO: devuelve, para un puñado de ids de carta, su precio
// en euros si el cron ya pasó por ellas. NADA MÁS. La conversión de euros a
// monedas del juego vive en utils/constanst.ts (ajustePorPrecioReal), que es
// donde tiene que estar para que la tienda y el calibrado del sobre usen el
// mismo número. Aquí sólo se leen euros.
//
// DEGRADA A SILENCIO, SIEMPRE. Si la tabla no existe todavía (la migración
// /migrate-mejoras se ejecuta a mano), si Postgres no responde o si la consulta
// tarda, esto devuelve un mapa vacío y el juego se comporta EXACTAMENTE como
// antes de que existiera el ajuste: cada carta a su tarifa por rareza. Es el
// mismo criterio de services/idiomaBD.ts y por el mismo motivo — una función
// nueva no puede tumbar la tienda.

import { sql } from "@vercel/postgres";

/** 10 minutos: los precios se refrescan una vez al día, no hay prisa. */
const TTL_MS = 10 * 60 * 1000;
/** Tras un fallo se reintenta pronto, pero no en cada petición. */
const TTL_FALLO_MS = 60 * 1000;

/**
 * Tope de ids por consulta. Un sobre son 10 cartas y una colección entera puede
 * ser miles; por encima de esto se trocea, para no montar un `IN` gigante.
 */
const MAX_POR_CONSULTA = 900;

type Entrada = { eur: number; expira: number };
const cache = new Map<string, Entrada>();

/** Momento hasta el que NO se vuelve a preguntar tras un fallo. */
let castigadoHasta = 0;

/**
 * Precio en euros de cada carta pedida, si se conoce. Las que no aparecen en el
 * resultado no tienen precio y deben tratarse como "sin ajuste".
 *
 * Nunca lanza.
 */
export async function preciosEnEuros(
  idsCarta: readonly string[],
): Promise<Map<string, number>> {
  const salida = new Map<string, number>();
  if (!idsCarta.length) return salida;

  const ahora = Date.now();
  const pendientes: string[] = [];
  const vistos = new Set<string>();

  for (const id of idsCarta) {
    if (typeof id !== "string" || !id || vistos.has(id)) continue;
    vistos.add(id);
    const c = cache.get(id);
    if (c && c.expira > ahora) {
      // Un 0 en caché significa "preguntado y sin precio": se recuerda para no
      // volver a preguntar por ella en diez minutos, pero no se devuelve.
      if (c.eur > 0) salida.set(id, c.eur);
    } else {
      pendientes.push(id);
    }
  }

  if (!pendientes.length || ahora < castigadoHasta) return salida;

  try {
    for (let i = 0; i < pendientes.length; i += MAX_POR_CONSULTA) {
      const lote = pendientes.slice(i, i + MAX_POR_CONSULTA);
      const { rows } = await sql.query(
        `SELECT card_id, eur FROM card_prices
          WHERE card_id = ANY($1::text[]) AND eur IS NOT NULL AND eur > 0`,
        [lote],
      );
      const conPrecio = new Set<string>();
      for (const r of rows) {
        const id = String(r.card_id);
        const eur = Number(r.eur);
        if (!Number.isFinite(eur) || eur <= 0) continue;
        conPrecio.add(id);
        salida.set(id, eur);
        cache.set(id, { eur, expira: ahora + TTL_MS });
      }
      // Las que no volvieron se marcan como "sin precio" para no repreguntar.
      for (const id of lote) {
        if (!conPrecio.has(id)) cache.set(id, { eur: 0, expira: ahora + TTL_MS });
      }
    }
  } catch (e) {
    // Tabla sin crear, base caída, lo que sea: se sigue sin ajuste.
    console.warn("[precios] lectura fallida, se sigue sin ajuste:", e);
    castigadoHasta = ahora + TTL_FALLO_MS;
    return salida;
  }

  return salida;
}

/**
 * Pega el precio en euros a una lista de cartas, devolviendo copias con
 * `precioEur`. Las cartas sin precio se devuelven TAL CUAL (misma referencia),
 * igual que hace services/idioma.ts con las que no tienen traducción: así el
 * caso normal —que es no tener precio— no genera basura ni invalida memos.
 */
export async function conPrecioReal<T extends { id: string }>(
  cartas: readonly T[],
): Promise<T[]> {
  if (!cartas.length) return cartas as T[];
  const precios = await preciosEnEuros(cartas.map((c) => c.id));
  if (!precios.size) return cartas as T[];
  return cartas.map((c) => {
    const eur = precios.get(c.id);
    return eur ? { ...c, precioEur: eur } : c;
  });
}
