// services/sobresBD.ts
//
// La capa de LECTURA del almacén de fotos de sobre que llena el cron.
//
// SIN 'use server' A PROPÓSITO, igual que services/preciosBD.ts y
// services/idiomaBD.ts: en un fichero 'use server' cada función exportada es un
// endpoint POST vivo contra el que cualquiera puede disparar. Esto lo importa
// código de servidor y no lo necesita.
//
// LO QUE HACE Y LO QUE NO: dice CUÁNTAS variantes tiene cada expansión en el
// almacén. Nada más. No devuelve bytes: los bytes los sirve
// app/api/arte-sobre/[setId]/[variante], y por una razón que no es de gusto —
// si esta consulta los trajera, cada carga de la tienda arrastraría megas de
// imagen que la mayoría de las veces no se van a usar.
//
// DEGRADA A SILENCIO, SIEMPRE. Si las tablas no existen todavía (la migración
// /migrate-sobres se ejecuta a mano), si Postgres no responde o si la consulta
// tarda, esto devuelve un mapa vacío y la aplicación se comporta EXACTAMENTE
// como antes de que existiera: manifiesto estático para las 130 que lo tienen y
// sobre dibujado para el resto. Es el mismo criterio de los otros dos módulos y
// por el mismo motivo — una función nueva no puede tumbar la tienda.
//
// Y ES DELIBERADO QUE NO SE LLAME DESDE EL SQL DE `getSetsFromDB`. Meter un
// LEFT JOIN contra estas tablas en aquella consulta parece más limpio y es una
// trampa: si las tablas no existen, la consulta entera lanza, el catch de
// app/action.ts se la traga y devuelve `loadLocalSets()`, que sólo conoce las
// 38 expansiones con fichero de cartas en el repositorio. O sea que un
// `relation does not exist` convertiría la tienda de 171 expansiones en 38, en
// silencio. Consulta aparte, try/catch propio, mapa vacío ante cualquier fallo.

import { sql } from "@vercel/postgres";

/**
 * Cuánto vale el recuento antes de volver a preguntar.
 *
 * 5 minutos es mucho más de lo que tarda el cron en cambiar nada (escribe una
 * vez al día, si acaso) y poco comparado con lo que dura una sesión. El coste
 * de equivocarse hacia arriba es que una expansión recién bajada tarde cinco
 * minutos en enseñar su foto; hacia abajo, una consulta por visita.
 */
const TTL_MS = 5 * 60 * 1000;
/** Tras un fallo se reintenta pronto, pero no en cada petición. */
const TTL_FALLO_MS = 60 * 1000;

let cache: { mapa: Map<string, number>; expira: number } | null = null;

/**
 * Cuántas variantes tiene cada expansión en el almacén, indexado por el id
 * CRUDO de `sets.id` ("me2pt5", no "me2.5").
 *
 * EL ID VA CRUDO Y ESO ES UNA DECISIÓN, no un descuido. Hay dos espacios de
 * identificadores en este repositorio y confundirlos es el fallo que
 * utils/sobreArte.ts documenta en veinte líneas: el mismo set es "sv3pt5" en
 * pokemontcg.io y "sv03.5" en TCGdex, y `normalizarId` los une en "sv3.5". El
 * manifiesto estático se indexa por el NORMALIZADO porque tiene que responder a
 * las dos formas. Aquí no hace falta: la clave sale de `sets.id`, la URL de la
 * foto se compone con `sets.id`, y el número que viaja hasta el componente es
 * un ENTERO, que no tiene problema de claves. Un espacio, una forma, ningún
 * sitio donde equivocarse.
 *
 * SE CUENTAN LAS FILAS DE `set_pack_art` Y NO SE LEE `set_pack_art_estado`,
 * aunque aquella tabla tenga una columna `variantes` que dice justo esto. Dos
 * tablas que afirman lo mismo acaban afirmando cosas distintas —un cron cortado
 * a mitad basta—, y de las dos tiene que mandar la que tiene los bytes: si aquí
 * dijéramos "3" y sólo hubiera 2 filas, un tercio de los sobres de esa
 * expansión pediría una URL que responde 404. `COUNT(*)` no destoasta el BYTEA,
 * así que contar es barato.
 *
 * LA CONTIGÜIDAD SE COMPRUEBA, no se supone. utils/sobreArte.ts compone la URL
 * con `hash % variantes + 1`, o sea que da por hecho que existen 1..N seguidas.
 * Si por lo que sea faltara una del medio, esta función devuelve 0 para esa
 * expansión (sobre dibujado) en vez de un número que produciría 404s.
 *
 * Nunca lanza.
 */
export async function variantesDeSobre(): Promise<ReadonlyMap<string, number>> {
  const ahora = Date.now();
  if (cache && cache.expira > ahora) return cache.mapa;

  const mapa = new Map<string, number>();
  try {
    const { rows } = await sql`
      SELECT set_id,
             COUNT(*)::int     AS filas,
             MIN(variante)::int AS primera,
             MAX(variante)::int AS ultima
      FROM set_pack_art
      GROUP BY set_id
    `;
    for (const r of rows) {
      const filas = Number(r.filas) || 0;
      const primera = Number(r.primera) || 0;
      const ultima = Number(r.ultima) || 0;
      // 1..N seguidas: sin huecos y empezando en 1. Cualquier otra cosa no la
      // sabe pedir el componente, así que vale más no ofrecerla.
      if (filas > 0 && primera === 1 && ultima === filas) {
        mapa.set(String(r.set_id), filas);
      }
    }
    cache = { mapa, expira: ahora + TTL_MS };
  } catch (e: unknown) {
    // Silencio con nota: lo normal es que la migración no se haya ejecutado
    // todavía, y eso no es una avería.
    console.error(
      "sobresBD: no se pudo leer set_pack_art, se sigue sin fotos nuevas:",
      e instanceof Error ? e.message : String(e),
    );
    cache = { mapa, expira: ahora + TTL_FALLO_MS };
  }
  return mapa;
}

/**
 * Tira la caché. La usa el cron después de escribir, para que la foto de una
 * expansión recién bajada se vea sin esperar al TTL en la instancia que la
 * acaba de guardar. En las demás instancias sigue mandando el TTL, que es lo
 * correcto: no hay forma de invalidar a distancia y tampoco hace falta.
 */
export function olvidarVariantesDeSobre(): void {
  cache = null;
}
