"use server";

import { auth } from "@clerk/nextjs/server";
import { sql } from "@vercel/postgres";
import { revalidatePath } from "next/cache";
// `precioDeCartaSuelta` + `valorDeVenta` en vez de SELL_PRICES a pelo: el valor
// de una colección tiene que ser el dinero que de verdad daría venderla, y el
// precio por copia baja con cada repetida.
import { RARITY_RANK, precioDeCartaSuelta, valorDeVenta } from "../utils/constanst";
// Los intercambios se emparejan SIEMPRE por id (ver createTradeOffer y
// acceptTradeOffer): aquí el idioma sólo cambia el rótulo y la ilustración de
// las cartas que se enseñan al elegir y al revisar una oferta.
import { traducirCartasEs } from "../services/idiomaBD";
import { idiomaActual } from "../services/idiomaServidor";
// `randomInt` sortea el código de amigo. utils/codigoAmigo.ts no puede
// importarlo (es un módulo puro que también carga el navegador), así que se
// le pasa desde aquí.
import { randomInt } from "node:crypto";
import { LIMITES_SOCIALES, SENTENCIAS_CODIGOS_AMIGO } from "../services/esquemaSocial";
import { etiquetaDeCodigo, generarCodigoAmigo, normalizarCodigoAmigo } from "../utils/codigoAmigo";
import type {
  Destino,
  EntrenadorBloqueado,
  EntrenadorEncontrado,
  FalloSocial,
  Peticiones,
  RelacionSocial,
  ResultadoAceptarPeticion,
  ResultadoBusqueda,
  ResultadoCodigo,
  ResultadoEliminarAmigo,
  ResultadoEnviarPeticion,
  ResultadoFicha,
  ResultadoSocial,
  SocialPendientes,
} from "../utils/tiposSocial";

// ============================================================
// SOCIAL v2 — amigos + intercambios multi-carta
// ============================================================

function countById(ids: string[]): Record<string, number> {
  const m: Record<string, number> = {};
  for (const id of ids) m[id] = (m[id] || 0) + 1;
  return m;
}

/**
 * Lee una lista de ids de una columna JSONB SIN FIARSE DE LO QUE HAYA DENTRO.
 *
 * POR QUÉ ES TOTAL Y NO LANZA NUNCA. `offered_ids`/`requested_ids` son JSONB, y
 * hasta hoy se guardaba ahí lo que llegara del cliente sin mirarlo: bastaba
 * mandar una CADENA en vez de un array (`createTradeOffer(v, ["sv8-1"], "x")`,
 * que pasaba el guard de tamaño porque "x" mide 1) para dejar un escalar JSON
 * en la fila. El driver devuelve ese escalar como cadena de JS, el `JSON.parse`
 * de la versión anterior reventaba con ella, y como el parseo ocurría dentro
 * del `flatMap` de `getIncomingTradeOffers`, el catch de la función se tragaba
 * la bandeja ENTERA: la víctima dejaba de ver también las ofertas legítimas,
 * sin ninguna pista y sin arreglo posible desde la interfaz (quitar al amigo no
 * toca la fila, que sigue 'pending').
 *
 * Ahora todo lo que no sea un array de cadenas sale como lista vacía. Una fila
 * mala se queda en una oferta rara —visible y rechazable— en vez de esconder
 * las demás.
 */
function parseIds(v: unknown): string[] {
  let valor: unknown = v;
  if (typeof valor === "string") {
    try {
      valor = JSON.parse(valor);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(valor)) return [];
  if (!valor.every((id) => typeof id === "string")) return [];
  return valor as string[];
}

/**
 * Las dos listas de UNA fila de `trade_offers`, cada una por su cuenta.
 *
 * El parseo va fila a fila —y no en un `flatMap` sobre todas— porque ése era el
 * mecanismo del daño: una fila corrupta no puede llevarse por delante a las
 * buenas si nadie las parsea juntas. Lo ilegible queda anotado con el id de la
 * oferta, que es por dónde hay que empezar a mirar cuando alguien dice que le
 * falta una oferta en la bandeja.
 */
function idsDeOferta(fila: any): { offered: string[]; requested: string[] } {
  const offered = parseIds(fila?.offered_ids);
  const requested = parseIds(fila?.requested_ids);
  // Una oferta legítima nunca nace con un lado vacío: `createTradeOffer` exige
  // cartas en los dos. Vacío aquí sólo puede ser una fila ilegible.
  if (offered.length === 0 || requested.length === 0) {
    console.error(`trade_offers: fila ${fila?.id} con ids ilegibles; se muestra vacía`);
  }
  return { offered, requested };
}

async function hydrateCardsByIds(ids: string[]) {
  const unique = Array.from(new Set(ids));
  if (unique.length === 0) return {} as Record<string, any>;
  const { rows } = await sql.query(
    `SELECT id, name, rarity, images, set_id FROM cards WHERE id = ANY($1::text[])`,
    [unique],
  );
  const cartas = await traducirCartasEs(
    rows.map((r: any) => ({
      id: r.id,
      name: r.name,
      rarity: r.rarity,
      images: typeof r.images === "string" ? JSON.parse(r.images) : r.images,
      set_id: r.set_id,
    })),
    await idiomaActual(),
  );
  const map: Record<string, any> = {};
  cartas.forEach((c) => { map[c.id] = c; });
  return map;
}

/* ==================================================================== *
 * AMIGOS: código de amigo, peticiones, bloqueo y búsqueda
 * ====================================================================
 *
 * LA REGLA DE TODO EL BLOQUE: el id de Clerk de otra persona no sale del
 * servidor salvo hacia un amigo ya aceptado. Con ese id basta para abrir el
 * álbum de alguien (`getTrainerCollection` sólo pide sesión y un id), y la
 * búsqueda anterior se lo entregaba a cualquiera con sesión. Aquí a un
 * entrenador se le nombra por su CÓDIGO (utils/codigoAmigo.ts) o por el id
 * numérico de la fila de `friendships`, y quien quiere actuar sobre alguien
 * dice un `Destino` que se resuelve en el servidor y no se devuelve.
 *
 * LOS ESTADOS de `friendships.status` y lo que significa la dirección de la
 * fila están documentados en services/esquemaSocial.ts. Lo que importa para
 * leer lo de abajo: hay como mucho UNA fila por pareja, y cada escritura lleva
 * en su WHERE el dueño y el estado del que parte, de modo que dos toques a la
 * vez no pueden aplicar los dos. Cuando una escritura no cambia ninguna fila,
 * la acción lo dice: ninguna devuelve éxito a ciegas.
 */

const MAX_ENVIADAS = LIMITES_SOCIALES.PETICIONES_ENVIADAS;
const MAX_RECIBIDAS = LIMITES_SOCIALES.PETICIONES_RECIBIDAS;
const MAX_AMIGOS = LIMITES_SOCIALES.AMIGOS;

/** Filas que devuelve de una vez una lista de peticiones o de bloqueados. */
const MAX_FILAS_LISTA = 50;

/** Resultados de la búsqueda por nombre. Se pide uno más para saber si hay más. */
const MAX_RESULTADOS = 8;

/** Longitud de lo que se busca por nombre, ya recortado. */
const MIN_CONSULTA = 2;
const MAX_CONSULTA = 40;

/** Sorteos de código antes de rendirse. Chocar una vez ya es rarísimo (31⁸). */
const INTENTOS_CODIGO = 5;

/** La forma de un id de Clerk. Lo que no la tenga no llega a la base. */
const ID_DE_CLERK = /^user_[A-Za-z0-9]{20,64}$/;

/** Mayor valor de una columna SERIAL/INT: por encima, Postgres lanza. */
const MAX_ENTERO_SQL = 2147483647;

/**
 * El nombre que se enseña de un usuario, con alias de tabla `u`. Un nombre
 * vacío o de espacios cuenta como no tenerlo: pintaría una fila sin rótulo.
 */
const NOMBRE_VISIBLE = `COALESCE(NULLIF(BTRIM(u.username), ''), 'Entrenador')`;

const fallo = (error: string): FalloSocial => ({ ok: false, error });

/**
 * Un id de fila que llega del cliente. `typeof` y no `Number(...)`: `Number`
 * convierte `true` en 1 y `[7]` en 7, y esto es un endpoint HTTP.
 */
function idDeFila(valor: unknown): number | null {
  return typeof valor === "number" && Number.isInteger(valor) && valor > 0 && valor <= MAX_ENTERO_SQL
    ? valor
    : null;
}

/* La tabla `friend_codes` se asegura AQUÍ, de forma perezosa y una vez por
 * instancia, y no en `ensureSchema` de app/action.ts: aquél lanza cuatro ALTER
 * sobre `users` en cada arranque en frío y no se le añade nada más. Esto es un
 * CREATE TABLE IF NOT EXISTS de una tabla nueva, que no toma candados sobre
 * ninguna existente, y sólo lo pagan las acciones que tocan códigos.
 *
 * La promesa se memoiza y el fallo NO: si la creación falla, la siguiente
 * llamada lo vuelve a intentar. El segundo intento inmediato cubre la única
 * carrera real —dos instancias creando la tabla a la vez; la que pierde recibe
 * un error de clave duplicada del catálogo y a la segunda la tabla ya existe—. */
let esquemaSocialListo: Promise<void> | null = null;
function asegurarEsquemaSocial(): Promise<void> {
  if (!esquemaSocialListo) {
    esquemaSocialListo = (async () => {
      for (const sentencia of SENTENCIAS_CODIGOS_AMIGO) {
        try {
          await sql.query(sentencia);
        } catch {
          await sql.query(sentencia);
        }
      }
    })().catch((e) => {
      esquemaSocialListo = null;
      throw e;
    });
  }
  return esquemaSocialListo;
}

/**
 * El código de amigo de cada id, CREÁNDOLO si aún no lo tiene.
 *
 * Se crea al primer uso, y no sólo el propio: quien sale en una búsqueda por
 * nombre o en una lista de peticiones necesita código para poder nombrarle sin
 * su id de Clerk, aunque nunca haya abierto Social.
 *
 * El código se sortea aquí y el árbitro es el índice único de `friend_codes`:
 * el INSERT va con ON CONFLICT DO NOTHING (sin destino, para que cubra tanto
 * «ese usuario ya tiene código» como «ese código ya está cogido») y después se
 * RELEE. Lo que siga sin código tras releer es que chocó, y se sortea otro. La
 * primera vuelta sólo lee: es el caso normal y no escribe nada.
 */
async function codigosDe(ids: string[]): Promise<Map<string, string>> {
  const mapa = new Map<string, string>();
  const unicos = Array.from(new Set(ids));
  if (unicos.length === 0) return mapa;
  await asegurarEsquemaSocial();
  for (let vuelta = 0; vuelta <= INTENTOS_CODIGO; vuelta++) {
    const faltan = unicos.filter((id) => !mapa.has(id));
    if (faltan.length === 0) break;
    if (vuelta > 0) {
      await sql.query(
        `INSERT INTO friend_codes (user_id, code)
         SELECT t.user_id, t.code
           FROM unnest($1::text[], $2::text[]) AS t(user_id, code)
         ON CONFLICT DO NOTHING`,
        [faltan, faltan.map(() => generarCodigoAmigo((tope) => randomInt(tope)))],
      );
    }
    const { rows } = await sql.query(
      `SELECT user_id, code FROM friend_codes WHERE user_id = ANY($1::text[])`,
      [faltan],
    );
    for (const r of rows) mapa.set(String(r.user_id), String(r.code));
  }
  return mapa;
}

type FilaPar = { id: number; user_id: string; friend_id: string; status: string };

/** Una fila tal como la entrega el driver: columnas por nombre, sin tipo fiable. */
type FilaSQL = Record<string, unknown>;

/**
 * Si una pareja tuviera más de una fila, cuál manda. No debería pasar —lo
 * impide `idx_friendships_par`—, pero ese índice se crea aparte en
 * /migrate-core y puede faltar en una base antigua con duplicados. Manda el
 * estado más restrictivo: un bloqueo no puede quedar tapado por una petición.
 */
const PESO_DE_ESTADO: Record<string, number> = {
  blocked_both: 6,
  blocked: 5,
  blocked_declined: 5,
  accepted: 4,
  pending: 3,
  declined: 2,
  withdrawn: 1,
};

function filaDominante(filas: FilaPar[]): FilaPar | null {
  let mejor: FilaPar | null = null;
  for (const f of filas) {
    const peso = PESO_DE_ESTADO[f.status] ?? 0;
    const pesoMejor = mejor ? PESO_DE_ESTADO[mejor.status] ?? 0 : -1;
    if (!mejor || peso > pesoMejor || (peso === pesoMejor && f.id < mejor.id)) mejor = f;
  }
  return mejor;
}

function aFilaPar(r: FilaSQL): FilaPar {
  return {
    id: Number(r.id),
    user_id: String(r.user_id),
    friend_id: String(r.friend_id),
    status: String(r.status),
  };
}

/** La fila de la pareja (yo, otro), en cualquiera de las dos direcciones. */
async function leerPar(yo: string, otro: string): Promise<FilaPar | null> {
  const { rows } = await sql.query(
    `SELECT id, user_id, friend_id, status
       FROM friendships
      WHERE (user_id = $1 AND friend_id = $2)
         OR (user_id = $2 AND friend_id = $1)`,
    [yo, otro],
  );
  return filaDominante(rows.map(aFilaPar));
}

/** Lo mismo que `leerPar`, para varios a la vez: una consulta, no una por fila. */
async function paresCon(yo: string, ids: string[]): Promise<Map<string, FilaPar>> {
  const porOtro = new Map<string, FilaPar[]>();
  if (ids.length === 0) return new Map();
  const { rows } = await sql.query(
    `SELECT id, user_id, friend_id, status
       FROM friendships
      WHERE (user_id = $1 AND friend_id = ANY($2::text[]))
         OR (friend_id = $1 AND user_id = ANY($2::text[]))`,
    [yo, ids],
  );
  for (const r of rows) {
    const fila = aFilaPar(r);
    const otro = fila.user_id === yo ? fila.friend_id : fila.user_id;
    const lista = porOtro.get(otro);
    if (lista) lista.push(fila);
    else porOtro.set(otro, [fila]);
  }
  const mapa = new Map<string, FilaPar>();
  for (const [otro, filas] of porOtro) {
    const fila = filaDominante(filas);
    if (fila) mapa.set(otro, fila);
  }
  return mapa;
}

/**
 * De la fila de la pareja a lo que ve QUIEN PREGUNTA.
 *
 * Aquí vive el rechazo silencioso: una petición mía que el otro rechazó sigue
 * siendo `enviada` para mí, y una suya que rechacé yo es `ninguna` (puedo
 * añadirle cuando quiera). Y aquí vive también lo poco que se le oculta al
 * bloqueado: si el otro me ha bloqueado veo `ninguna`, igual que un extraño.
 *
 * LO QUE ESTO NO ESCONDE, para que nadie lo dé por más de lo que es. El
 * bloqueo se puede DEDUCIR: quien está bloqueado deja de encontrar al otro en
 * la búsqueda, su «Añadir» contesta «enviada» sin `peticionId` y, al recargar,
 * la ficha vuelve a decir `ninguna`. Y el rechazo también: tras cancelar y
 * reenviar, el `peticionId` es el mismo si estaba rechazada y uno nuevo si
 * seguía pendiente. Ninguna de las dos cosas se ha tapado: taparlas pediría
 * guardar un estado más por pareja para sostener una ficción, y lo que el
 * bloqueo y el rechazo garantizan de verdad —que al otro no le llega nada— no
 * depende de que el primero no lo sospeche.
 *
 * `oculto` marca las parejas con bloqueo en cualquiera de los dos sentidos,
 * que es lo que la búsqueda deja fuera.
 */
function relacionDesde(
  fila: FilaPar | null | undefined,
  yo: string,
): { relacion: RelacionSocial; peticionId: number | null; oculto: boolean } {
  if (!fila) return { relacion: "ninguna", peticionId: null, oculto: false };
  const mia = fila.user_id === yo;
  switch (fila.status) {
    case "accepted":
      return { relacion: "amigos", peticionId: fila.id, oculto: false };
    case "pending":
      return { relacion: mia ? "enviada" : "recibida", peticionId: fila.id, oculto: false };
    case "declined":
      return mia
        ? { relacion: "enviada", peticionId: fila.id, oculto: false }
        : { relacion: "ninguna", peticionId: null, oculto: false };
    case "blocked":
    case "blocked_declined":
      return mia
        ? { relacion: "bloqueado", peticionId: fila.id, oculto: true }
        : { relacion: "ninguna", peticionId: null, oculto: true };
    case "blocked_both":
      return { relacion: "bloqueado", peticionId: fila.id, oculto: true };
    default:
      // 'withdrawn' y cualquier valor que no se conozca: como si no hubiera fila.
      return { relacion: "ninguna", peticionId: null, oculto: false };
  }
}

type DatosEntrenador = { nombre: string; unicas: number; cartas: number; enComun: number };

/**
 * Nombre, tamaño de la colección y amigos en común de varios entrenadores, en
 * UNA consulta. Son los tres números de la ficha: lo justo para reconocer a
 * alguien entre dos homónimos, y menos de lo que cualquiera con sesión puede
 * ver hoy abriendo su álbum.
 *
 * Los que no tengan fila en `users` no salen: para el resto del bloque eso es
 * «no existe».
 */
async function datosDeEntrenadores(yo: string, ids: string[]): Promise<Map<string, DatosEntrenador>> {
  const mapa = new Map<string, DatosEntrenador>();
  if (ids.length === 0) return mapa;
  const { rows } = await sql.query(
    `SELECT u.id,
            ${NOMBRE_VISIBLE}             AS nombre,
            COALESCE(col.unicas, 0)::int  AS unicas,
            COALESCE(col.cartas, 0)::int  AS cartas,
            COALESCE(com.n, 0)::int       AS en_comun
       FROM users u
       LEFT JOIN LATERAL (
              SELECT count(*) AS unicas, SUM(uc.quantity) AS cartas
                FROM user_collection uc
               WHERE uc.user_id = u.id AND uc.quantity > 0
            ) col ON TRUE
       LEFT JOIN LATERAL (
              SELECT count(*) AS n
                FROM friendships a
               WHERE a.status = 'accepted'
                 AND (a.user_id = $1::text OR a.friend_id = $1::text)
                 AND EXISTS (
                       SELECT 1 FROM friendships b
                        WHERE b.status = 'accepted'
                          AND ((b.user_id = u.id
                                AND b.friend_id = CASE WHEN a.user_id = $1::text THEN a.friend_id ELSE a.user_id END)
                            OR (b.friend_id = u.id
                                AND b.user_id = CASE WHEN a.user_id = $1::text THEN a.friend_id ELSE a.user_id END)))
            ) com ON TRUE
      WHERE u.id = ANY($2::text[])`,
    [yo, ids],
  );
  for (const r of rows) {
    mapa.set(String(r.id), {
      nombre: String(r.nombre),
      unicas: Number(r.unicas) || 0,
      cartas: Number(r.cartas) || 0,
      enComun: Number(r.en_comun) || 0,
    });
  }
  return mapa;
}

/** Sólo el nombre. `null` si no hay fila en `users`: ese entrenador no existe. */
async function nombreDe(id: string): Promise<string | null> {
  const { rows } = await sql.query(
    `SELECT ${NOMBRE_VISIBLE} AS nombre FROM users u WHERE u.id = $1`,
    [id],
  );
  return rows.length > 0 ? String(rows[0].nombre) : null;
}

type DestinoResuelto =
  | { ok: true; id: string; via: "codigo" | "anuncio" | "entrenador" }
  | { ok: false; motivo: "no_valido" | "no_encontrado"; error: string };

/**
 * De un `Destino` del cliente al id de Clerk, que se queda aquí.
 *
 * PRIVADA A PROPÓSITO: si se exportara sería un endpoint que convierte códigos
 * y anuncios en ids, que es justo lo que este bloque existe para no hacer.
 *
 * Todo se valida antes de tocar la base, porque `destino` llega de una
 * petición HTTP y el tipo de TypeScript no obliga a nadie:
 *  · `codigo`: se normaliza (minúsculas, guion, espacios, el enlace pegado) y
 *    tiene que quedar con la forma exacta del CHECK de `friend_codes`.
 *  · `anuncioId`: entero positivo, y el anuncio tiene que estar ACTIVO. Un
 *    anuncio cerrado no sirve para averiguar nada del que lo publicó.
 *  · `entrenadorId`: la forma de un id de Clerk y que exista en `users`. Sin
 *    lo segundo se podían crear peticiones a ids inventados, que luego salían
 *    como un «Entrenador» fantasma imposible de quitar.
 */
async function resolverDestino(destino: unknown): Promise<DestinoResuelto> {
  const noValido: DestinoResuelto = { ok: false, motivo: "no_valido", error: "Entrenador no válido" };
  if (!destino || typeof destino !== "object" || Array.isArray(destino)) return noValido;
  const d = destino as Record<string, unknown>;

  if (d.codigo !== undefined) {
    const codigo = normalizarCodigoAmigo(d.codigo);
    if (!codigo) return { ok: false, motivo: "no_valido", error: "Ese código no es válido." };
    await asegurarEsquemaSocial();
    const { rows } = await sql.query(`SELECT user_id FROM friend_codes WHERE code = $1`, [codigo]);
    if (rows.length === 0) return { ok: false, motivo: "no_encontrado", error: "Ese código no existe." };
    return { ok: true, id: String(rows[0].user_id), via: "codigo" };
  }

  if (d.anuncioId !== undefined) {
    const anuncioId = idDeFila(d.anuncioId);
    if (anuncioId === null) return noValido;
    const { rows } = await sql.query(
      `SELECT seller_id FROM bazar_listings WHERE id = $1::int AND estado = 'activa'`,
      [anuncioId],
    );
    if (rows.length === 0) {
      return { ok: false, motivo: "no_encontrado", error: "Ese anuncio ya no está disponible." };
    }
    return { ok: true, id: String(rows[0].seller_id), via: "anuncio" };
  }

  if (d.entrenadorId !== undefined) {
    if (typeof d.entrenadorId !== "string" || !ID_DE_CLERK.test(d.entrenadorId)) return noValido;
    const { rows } = await sql.query(`SELECT 1 FROM users WHERE id = $1`, [d.entrenadorId]);
    if (rows.length === 0) return { ok: false, motivo: "no_encontrado", error: "Ese entrenador no existe." };
    return { ok: true, id: d.entrenadorId, via: "entrenador" };
  }

  return noValido;
}

/** Mi código de amigo. Se crea la primera vez que alguien lo pide. */
export async function getMiCodigoDeAmigo(): Promise<ResultadoCodigo> {
  const { userId } = await auth();
  if (!userId) return fallo("No autorizado");
  try {
    const codigo = (await codigosDe([userId])).get(userId);
    if (!codigo) return fallo("No se pudo crear tu código. Inténtalo de nuevo.");
    return { ok: true, codigo };
  } catch (e) {
    console.error("getMiCodigoDeAmigo error:", e);
    return fallo("No se pudo cargar tu código de amigo");
  }
}

/**
 * Cambia mi código. El viejo deja de existir en la misma sentencia (es un
 * UPDATE de mi fila, no una fila más), así que los enlaces y los QR que ya
 * estuvieran compartidos dejan de valer: para eso se cambia.
 *
 * NO toca peticiones ni amistades: ésas viven en `friendships` y no dependen
 * del código con el que se crearon.
 */
export async function regenerarCodigoDeAmigo(): Promise<ResultadoCodigo> {
  const { userId } = await auth();
  if (!userId) return fallo("No autorizado");
  try {
    await asegurarEsquemaSocial();
    for (let intento = 0; intento < INTENTOS_CODIGO; intento++) {
      const nuevo = generarCodigoAmigo((tope) => randomInt(tope));
      try {
        // El ON CONFLICT es sólo por MI fila (ya tenía código: se sustituye).
        // Que el código nuevo sea el de otro no lo arbitra él sino el índice
        // único de `code`, que lanza 23505 y se recoge abajo.
        const { rows } = await sql.query(
          `INSERT INTO friend_codes (user_id, code)
           VALUES ($1, $2)
           ON CONFLICT (user_id) DO UPDATE SET code = EXCLUDED.code, created_at = NOW()
           RETURNING code`,
          [userId, nuevo],
        );
        if (rows.length > 0) return { ok: true, codigo: String(rows[0].code) };
      } catch (e) {
        if ((e as { code?: string } | null)?.code !== "23505") throw e;
      }
    }
    return fallo("No se pudo cambiar tu código. Inténtalo de nuevo.");
  } catch (e) {
    console.error("regenerarCodigoDeAmigo error:", e);
    return fallo("No se pudo cambiar tu código");
  }
}

/**
 * La ficha de un entrenador: quién es y qué hay entre los dos.
 *
 * Es lo que se enseña ANTES de añadir a alguien, y por eso exige sesión pero
 * no amistad. Devuelve el nombre y tres números; el id de Clerk sólo si ya
 * sois amigos, y el código sólo si quien pregunta ya lo traía.
 *
 * NO ESCRIBE NADA sobre la relación: abrir una ficha —o cargar la página de
 * una invitación— nunca envía una petición. Para eso hace falta un toque y
 * `enviarPeticion`.
 */
export async function getFichaEntrenador(destino: Destino): Promise<ResultadoFicha> {
  const { userId } = await auth();
  if (!userId) return { ok: false, motivo: "sesion", error: "Inicia sesión para ver a este entrenador" };
  try {
    const r = await resolverDestino(destino);
    if (!r.ok) return { ok: false, motivo: r.motivo, error: r.error };

    const datos = (await datosDeEntrenadores(userId, [r.id])).get(r.id);
    if (!datos) return { ok: false, motivo: "no_encontrado", error: "Ese entrenador no existe." };
    const codigo = (await codigosDe([r.id])).get(r.id) ?? "";

    const soyYo = r.id === userId;
    const rel = soyYo
      ? { relacion: "yo" as RelacionSocial, peticionId: null }
      : relacionDesde(await leerPar(userId, r.id), userId);

    return {
      ok: true,
      ficha: {
        nombre: datos.nombre,
        etiqueta: etiquetaDeCodigo(codigo),
        codigo: (r.via === "codigo" || soyYo) && codigo ? codigo : null,
        unicas: datos.unicas,
        cartas: datos.cartas,
        enComun: soyYo ? 0 : datos.enComun,
        relacion: rel.relacion,
        peticionId: rel.peticionId,
        amigoId: soyYo || rel.relacion === "amigos" ? r.id : null,
      },
    };
  } catch (e) {
    console.error("getFichaEntrenador error:", e);
    return { ok: false, motivo: "error", error: "No se pudo cargar. Revisa tu conexión." };
  }
}

type ResultadoAceptarFila =
  | { aceptada: true; otro: string }
  | { aceptada: false; motivo: "no_disponible" | "tope_mio" | "tope_suyo" | "carrera" };

/**
 * Pasa a 'accepted' una fila que apunta a MÍ, si parte de uno de `estados`.
 *
 * El tope de amigos va DENTRO del UPDATE y por los dos lados: aceptar es lo
 * único que crea una amistad, así que es el único sitio donde el tope puede
 * vivir. Cuando no cambia ninguna fila se vuelve a leer para poder decir POR
 * QUÉ —la petición ya no está, o alguien está lleno—, que son dos avisos
 * distintos y el jugador sólo puede arreglar uno de los dos.
 */
async function aceptarFila(id: number, yo: string, estados: string[]): Promise<ResultadoAceptarFila> {
  const { rows } = await sql.query(
    `UPDATE friendships f
        SET status = 'accepted'
      WHERE f.id = $1::int
        AND f.friend_id = $2::text
        AND f.status = ANY($3::text[])
        AND (SELECT count(*) FROM friendships a
              WHERE a.status = 'accepted'
                AND (a.user_id = $2::text OR a.friend_id = $2::text)) < $4::int
        AND (SELECT count(*) FROM friendships b
              WHERE b.status = 'accepted'
                AND (b.user_id = f.user_id OR b.friend_id = f.user_id)) < $4::int
      RETURNING f.user_id`,
    [id, yo, estados, MAX_AMIGOS],
  );
  if (rows.length > 0) return { aceptada: true, otro: String(rows[0].user_id) };

  const { rows: diag } = await sql.query(
    `SELECT f.status,
            (SELECT count(*)::int FROM friendships a
              WHERE a.status = 'accepted'
                AND (a.user_id = $2::text OR a.friend_id = $2::text)) AS mios,
            (SELECT count(*)::int FROM friendships b
              WHERE b.status = 'accepted'
                AND (b.user_id = f.user_id OR b.friend_id = f.user_id)) AS suyos
       FROM friendships f
      WHERE f.id = $1::int AND f.friend_id = $2::text`,
    [id, yo],
  );
  const d = diag[0];
  if (!d || !estados.includes(String(d.status))) return { aceptada: false, motivo: "no_disponible" };
  if (Number(d.mios) >= MAX_AMIGOS) return { aceptada: false, motivo: "tope_mio" };
  if (Number(d.suyos) >= MAX_AMIGOS) return { aceptada: false, motivo: "tope_suyo" };
  // Estaba y cabía: otra petición la tocó entre las dos lecturas.
  return { aceptada: false, motivo: "carrera" };
}

function avisoDeAceptar(motivo: "no_disponible" | "tope_mio" | "tope_suyo" | "carrera"): string {
  if (motivo === "tope_mio") return `Has llegado al máximo de ${MAX_AMIGOS} amigos.`;
  if (motivo === "tope_suyo") return "Ese entrenador ya tiene el máximo de amigos.";
  if (motivo === "carrera") return "No se pudo aceptar. Inténtalo de nuevo.";
  return "La petición ya no está disponible";
}

/**
 * El corazón de «añadir»: qué hacer con la pareja (yo, otro) según lo que ya
 * haya entre los dos.
 *
 * SE LEE, SE DECIDE Y SE ESCRIBE CON GUARDA, y si la escritura no cuaja se
 * vuelve a leer. Cada escritura lleva en su WHERE el estado del que partía la
 * decisión, así que la lectura previa no es la que protege: si otra petición
 * cambió la fila entre medias, la sentencia no toca nada y la vuelta
 * siguiente decide sobre el estado nuevo. Tres vueltas sobran: para agotarlas
 * tendría que cambiar la fila tres veces seguidas justo entre leer y escribir.
 *
 * LO QUE RESUELVE, caso a caso:
 *  · Peticiones CRUZADAS. Dos amigos, uno al lado del otro, pulsan «Añadir» a
 *    la vez. Antes el segundo recibía «Ya hay una petición pendiente» y tenía
 *    que ir a buscar el bloque de peticiones. Ahora, si hay una petición del
 *    otro esperándome, añadirle ES aceptarla.
 *  · RECHAZO SILENCIOSO. Si me rechazó, se responde «enviada» sin escribir
 *    nada: no puedo reenviar ni saber que me rechazó. Si le rechacé yo y ahora
 *    le añado, somos amigos (él ya lo había pedido).
 *  · BLOQUEO. Si me ha bloqueado se responde «enviada» sin escribir; si le
 *    bloqueé yo, se me dice, porque es algo que puedo deshacer.
 *  · TOPES. Van dentro del INSERT, en la misma sentencia que inserta, igual
 *    que el de ofertas de `createTradeOffer`.
 *
 * EL `ON CONFLICT DO NOTHING` VA SIN DESTINO a propósito: así no depende de
 * que exista `idx_friendships_par`. Con el índice, la perdedora de dos
 * inserciones simultáneas choca, no inserta y la vuelta siguiente la trata
 * como petición cruzada o ya enviada. Sin el índice no hay choque y el
 * NOT EXISTS es la única defensa —que no cierra esa carrera—: por eso hay que
 * comprobar en producción que el índice existe (/migrate-social lo dice).
 */
async function pedirAmistad(yo: string, otro: string, nombre: string): Promise<ResultadoEnviarPeticion> {
  for (let vuelta = 0; vuelta < 3; vuelta++) {
    const par = await leerPar(yo, otro);

    if (!par) {
      const { rows } = await sql.query(
        `INSERT INTO friendships (user_id, friend_id, status)
         SELECT $1::text, $2::text, 'pending'
          WHERE NOT EXISTS (
                  SELECT 1 FROM friendships f
                   WHERE (f.user_id = $1::text AND f.friend_id = $2::text)
                      OR (f.user_id = $2::text AND f.friend_id = $1::text))
            AND (SELECT count(*) FROM friendships e
                  WHERE e.user_id = $1::text AND e.status = 'pending') < $3::int
            AND (SELECT count(*) FROM friendships r
                  WHERE r.friend_id = $2::text AND r.status = 'pending') < $4::int
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [yo, otro, MAX_ENVIADAS, MAX_RECIBIDAS],
      );
      if (rows.length > 0) {
        return { ok: true, estado: "enviada", nombre, peticionId: Number(rows[0].id) };
      }
      const tope = await topeDePeticiones(yo, otro);
      if (tope) return fallo(tope);
      continue;
    }

    const mia = par.user_id === yo;

    if (par.status === "accepted") return fallo("Ya sois amigos");

    if (par.status === "blocked_both" || ((par.status === "blocked" || par.status === "blocked_declined") && mia)) {
      return fallo("Has bloqueado a este entrenador. Desbloquéalo para poder añadirle.");
    }
    if (par.status === "blocked" || par.status === "blocked_declined") {
      // Me ha bloqueado: la misma respuesta que si la petición hubiera salido.
      return { ok: true, estado: "enviada", nombre, peticionId: null };
    }

    if (par.status === "pending" || par.status === "declined") {
      if (mia) return { ok: true, estado: "enviada", nombre, peticionId: par.id };
      // La fila es SUYA y apunta a mí: aceptarla es lo que los dos queremos.
      const r = await aceptarFila(par.id, yo, ["pending", "declined"]);
      if (r.aceptada) return { ok: true, estado: "amigos", nombre, peticionId: par.id };
      if (r.motivo === "tope_mio" || r.motivo === "tope_suyo") return fallo(avisoDeAceptar(r.motivo));
      continue;
    }

    if (par.status === "withdrawn") {
      if (mia) {
        // Era una petición mía rechazada que yo mismo cancelé. Reenviarla la
        // devuelve a 'declined': vuelve a mi lista de enviadas y el otro no
        // recibe nada, que es lo que el rechazo le garantizaba.
        const { rowCount } = await sql.query(
          `UPDATE friendships SET status = 'declined'
            WHERE id = $1::int AND user_id = $2 AND status = 'withdrawn'`,
          [par.id, yo],
        );
        if (rowCount) return { ok: true, estado: "enviada", nombre, peticionId: par.id };
        continue;
      }
      // La pidió él, le rechacé y la retiró: ya no hay nada suyo que aceptar,
      // así que ahora la petición es MÍA. Se le da la vuelta a la fila en vez
      // de insertar otra, porque sólo cabe una por pareja.
      const { rows } = await sql.query(
        `UPDATE friendships f
            SET user_id = $1::text, friend_id = $2::text, status = 'pending'
          WHERE f.id = $3::int
            AND f.user_id = $2::text AND f.friend_id = $1::text
            AND f.status = 'withdrawn'
            AND (SELECT count(*) FROM friendships e
                  WHERE e.user_id = $1::text AND e.status = 'pending') < $4::int
            AND (SELECT count(*) FROM friendships r
                  WHERE r.friend_id = $2::text AND r.status = 'pending') < $5::int
          RETURNING f.id`,
        [yo, otro, par.id, MAX_ENVIADAS, MAX_RECIBIDAS],
      );
      if (rows.length > 0) return { ok: true, estado: "enviada", nombre, peticionId: par.id };
      const tope = await topeDePeticiones(yo, otro);
      if (tope) return fallo(tope);
      continue;
    }

    // Un estado que este código no conoce: mejor no escribir encima.
    return fallo("No se pudo enviar la petición");
  }
  return fallo("No se pudo enviar la petición. Inténtalo de nuevo.");
}

/** El aviso del tope de peticiones que se ha alcanzado, o `null` si ninguno. */
async function topeDePeticiones(yo: string, otro: string): Promise<string | null> {
  const { rows } = await sql.query(
    `SELECT (SELECT count(*)::int FROM friendships e
              WHERE e.user_id = $1::text AND e.status = 'pending') AS enviadas,
            (SELECT count(*)::int FROM friendships r
              WHERE r.friend_id = $2::text AND r.status = 'pending') AS recibidas`,
    [yo, otro],
  );
  if (Number(rows[0]?.enviadas) >= MAX_ENVIADAS) {
    return `Tienes ${MAX_ENVIADAS} peticiones sin contestar. Cancela alguna antes de enviar otra.`;
  }
  if (Number(rows[0]?.recibidas) >= MAX_RECIBIDAS) {
    return "Ese entrenador tiene demasiadas peticiones pendientes. Inténtalo más tarde.";
  }
  return null;
}

/**
 * Pide amistad a un entrenador, o la acepta si él ya me la había pedido.
 *
 * Sustituye a `addFriend`, que aceptaba un id libre o un NOMBRE y con el
 * nombre elegía con `LIMIT 1` a un homónimo cualquiera: bastaba ponerse el
 * nombre de otro para recibir sus peticiones. Aquí no hay camino por nombre:
 * el destino es un código, un anuncio o un id, y los tres identifican a UNA
 * persona.
 */
export async function enviarPeticion(destino: Destino): Promise<ResultadoEnviarPeticion> {
  const { userId } = await auth();
  if (!userId) return fallo("No autorizado");
  try {
    const r = await resolverDestino(destino);
    if (!r.ok) return fallo(r.error);
    if (r.id === userId) return fallo("No puedes añadirte a ti mismo");
    const nombre = await nombreDe(r.id);
    if (nombre === null) return fallo("Ese entrenador no existe.");
    return await pedirAmistad(userId, r.id, nombre);
  } catch (e) {
    console.error("enviarPeticion error:", e);
    return fallo("No se pudo enviar la petición");
  }
}

/** Acepta una petición que me han enviado. `peticionId` sale de `getPeticiones`. */
export async function aceptarPeticion(peticionId: number): Promise<ResultadoAceptarPeticion> {
  const { userId } = await auth();
  if (!userId) return fallo("No autorizado");
  const id = idDeFila(peticionId);
  if (id === null) return fallo("Petición no válida");
  try {
    const r = await aceptarFila(id, userId, ["pending"]);
    if (!r.aceptada) return fallo(avisoDeAceptar(r.motivo));
    return { ok: true, nombre: (await nombreDe(r.otro)) ?? "Entrenador" };
  } catch (e) {
    console.error("aceptarPeticion error:", e);
    return fallo("No se pudo aceptar la petición");
  }
}

/**
 * Rechaza una petición que me han enviado. LA FILA SE QUEDA, en 'declined'.
 *
 * Antes «Ignorar» la borraba, y borrada no dejaba rastro: el otro podía
 * volver a pedir en el acto, sin límite. Con la fila en su sitio la pareja ya
 * está ocupada y `pedirAmistad` le contesta «enviada» sin escribir nada.
 */
export async function rechazarPeticion(peticionId: number): Promise<ResultadoSocial> {
  const { userId } = await auth();
  if (!userId) return fallo("No autorizado");
  const id = idDeFila(peticionId);
  if (id === null) return fallo("Petición no válida");
  try {
    const { rowCount } = await sql.query(
      `UPDATE friendships SET status = 'declined'
        WHERE id = $1::int AND friend_id = $2 AND status = 'pending'`,
      [id, userId],
    );
    if (!rowCount) return fallo("La petición ya no está disponible");
    return { ok: true };
  } catch (e) {
    console.error("rechazarPeticion error:", e);
    return fallo("No se pudo rechazar la petición");
  }
}

/**
 * Cancela una petición que envié yo.
 *
 * Si sigue 'pending' se borra: no ha pasado nada y la pareja queda libre. Si
 * el otro ya la había rechazado NO se borra —eso le devolvería al rechazado
 * la posibilidad de reenviar, que es justo lo que el rechazo cierra—: pasa a
 * 'withdrawn', que la saca de mi lista de enviadas y deja la pareja ocupada.
 * Para quien cancela las dos cosas son lo mismo: la petición desaparece.
 *
 * Las dos ramas van en UNA sentencia y son excluyentes por el estado del que
 * parten, así que no pueden aplicar las dos sobre la misma fila.
 *
 * DOS VUELTAS, POR EL RECHAZO SIMULTÁNEO. Es la misma carrera que la de
 * `desbloquear`: si el otro la rechaza mientras yo la cancelo, mi sentencia
 * espera al candado de la fila y, al soltarse, ya no es 'pending' sino
 * 'declined'. La rama que borra ya no la ve, y la que retira no la había visto
 * como candidata: no cambia nada. Antes eso era «La petición ya no está
 * disponible» con la petición todavía en mi lista de enviadas, y hacía falta un
 * segundo toque. Ahora, si no cambió nada, se mira si la fila sigue siendo mía
 * y cancelable, y se repite la MISMA sentencia, que en la segunda vuelta ya la
 * ve como es.
 */
export async function cancelarPeticion(peticionId: number): Promise<ResultadoSocial> {
  const { userId } = await auth();
  if (!userId) return fallo("No autorizado");
  const id = idDeFila(peticionId);
  if (id === null) return fallo("Petición no válida");
  try {
    for (let vuelta = 0; vuelta < 2; vuelta++) {
      const { rows } = await sql.query(
        `WITH borrada AS (
           DELETE FROM friendships
            WHERE id = $1::int AND user_id = $2::text AND status = 'pending'
           RETURNING id
         ),
         retirada AS (
           UPDATE friendships
              SET status = 'withdrawn'
            WHERE id = $1::int AND user_id = $2::text AND status = 'declined'
           RETURNING id
         )
         SELECT (SELECT count(*)::int FROM borrada)
              + (SELECT count(*)::int FROM retirada) AS cambios`,
        [id, userId],
      );
      if (Number(rows[0]?.cambios)) return { ok: true };
      const { rows: sigue } = await sql.query(
        `SELECT 1
           FROM friendships f
          WHERE f.id = $1::int AND f.user_id = $2::text
            AND f.status IN ('pending', 'declined')`,
        [id, userId],
      );
      if (sigue.length === 0) return fallo("La petición ya no está disponible");
    }
    return fallo("No se pudo cancelar la petición. Inténtalo de nuevo.");
  } catch (e) {
    console.error("cancelarPeticion error:", e);
    return fallo("No se pudo cancelar la petición");
  }
}

/**
 * Deja de ser amigo de alguien Y CANCELA LAS OFERTAS PENDIENTES ENTRE LOS DOS,
 * en la misma sentencia.
 *
 * Antes se borraba la amistad y nada más: las ofertas del ex amigo (hasta 20)
 * seguían en «Recibidas» y seguían siendo aceptables, porque la amistad sólo
 * se miraba al crearlas. Quien quitaba a alguien tenía que rechazarlas una a
 * una, y una oferta olvidada se podía aceptar semanas después.
 *
 * Las ofertas se marcan 'cancelled' y no se borran: el historial de los dos
 * las sigue enseñando. Va en una sentencia para que no exista el instante en
 * que ya no son amigos y la oferta sigue viva; y si `acceptTradeOffer` llega a
 * la vez, uno de los dos espera al candado de la fila de la oferta y después
 * la ve ya cerrada (o ya cancelada), nunca a medias.
 *
 * BORRA TODAS LAS FILAS 'accepted' DE LA PAREJA, NO SÓLO LA DEL ID. Con
 * `idx_friendships_par` hay una y da igual. Pero ese índice puede faltar en una
 * base antigua con duplicados (su CREATE falla y /migrate-core lo deja en
 * «fallidas»), y entonces borrar por id dejaba la otra fila: se respondía
 * éxito, seguían siendo amigos y `createTradeOffer` seguía viendo amistad. El
 * id sigue siendo la llave —la fila `p` tiene que ser mía y estar aceptada—;
 * lo que cambia es que arrastra a sus gemelas, en cualquiera de las dos
 * direcciones.
 */
export async function eliminarAmigo(amistadId: number): Promise<ResultadoEliminarAmigo> {
  const { userId } = await auth();
  if (!userId) return fallo("No autorizado");
  const id = idDeFila(amistadId);
  if (id === null) return fallo("Amistad no válida");
  try {
    const { rows } = await sql.query(
      `WITH baja AS (
         DELETE FROM friendships f
          USING friendships p
          WHERE p.id = $1::int
            AND p.status = 'accepted'
            AND (p.user_id = $2::text OR p.friend_id = $2::text)
            AND f.status = 'accepted'
            AND ((f.user_id = p.user_id AND f.friend_id = p.friend_id)
              OR (f.user_id = p.friend_id AND f.friend_id = p.user_id))
         RETURNING f.user_id, f.friend_id
       ),
       ofertas AS (
         UPDATE trade_offers t
            SET status = 'cancelled', updated_at = NOW()
           FROM baja b
          WHERE t.status = 'pending'
            AND ((t.sender_id = b.user_id AND t.receiver_id = b.friend_id)
              OR (t.sender_id = b.friend_id AND t.receiver_id = b.user_id))
         RETURNING t.id
       )
       SELECT (SELECT count(*)::int FROM baja)    AS bajas,
              (SELECT count(*)::int FROM ofertas) AS ofertas`,
      [id, userId],
    );
    if (!Number(rows[0]?.bajas)) return fallo("Ese entrenador ya no está en tus amigos");
    return { ok: true, ofertasCanceladas: Number(rows[0]?.ofertas) || 0 };
  } catch (e) {
    console.error("eliminarAmigo error:", e);
    return fallo("No se pudo eliminar al amigo");
  }
}

/**
 * Bloquea a un entrenador: corta la amistad o la petición que hubiera, cancela
 * las ofertas pendientes entre los dos y le saca de mi búsqueda (y a mí de la
 * suya). Todo en UNA sentencia.
 *
 * El bloqueo ES la fila de la pareja: pasa a 'blocked' con `user_id` = quien
 * bloquea. Reutilizar la fila es lo que hace que no pida migración, y que
 * `pedirAmistad` lo encuentre sin mirar en ningún otro sitio.
 *
 * SI EL OTRO YA ME HABÍA BLOQUEADO, la fila pasa a 'blocked_both' y no cambia
 * de dueño. Sin ese estado mi bloqueo se perdería —sólo hay una fila— en
 * cuanto él levantara el suyo, y decirme «ya estás bloqueado» sería contarme
 * algo que no tengo por qué saber. Desde fuera las dos situaciones responden
 * igual: éxito.
 *
 * No se dice éxito a ciegas: si la sentencia no cambia ninguna fila se
 * comprueba que es porque el bloqueo ya estaba puesto.
 */
export async function bloquearEntrenador(destino: Destino): Promise<ResultadoSocial> {
  const { userId } = await auth();
  if (!userId) return fallo("No autorizado");
  try {
    const r = await resolverDestino(destino);
    if (!r.ok) return fallo(r.error);
    if (r.id === userId) return fallo("No puedes bloquearte a ti mismo");

    // DOS VUELTAS. Si los dos se bloquean a la vez y no había fila, uno inserta
    // y el otro choca con el índice de pareja: su sentencia no cambia nada y la
    // fila que queda es el bloqueo AJENO, no el suyo. Antes eso era un «No se
    // pudo bloquear». Repetir la misma sentencia lo arregla sola: en la segunda
    // vuelta ya ve la fila del otro y la pasa a 'blocked_both'.
    for (let vuelta = 0; vuelta < 2; vuelta++) {
      const { rows } = await sql.query(SENTENCIA_BLOQUEAR, [userId, r.id]);
      if (Number(rows[0]?.actualizadas) || Number(rows[0]?.creadas)) return { ok: true };

      const par = await leerPar(userId, r.id);
      const yaBloqueado =
        !!par &&
        (par.status === "blocked_both" ||
          ((par.status === "blocked" || par.status === "blocked_declined") && par.user_id === userId));
      if (yaBloqueado) return { ok: true };
    }
    return fallo("No se pudo bloquear. Inténtalo de nuevo.");
  } catch (e) {
    console.error("bloquearEntrenador error:", e);
    return fallo("No se pudo bloquear a ese entrenador");
  }
}

/* La sentencia de `bloquearEntrenador`, fuera de la función porque se lanza
 * hasta dos veces. $1 es quien bloquea y $2 el bloqueado.
 *
 * EL ESTADO 'blocked_declined' es «$1 ha bloqueado a $2, y ANTES $2 le había
 * rechazado una petición». Hace falta porque el bloqueo reutiliza la fila de la
 * pareja: al pasar una 'declined' (o su 'withdrawn') a 'blocked' se perdía el
 * rechazo, y desbloquear borraba la fila y dejaba al rechazado pedir otra vez. */
const SENTENCIA_BLOQUEAR = `WITH previa AS (
         UPDATE friendships f
            SET status    = CASE WHEN f.status IN ('blocked', 'blocked_declined') AND f.user_id = $2::text
                                 THEN 'blocked_both'
                                 WHEN f.status IN ('declined', 'withdrawn') AND f.user_id = $1::text
                                 THEN 'blocked_declined'
                                 ELSE 'blocked' END,
                user_id   = CASE WHEN f.status IN ('blocked', 'blocked_declined') AND f.user_id = $2::text
                                 THEN f.user_id ELSE $1::text END,
                friend_id = CASE WHEN f.status IN ('blocked', 'blocked_declined') AND f.user_id = $2::text
                                 THEN f.friend_id ELSE $2::text END
          WHERE ((f.user_id = $1::text AND f.friend_id = $2::text)
              OR (f.user_id = $2::text AND f.friend_id = $1::text))
            AND f.status <> 'blocked_both'
            AND NOT (f.status IN ('blocked', 'blocked_declined') AND f.user_id = $1::text)
         RETURNING f.id
       ),
       nueva AS (
         INSERT INTO friendships (user_id, friend_id, status)
         SELECT $1::text, $2::text, 'blocked'
          WHERE NOT EXISTS (
                  SELECT 1 FROM friendships g
                   WHERE (g.user_id = $1::text AND g.friend_id = $2::text)
                      OR (g.user_id = $2::text AND g.friend_id = $1::text))
         ON CONFLICT DO NOTHING
         RETURNING id
       ),
       ofertas AS (
         UPDATE trade_offers t
            SET status = 'cancelled', updated_at = NOW()
          WHERE t.status = 'pending'
            AND ((t.sender_id = $1::text AND t.receiver_id = $2::text)
              OR (t.sender_id = $2::text AND t.receiver_id = $1::text))
         RETURNING t.id
       )
       SELECT (SELECT count(*)::int FROM previa)  AS actualizadas,
              (SELECT count(*)::int FROM nueva)   AS creadas,
              (SELECT count(*)::int FROM ofertas) AS ofertas`;

/** A quién tengo bloqueado. Sin ids de Clerk: cada fila se desbloquea por su `id`. */
export async function getBloqueados(): Promise<EntrenadorBloqueado[]> {
  const { userId } = await auth();
  if (!userId) return [];
  try {
    const { rows } = await sql.query(
      `SELECT f.id,
              CASE WHEN f.user_id = $1::text THEN f.friend_id ELSE f.user_id END AS otro
         FROM friendships f
        WHERE (f.status IN ('blocked', 'blocked_declined') AND f.user_id = $1::text)
           OR (f.status = 'blocked_both' AND (f.user_id = $1::text OR f.friend_id = $1::text))
        ORDER BY f.id DESC
        LIMIT $2::int`,
      [userId, MAX_FILAS_LISTA],
    );
    if (rows.length === 0) return [];
    const ids = rows.map((r: FilaSQL) => String(r.otro));
    const { rows: nombres } = await sql.query(
      `SELECT u.id, ${NOMBRE_VISIBLE} AS nombre FROM users u WHERE u.id = ANY($1::text[])`,
      [ids],
    );
    const nombreDeId = new Map<string, string>(
      nombres.map((n: FilaSQL): [string, string] => [String(n.id), String(n.nombre)]),
    );
    const codigos = await codigosDe(ids);
    return rows.map((r: FilaSQL) => ({
      id: Number(r.id),
      nombre: nombreDeId.get(String(r.otro)) ?? "Entrenador",
      etiqueta: etiquetaDeCodigo(codigos.get(String(r.otro)) ?? ""),
    }));
  } catch (e) {
    console.error("getBloqueados error:", e);
    return [];
  }
}

/**
 * Levanta MI bloqueo. `bloqueoId` sale de `getBloqueados`.
 *
 * Si el bloqueo era sólo mío la fila se borra y la pareja queda libre, como
 * dos extraños (la amistad anterior no vuelve: bloquear la cortó). Si era
 * mutuo, lo que queda es el bloqueo del otro: la fila vuelve a 'blocked' con
 * él de dueño. Y si yo había bloqueado a alguien que ANTES me había rechazado
 * ('blocked_declined'), la fila tampoco se borra: vuelve a 'withdrawn', que es
 * donde está una petición rechazada que su emisor retiró. Borrarla era un
 * atajo para saltarse el rechazo silencioso: rechazado → bloquear → desbloquear
 * → pareja libre → petición nueva, tantas veces como se quisiera. Las tres
 * ramas parten de estados distintos, así que sólo una puede tocar la fila.
 *
 * DOS VUELTAS, POR EL DESBLOQUEO DOBLE. Si los dos levantan a la vez un
 * bloqueo mutuo, el segundo espera al candado de la fila y, al soltarse, ésta
 * ya no es 'blocked_both' sino 'blocked' con ÉL de dueño: su sentencia no toca
 * nada (la rama que borra no la había visto como candidata). Antes se le decía
 * «ya no está bloqueado» con su bloqueo todavía puesto. Ahora, si no cambió
 * nada, se mira si mi bloqueo sigue ahí y se repite la MISMA sentencia, que en
 * la segunda vuelta ya ve la fila como es.
 */
export async function desbloquear(bloqueoId: number): Promise<ResultadoSocial> {
  const { userId } = await auth();
  if (!userId) return fallo("No autorizado");
  const id = idDeFila(bloqueoId);
  if (id === null) return fallo("Bloqueo no válido");
  try {
    for (let vuelta = 0; vuelta < 2; vuelta++) {
      const { rows } = await sql.query(SENTENCIA_DESBLOQUEAR, [id, userId]);
      if (Number(rows[0]?.cambios)) return { ok: true };
      const { rows: sigue } = await sql.query(
        `SELECT 1
           FROM friendships f
          WHERE f.id = $1::int
            AND ((f.status IN ('blocked', 'blocked_declined') AND f.user_id = $2::text)
              OR (f.status = 'blocked_both' AND (f.user_id = $2::text OR f.friend_id = $2::text)))`,
        [id, userId],
      );
      if (sigue.length === 0) return fallo("Ese entrenador ya no está bloqueado");
    }
    return fallo("No se pudo desbloquear. Inténtalo de nuevo.");
  } catch (e) {
    console.error("desbloquear error:", e);
    return fallo("No se pudo desbloquear");
  }
}

/* La sentencia de `desbloquear`, fuera de la función porque se lanza hasta dos
 * veces (ver arriba). No lleva acentos graves dentro: es un literal de plantilla. */
const SENTENCIA_DESBLOQUEAR = `WITH fuera AS (
         DELETE FROM friendships f
          WHERE f.id = $1::int AND f.status = 'blocked' AND f.user_id = $2::text
         RETURNING f.id
       ),
       media AS (
         UPDATE friendships f
            SET status    = 'blocked',
                user_id   = CASE WHEN f.user_id = $2::text THEN f.friend_id ELSE f.user_id END,
                friend_id = $2::text
          WHERE f.id = $1::int
            AND f.status = 'blocked_both'
            AND (f.user_id = $2::text OR f.friend_id = $2::text)
         RETURNING f.id
       ),
       retirada AS (
         UPDATE friendships f
            SET status = 'withdrawn'
          WHERE f.id = $1::int AND f.status = 'blocked_declined' AND f.user_id = $2::text
         RETURNING f.id
       )
       SELECT (SELECT count(*)::int FROM fuera)
            + (SELECT count(*)::int FROM media)
            + (SELECT count(*)::int FROM retirada) AS cambios`;

/**
 * Las filas de la búsqueda para una lista de ids, en el mismo orden. Aquí es
 * donde el id se cambia por el código: de esta función no sale ninguno.
 *
 * Se cae de la lista quien no tenga fila en `users`, quien esté bloqueado en
 * cualquiera de los dos sentidos y —no debería pasar— quien se haya quedado
 * sin código tras los reintentos.
 */
async function filasDeBusqueda(yo: string, ids: string[]): Promise<EntrenadorEncontrado[]> {
  if (ids.length === 0) return [];
  const datos = await datosDeEntrenadores(yo, ids);
  const pares = await paresCon(yo, ids);
  const codigos = await codigosDe(ids);
  const filas: EntrenadorEncontrado[] = [];
  for (const id of ids) {
    const d = datos.get(id);
    const codigo = codigos.get(id);
    if (!d || !codigo) continue;
    const rel =
      id === yo
        ? { relacion: "yo" as RelacionSocial, peticionId: null, oculto: false }
        : relacionDesde(pares.get(id), yo);
    if (rel.oculto) continue;
    filas.push({
      codigo,
      nombre: d.nombre,
      etiqueta: etiquetaDeCodigo(codigo),
      unicas: d.unicas,
      cartas: d.cartas,
      enComun: id === yo ? 0 : d.enComun,
      relacion: rel.relacion,
      peticionId: rel.peticionId,
    });
  }
  return filas;
}

/**
 * Busca entrenadores por NOMBRE o por CÓDIGO, en el mismo campo.
 *
 * Sustituye a `searchUsersByName`, que tenía tres problemas:
 *  · devolvía el id de Clerk de cada resultado a cualquiera con sesión;
 *  · llevaba `LIMIT 8` sin `ORDER BY`: con más de ocho coincidencias salían
 *    ocho cualesquiera, y el que se buscaba podía no estar;
 *  · dos «Paul» eran dos filas idénticas, sin forma de saber cuál era cuál.
 *
 * PRIMERO EL CÓDIGO. Si lo tecleado se puede leer como un código (con guion,
 * en minúsculas, con espacios, o el enlace entero pegado) se busca exacto. Si
 * existe, ése es el resultado. Si no, se sigue por el nombre: «SAMANTHA» son
 * ocho letras válidas del alfabeto, y un nombre no puede dejar de encontrarse
 * por parecer un código.
 *
 * DESPUÉS EL NOMBRE, con los comodines de LIKE escapados (sin eso, buscar «%»
 * devolvía usuarios cualesquiera) y un orden estable: el nombre exacto, luego
 * los que empiezan por lo tecleado, luego el resto por orden alfabético. Se
 * pide uno más de los que se enseñan para poder decir «hay más resultados» en
 * vez de fingir que la lista está completa.
 *
 * NO LEE `users.created_at`: esa columna sólo existe si la tabla nació con
 * /migrate-core.
 */
export async function buscarEntrenadores(consulta: string): Promise<ResultadoBusqueda> {
  const { userId } = await auth();
  if (!userId) return fallo("No autorizado");
  if (typeof consulta !== "string") return fallo("Búsqueda no válida");

  const texto = consulta.trim();
  const codigo = normalizarCodigoAmigo(consulta);
  // Ocho letras sin un solo dígito ni guion pueden ser un nombre: sólo se da
  // por código lo que lleva algo que un nombre no llevaría.
  const pareceCodigo = codigo !== null && /[0-9-]|\/invitar\//.test(texto);
  const vacia: ResultadoBusqueda = { ok: true, resultados: [], hayMas: false, porCodigo: false, pareceCodigo };

  try {
    if (codigo) {
      await asegurarEsquemaSocial();
      const { rows } = await sql.query(`SELECT user_id FROM friend_codes WHERE code = $1`, [codigo]);
      if (rows.length > 0) {
        const filas = await filasDeBusqueda(userId, [String(rows[0].user_id)]);
        if (filas.length > 0) {
          return { ok: true, resultados: filas, hayMas: false, porCodigo: true, pareceCodigo: true };
        }
      }
    }

    if (texto.length < MIN_CONSULTA || texto.length > MAX_CONSULTA) return vacia;
    // Un carácter de control no forma parte de ningún nombre, y el NUL además
    // hace lanzar a Postgres (22021): la búsqueda acababa en «Revisa tu
    // conexión» por algo que no era la conexión.
    if (/[\u0000-\u001f\u007f]/.test(texto)) return vacia;

    const minusculas = texto.toLowerCase();
    const escapada = minusculas.replace(/[\\%_]/g, (m) => `\\${m}`);
    const { rows } = await sql.query(
      `SELECT u.id
         FROM users u
        WHERE LOWER(u.username) LIKE $2::text
          AND u.id <> $1::text
          AND NOT EXISTS (
                SELECT 1 FROM friendships b
                 WHERE b.status IN ('blocked', 'blocked_both', 'blocked_declined')
                   AND ((b.user_id = $1::text AND b.friend_id = u.id)
                     OR (b.user_id = u.id AND b.friend_id = $1::text)))
        ORDER BY (LOWER(u.username) = $3::text) DESC,
                 (LOWER(u.username) LIKE $4::text) DESC,
                 LOWER(u.username),
                 u.id
        LIMIT $5::int`,
      [userId, `%${escapada}%`, minusculas, `${escapada}%`, MAX_RESULTADOS + 1],
    );
    const ids = rows.map((r: FilaSQL) => String(r.id));
    const resultados = await filasDeBusqueda(userId, ids.slice(0, MAX_RESULTADOS));
    return { ok: true, resultados, hayMas: ids.length > MAX_RESULTADOS, porCodigo: false, pareceCodigo };
  } catch (e) {
    console.error("buscarEntrenadores error:", e);
    return fallo("No se pudo buscar. Revisa tu conexión.");
  }
}

/**
 * Las peticiones que me han enviado y las que he enviado yo.
 *
 * LIGERA A PROPÓSITO: con la hoja «Añadir amigo» abierta se sondea cada pocos
 * segundos, así que el caso normal —nada nuevo— es UNA consulta. Sólo cuando
 * hay peticiones recibidas se paga la segunda, la de los datos de quien pide
 * (cuántas cartas tiene, amigos en común), que es lo que ayuda a decidir.
 *
 * Las ENVIADAS incluyen las que el otro rechazó ('declined'): el rechazo es
 * silencioso y para quien la envió sigue pendiente. No hay lista de enviadas
 * que distinga unas de otras, ni aquí ni en ningún otro sitio.
 *
 * Ordena por `id` y no por fecha: `friendships.created_at` sólo existe si la
 * tabla nació con /migrate-core.
 */
export async function getPeticiones(): Promise<Peticiones> {
  const { userId } = await auth();
  if (!userId) return { recibidas: [], enviadas: [] };
  try {
    await asegurarEsquemaSocial();
    const { rows } = await sql.query(
      `SELECT p.id, p.recibida, p.otro,
              ${NOMBRE_VISIBLE} AS nombre,
              fc.code AS codigo
         FROM (
               (SELECT f.id, f.user_id AS otro, TRUE AS recibida
                  FROM friendships f
                 WHERE f.friend_id = $1::text AND f.status = 'pending'
                 ORDER BY f.id DESC
                 LIMIT $2::int)
               UNION ALL
               (SELECT g.id, g.friend_id AS otro, FALSE AS recibida
                  FROM friendships g
                 WHERE g.user_id = $1::text AND g.status IN ('pending', 'declined')
                 ORDER BY g.id DESC
                 LIMIT $2::int)
              ) p
         LEFT JOIN users u ON u.id = p.otro
         LEFT JOIN friend_codes fc ON fc.user_id = p.otro
        ORDER BY p.id DESC`,
      [userId, MAX_FILAS_LISTA],
    );
    if (rows.length === 0) return { recibidas: [], enviadas: [] };

    // Quien aún no tenga código lo estrena aquí. Pasa una vez por persona.
    const sinCodigo = rows.filter((r: FilaSQL) => !r.codigo).map((r: FilaSQL) => String(r.otro));
    const nuevos = sinCodigo.length > 0 ? await codigosDe(sinCodigo) : new Map<string, string>();
    const etiquetaDe = (r: FilaSQL) => etiquetaDeCodigo(r.codigo ? String(r.codigo) : nuevos.get(String(r.otro)) ?? "");

    const filasRecibidas: FilaSQL[] = rows.filter((r: FilaSQL) => r.recibida === true);
    const datos = await datosDeEntrenadores(userId, filasRecibidas.map((r) => String(r.otro)));

    return {
      recibidas: filasRecibidas.map((r) => ({
        id: Number(r.id),
        nombre: String(r.nombre),
        etiqueta: etiquetaDe(r),
        unicas: datos.get(String(r.otro))?.unicas ?? 0,
        enComun: datos.get(String(r.otro))?.enComun ?? 0,
      })),
      enviadas: rows
        .filter((r: FilaSQL) => r.recibida !== true)
        .map((r: FilaSQL) => ({ id: Number(r.id), nombre: String(r.nombre), etiqueta: etiquetaDe(r) })),
    };
  } catch (e) {
    console.error("getPeticiones error:", e);
    // CON LA MARCA `error`. Devolver dos listas vacías a secas era decir «no
    // tienes peticiones», y la pantalla lo leía así: las vaciaba y, al ver que
    // sus enviadas habían «desaparecido», daba por hecho que las habían
    // aceptado y releía la lista de amigos. Un fallo de SQL no es una respuesta.
    return { recibidas: [], enviadas: [], error: true };
  }
}

/**
 * Cuánto hay esperándome: peticiones de amistad y ofertas de intercambio.
 *
 * Es lo que alimenta la insignia de la pestaña Social, así que se llama al
 * iniciar sesión y cada vez que la aplicación vuelve a primer plano. Por eso
 * son dos `count` sobre índices que ya existen (`idx_friendships_friend` y
 * `idx_trade_offers_receiver`), en un solo viaje, y SIN asegurar ningún
 * esquema: no toca `friend_codes` y no puede costar un CREATE TABLE.
 *
 * Las ofertas se cuentan SÓLO si su emisor sigue siendo amigo: es el mismo
 * filtro de `getIncomingTradeOffers`, para que la insignia no anuncie una
 * oferta que la bandeja no va a enseñar.
 *
 * Si algo falla devuelve ceros en vez de lanzar: una insignia no puede tumbar
 * la barra de navegación.
 */
export async function getSocialPendientes(): Promise<SocialPendientes> {
  const { userId } = await auth();
  if (!userId) return { peticiones: 0, ofertas: 0 };
  try {
    const { rows } = await sql.query(
      `SELECT (SELECT count(*)::int FROM friendships
                WHERE friend_id = $1::text AND status = 'pending')   AS peticiones,
              (SELECT count(*)::int FROM trade_offers t
                WHERE t.receiver_id = $1::text AND t.status = 'pending'
                  AND EXISTS (
                        SELECT 1 FROM friendships f
                         WHERE f.status = 'accepted'
                           AND ((f.user_id = t.sender_id AND f.friend_id = t.receiver_id)
                             OR (f.user_id = t.receiver_id AND f.friend_id = t.sender_id)))) AS ofertas`,
      [userId],
    );
    return { peticiones: Number(rows[0]?.peticiones) || 0, ofertas: Number(rows[0]?.ofertas) || 0 };
  } catch (e) {
    console.error("getSocialPendientes error:", e);
    return { peticiones: 0, ofertas: 0 };
  }
}

/**
 * La lista de amigos con su ranking. SÓLO eso: las peticiones salen de
 * `getPeticiones` y el recuento de ofertas de `getSocialPendientes`. Antes
 * devolvía también `requests` e `incomingTrades`, dos consultas más en la
 * acción más cara de Social que ya no leía nadie.
 */
export async function getSocialOverview() {
  const { userId } = await auth();
  if (!userId) return { friends: [] };
  try {
    // TOPE EN LA LISTA DE AMIGOS. La consulta de más abajo agrega la colección
    // de TODOS ellos de golpe y no llevaba límite. El tope de amigos se
    // comprueba al aceptar, pero una cuenta anterior a ese tope puede traer
    // más; el doble deja margen y sigue acotando el coste.
    //
    // UNA FILA POR AMIGO, AUNQUE LA PAREJA TENGA DOS. Sin `idx_friendships_par`
    // (su CREATE falla en una base que ya trae duplicados, y /migrate-social lo
    // avisa pero no lo impide) dos «Añadir» cruzados dejan dos filas, cada uno
    // acepta la del otro y esta lista enseñaba al mismo amigo dos veces. El
    // DISTINCT ON se queda con la de menor id, que es la que `eliminarAmigo`
    // usa de llave para llevarse también a sus gemelas. Con el índice hay una
    // fila por pareja y esto no cambia nada. El tope va DESPUÉS de deduplicar:
    // antes, las gemelas gastaban sitio del LIMIT.
    const { rows: accepted } = await sql.query(
      `SELECT a.friendship_id,
              a.friend_id,
              COALESCE(u.username, 'Entrenador') AS friend_name
         FROM (
               SELECT DISTINCT ON (p.friend_id) p.friendship_id, p.friend_id
                 FROM (
                       SELECT f.id AS friendship_id,
                              CASE WHEN f.user_id = $1::text THEN f.friend_id ELSE f.user_id END AS friend_id
                         FROM friendships f
                        WHERE (f.user_id = $1::text OR f.friend_id = $1::text)
                          AND f.status = 'accepted'
                      ) p
                ORDER BY p.friend_id, p.friendship_id
              ) a
         LEFT JOIN users u ON u.id = a.friend_id
        ORDER BY a.friendship_id
        LIMIT $2::int`,
      [userId, MAX_AMIGOS * 2],
    );
    const me: any = { friendship_id: "me", friend_id: userId, friend_name: "Tú", isMe: true };
    const all: any[] = [me, ...accepted.map((a: any) => ({ ...a, isMe: false }))];

    /* UNA CONSULTA PARA TODOS, NO UNA POR AMIGO.
     *
     * Esto era un `for` con un SELECT dentro: con veinte amigos, veintiún
     * viajes en serie y veintiún volcados de `user_collection` a memoria para
     * sumar tres números. Ahora se agrupa en SQL por (usuario, rareza), que es
     * el grano mínimo que necesita la fórmula del patrimonio, y se termina en
     * JS. El resultado son unas pocas decenas de filas por amigo en vez de una
     * por carta.
     */
    const ids = all.map((f) => f.friend_id);
    const { rows: agregados } = await sql.query(
      `SELECT uc.user_id,
              c.rarity,
              COUNT(*)::int              AS unicas,
              SUM(uc.quantity)::int      AS copias,
              array_agg(uc.quantity)     AS cantidades
         FROM user_collection uc
         JOIN cards c ON c.id = uc.card_id
        WHERE uc.user_id = ANY($1::text[]) AND uc.quantity > 0
        GROUP BY uc.user_id, c.rarity`,
      [ids],
    );

    const porUsuario = new Map<string, { value: number; cards: number; unique: number }>();
    for (const fr of all) porUsuario.set(fr.friend_id, { value: 0, cards: 0, unique: 0 });

    for (const row of agregados) {
      const acc = porUsuario.get(String(row.user_id));
      if (!acc) continue;
      acc.unique += Number(row.unicas);
      acc.cards += Number(row.copias);
      // PATRIMONIO REAL. Antes era `SELL_PRICES × copias`, que ignora la curva
      // decreciente por copias: el ranking premiaba acaparar repetidas que
      // valen la octava parte de lo que puntuaban. Cada carta vale su copia
      // protegida entera más lo que dé valorDeVenta por las repetidas.
      const base = precioDeCartaSuelta(row.rarity);
      for (const q of (row.cantidades ?? []) as number[]) {
        acc.value += base + valorDeVenta(row.rarity, Number(q));
      }
    }

    for (const fr of all) {
      const acc = porUsuario.get(fr.friend_id)!;
      fr.stats = { value: acc.value, cards: acc.cards, unique: acc.unique };
    }
    all.sort((a, b) => b.stats.value - a.stats.value);

    // La ETIQUETA de cada amigo (los cuatro últimos de su código), para que
    // salga con el mismo `Nombre #2345` y el mismo color que en la búsqueda y
    // en las peticiones. Va en su propio try: es un adorno, y si `friend_codes`
    // fallara no puede llevarse por delante la lista de amigos entera.
    try {
      const codigos = await codigosDe(ids);
      for (const fr of all) fr.etiqueta = etiquetaDeCodigo(codigos.get(fr.friend_id) ?? "") || null;
    } catch (e) {
      console.error("getSocialOverview: sin etiquetas:", e);
    }

    return { friends: all };
  } catch (e) {
    console.error("getSocialOverview error:", e);
    return { friends: [] };
  }
}

/** Cartas por lado. Era un 12 suelto repetido en el mensaje de error. */
const MAX_CARTAS_POR_LADO = 12;

/**
 * Tope del recado que acompaña a la oferta. No es un límite de producto: es que
 * antes no había NINGUNO y la columna se tragaba lo que le echaran.
 */
const MAX_MENSAJE = 280;

/**
 * Ofertas 'pending' que un emisor puede tener a la vez con el MISMO receptor.
 * 20 es holgado para jugar (la interfaz manda una oferta por gesto) y corta el
 * anegamiento de la bandeja ajena. Cambiarlo es cambiar este número.
 */
const MAX_OFERTAS_PENDIENTES = 20;

/** Longitud máxima de un id de usuario de Clerk, con margen. */
const MAX_ID_USUARIO = 200;

/**
 * Ids de carta plausibles ("sv3pt5-207", "swsh12pt5gg-GG01"). Es la MISMA forma
 * que valida `app/action.ts` en el mercado y en el bazar; no hay dos ideas
 * distintas de qué es un id de carta en este repositorio.
 */
const ID_CARTA = /^[a-zA-Z0-9._-]{1,40}$/;

/* ==================================================================== *
 * EL INTERCAMBIO ES LA EXCEPCIÓN A LA COPIA RESERVADA. A PROPÓSITO.
 * ====================================================================
 *
 * El mercado (utils/mercado.ts) exige `copiasEntregables`: para entregar N
 * copias hay que tener N + COPIAS_RESERVADAS, así que el álbum nunca se vacía.
 * Aquí NO se aplica esa regla, y la diferencia es deliberada:
 *
 *  · El mercado SACA cartas del juego a cambio de monedas. Sin la reserva, un
 *    jugador podía vaciarse el álbum sin darse cuenta y sin vuelta atrás.
 *  · El intercambio MUEVE cartas entre dos álbumes y no crea ni destruye
 *    ninguna: el CTE de `acceptTradeOffer` está construido para que la suma de
 *    deltas de cada carta sea exactamente cero. Lo que sale de un lado entra en
 *    el otro, y el que la entrega sabe perfectamente lo que está dando.
 *  · Con la reserva, una carta de la que sólo hay UNA copia no se podría
 *    intercambiar jamás — y ésas son justo las que se quieren intercambiar.
 *
 * SI ALGÚN DÍA SE CAMBIA DE CRITERIO, son tres sitios y van juntos o no van:
 * el guard de aquí abajo, el CTE `deuda` de `acceptTradeOffer` (que es el que
 * decide de verdad, sobre filas ya bloqueadas) y el tope del selector en
 * components/social/TradeBuilder.tsx, en SUS DOS columnas. Cambiar sólo éste es
 * puramente cosmético. Y hay que contar con que las ofertas ya creadas bajo la
 * regla vieja pasarían a cancelarse solas al aceptarlas.
 */
export async function createTradeOffer(receiverId: string, offeredIds: string[], requestedIds: string[], message?: string) {
  const { userId } = await auth();
  if (!userId) return { error: "No autorizado" };
  // NADA DE LO QUE LLEGA AQUÍ ESTÁ COMPROBADO POR EL TIPO. `createTradeOffer`
  // es una server action: la firma la escribe TypeScript para el compilador,
  // pero al otro lado hay una petición HTTP y ahí cabe cualquier cosa. Lo que
  // se guardaba sin mirar era justo lo que luego cegaba la bandeja del
  // destinatario (ver la nota de `parseIds`), así que la validación va ANTES de
  // tocar la base, no después.
  if (typeof receiverId !== "string" || receiverId.length === 0 || receiverId.length > MAX_ID_USUARIO) {
    return { error: "Oferta no válida" };
  }
  if (receiverId === userId) return { error: "No puedes intercambiar contigo" };
  if (!Array.isArray(offeredIds) || !Array.isArray(requestedIds)) return { error: "Oferta no válida" };
  if (offeredIds.length === 0 || requestedIds.length === 0) return { error: "Selecciona cartas en ambos lados" };
  if (offeredIds.length > MAX_CARTAS_POR_LADO || requestedIds.length > MAX_CARTAS_POR_LADO) {
    return { error: `Máximo ${MAX_CARTAS_POR_LADO} cartas por lado` };
  }
  if (![...offeredIds, ...requestedIds].every((id) => typeof id === "string" && ID_CARTA.test(id))) {
    return { error: "Oferta no válida" };
  }
  // El mensaje no tenía tope NINGUNO: una llamada podía dejar en la fila el
  // megabyte que quisiera, y el destinatario se lo comía entero en cada carga
  // de la bandeja. Se rechaza en vez de recortarlo, que sería mentirle al que
  // lo escribe.
  const texto = typeof message === "string" ? message.trim() : "";
  if (texto.length > MAX_MENSAJE) return { error: `El mensaje no puede pasar de ${MAX_MENSAJE} caracteres` };

  try {
    const { rows: fr } = await sql`
      SELECT 1 FROM friendships
      WHERE status = 'accepted' AND ((user_id = ${userId} AND friend_id = ${receiverId}) OR (user_id = ${receiverId} AND friend_id = ${userId}))
    `;
    if (fr.length === 0) return { error: "Solo puedes intercambiar con amigos" };

    /* LO OFRECIDO SE MIDE COMO LO MIDE `acceptTradeOffer`: COPIAS ENTREGABLES.
     *
     * Aquí se contaba `user_collection.quantity` a secas, pero el que decide de
     * verdad —el CTE `saldo` de `acceptTradeOffer`— descuenta las copias
     * graduadas activas. Las dos cuentas no coincidían, y el resultado era una
     * oferta que se podía crear, que el amigo veía, y que al aceptarla se
     * cancelaba sola diciendo "el emisor ya no tiene esas cartas" — mentira: las
     * tenía, estaban en la vitrina. La incoherencia se cierra por el lado de
     * NO PODER OFRECERLAS, y se dice al crear la oferta, que es cuando el que
     * la monta puede hacer algo al respecto.
     *
     * POR QUÉ ese lado y no el de "que el trueque las trate bien": la identidad
     * de una copia graduada es (usuario, carta, ÍNDICE DE COPIA), y ese índice
     * ES la nota (utils/graduacion.ts siembra con usuario|carta|índice). Por eso
     * ninguna sentencia del repositorio puede cambiarle a una fila de
     * graded_cards el user_id ni la copia —hay un invariante que lo vigila— y el
     * cambio de manos de una graduada se hace marcándola 'vendida' y creando
     * una fila nueva para el que la recibe. El trueque, en cambio, es CARTA POR
     * CARTA: mueve cantidades entre álbumes y no sabe qué copia concreta viaja.
     * Dejarle llevarse una graduada dejaría la fila de graded_cards con su dueño
     * viejo y `quantity` por debajo de las filas que la apuntan, que es
     * exactamente la corrupción que el resto del repositorio evita. Y no
     * contradice la excepción documentada arriba: el trueque sigue sin reservar
     * copia, una carta única sin graduar se intercambia igual que siempre.
     *
     * Y LO APALABRADO EN EL BAZAR, QUE ES EL MISMO DESAJUSTE OTRA VEZ. `saldo`
     * pasó a restar también lo que el bazar tiene comprometido de cada carta
     * —sus anuncios sueltos abiertos más la copia libre que la compra exige—
     * y esta comprobación se quedó contando sólo las graduadas: con 2 copias y
     * una anunciada la oferta se creaba, el amigo la veía, y al aceptarla se
     * cancelaba con "el emisor ya no puede entregar esas cartas". Ahora es la
     * misma cuenta, con el mismo «z.n» (sólo hay fila si la carta tiene algún
     * anuncio abierto), y se dice al crear la oferta, con su motivo.
     */
    const offCount = countById(offeredIds);
    const { rows: saldos } = await sql.query(
      `SELECT uc.card_id,
              uc.quantity::int        AS quantity,
              COALESCE(g.n, 0)::int   AS graduadas,
              COALESCE(z.n, 0)::int   AS apalabradas
         FROM user_collection uc
         LEFT JOIN (
           -- Solo las que siguen en la vitrina, igual que en acceptTradeOffer:
           -- una copia vendida conserva su fila para no soltar su indice, pero
           -- ya no ocupa copia.
           SELECT card_id, count(*)::int AS n
             FROM graded_cards
            WHERE user_id = $1 AND estado = 'activa'
            GROUP BY card_id
         ) g ON g.card_id = uc.card_id
         LEFT JOIN (
           -- Lo que el bazar tiene apalabrado: anuncios sueltos abiertos + 1.
           -- Es el z de saldo en acceptTradeOffer, acotado a este usuario.
           SELECT card_id,
                  (count(*) FILTER (WHERE graded_id IS NULL) + 1)::int AS n
             FROM bazar_listings
            WHERE seller_id = $1 AND estado = 'activa'
              AND card_id = ANY($2::text[])
            GROUP BY card_id
         ) z ON z.card_id = uc.card_id
        WHERE uc.user_id = $1 AND uc.card_id = ANY($2::text[])`,
      [userId, Object.keys(offCount)],
    );
    const saldoPorCarta = new Map<string, { total: number; graduadas: number; apalabradas: number }>(
      saldos.map((r: any) => [
        String(r.card_id),
        { total: Number(r.quantity), graduadas: Number(r.graduadas), apalabradas: Number(r.apalabradas) },
      ]),
    );
    let bloqueadasEnVitrina = false;
    let bloqueadasEnBazar = false;
    for (const [cid, qty] of Object.entries(offCount)) {
      const s = saldoPorCarta.get(cid) ?? { total: 0, graduadas: 0, apalabradas: 0 };
      if (s.total - s.graduadas - s.apalabradas < qty) {
        // No tenerlas, tenerlas graduadas y tenerlas anunciadas son tres cosas
        // distintas y se dicen distintas. Faltar de verdad manda: es el
        // problema más gordo, y el que el jugador no puede resolver quitando
        // nada de la oferta.
        if (s.total < qty) return { error: "No posees todas las cartas ofrecidas" };
        if (s.total - s.graduadas < qty) bloqueadasEnVitrina = true;
        else bloqueadasEnBazar = true;
      }
    }
    if (bloqueadasEnVitrina) {
      return { error: "Las copias graduadas no se intercambian: están en la vitrina" };
    }
    if (bloqueadasEnBazar) {
      return { error: "Esa copia está anunciada en el bazar: retira el anuncio para poder intercambiarla" };
    }

    /* TOPE DE OFERTAS PENDIENTES HACIA EL MISMO AMIGO, y dentro del INSERT.
     *
     * No había ninguno: un amigo podía dejar miles de ofertas 'pending', y cada
     * carga de la bandeja del otro las lee todas e hidrata todas sus cartas
     * (`getIncomingTradeOffers` no lleva LIMIT). Es el mismo daño que la fila
     * corrupta —dejar al otro sin bandeja usable— sólo que por volumen.
     *
     * Va por PAR (emisor, receptor) y no por emisor: el estorbo lo sufre un
     * destinatario concreto, y un tope global castigaría a quien trapichea
     * mucho con muchos amigos. Y va DENTRO del INSERT para no dejar una ventana
     * entre contar e insertar; no pretende ser un tope exacto —dos peticiones a
     * la vez pueden dejar 21— sino cortar el goteo masivo, y para eso sobra.
     *
     * LA AMISTAD TAMBIÉN VA DENTRO DEL INSERT. El SELECT del principio es sólo
     * el aviso temprano: entre él y esta sentencia cabía que el otro quitara al
     * amigo o le bloqueara (sus sentencias cancelan las ofertas pendientes, y
     * ésta aún no existía), y la oferta nacía 'pending' entre dos que ya no
     * eran amigos, con su mensaje en la bandeja de quien acababa de cortar. Con
     * el EXISTS aquí, quien llega después del corte no inserta. Lo que queda es
     * el solape exacto de las dos sentencias —ninguna ve lo que la otra aún no
     * ha confirmado—, y eso lo tapan las lecturas: `getIncomingTradeOffers` y
     * `getSocialPendientes` sólo enseñan ofertas entre amigos.
     */
    const { rowCount } = await sql.query(
      `INSERT INTO trade_offers (sender_id, receiver_id, offered_ids, requested_ids, status, message)
       SELECT $1::text, $2::text, $3::jsonb, $4::jsonb, 'pending', $5::text
        WHERE EXISTS (
                SELECT 1 FROM friendships f
                 WHERE f.status = 'accepted'
                   AND ((f.user_id = $1::text AND f.friend_id = $2::text)
                     OR (f.user_id = $2::text AND f.friend_id = $1::text)))
          AND (SELECT count(*) FROM trade_offers
                WHERE sender_id = $1::text AND receiver_id = $2::text AND status = 'pending') < $6::int`,
      [
        userId,
        receiverId,
        JSON.stringify(offeredIds),
        JSON.stringify(requestedIds),
        texto || null,
        MAX_OFERTAS_PENDIENTES,
      ],
    );
    if (!rowCount) {
      // No se insertó: o ya no son amigos, o está el tope. Son dos avisos
      // distintos y sólo el segundo se arregla cancelando ofertas.
      const { rows: siguen } = await sql.query(
        `SELECT 1 FROM friendships f
          WHERE f.status = 'accepted'
            AND ((f.user_id = $1::text AND f.friend_id = $2::text)
              OR (f.user_id = $2::text AND f.friend_id = $1::text))`,
        [userId, receiverId],
      );
      if (siguen.length === 0) return { error: "Solo puedes intercambiar con amigos" };
      return { error: `Ya tienes ${MAX_OFERTAS_PENDIENTES} ofertas pendientes con ese entrenador` };
    }
    revalidatePath("/friends");
    return { success: true };
  } catch (e) {
    console.error("createTradeOffer error:", e);
    return { error: "Error al crear oferta" };
  }
}

export async function getIncomingTradeOffers() {
  const { userId } = await auth();
  if (!userId) return [];
  try {
    // SÓLO LAS DE QUIEN SIGUE SIENDO AMIGO. Quitar a un amigo o bloquearle
    // cancela las ofertas pendientes entre los dos, pero una oferta que se
    // estaba creando en ese mismo instante puede escapar a esa cancelación (ver
    // `createTradeOffer`), y de antes de que existiera quedan ofertas vivas de
    // ex amigos. Ninguna se puede aceptar —`acceptTradeOffer` exige la
    // amistad—, así que enseñarla era entregar el mensaje de alguien a quien
    // se acaba de bloquear. La fila no se toca: su emisor la sigue viendo en
    // «Enviadas» y la puede cancelar. Es el mismo filtro que lleva la insignia
    // (`getSocialPendientes`): la bandeja y su contador no pueden discrepar.
    const { rows } = await sql`
      SELECT t.id, t.sender_id, COALESCE(u.username, 'Entrenador') AS sender_name,
             t.offered_ids, t.requested_ids, t.message, t.created_at
      FROM trade_offers t LEFT JOIN users u ON u.id = t.sender_id
      WHERE t.receiver_id = ${userId} AND t.status = 'pending'
        AND EXISTS (
              SELECT 1 FROM friendships f
               WHERE f.status = 'accepted'
                 AND ((f.user_id = t.sender_id AND f.friend_id = t.receiver_id)
                   OR (f.user_id = t.receiver_id AND f.friend_id = t.sender_id)))
      ORDER BY t.created_at DESC
    `;
    // Una pasada de parseo por fila, no cuatro: las listas ya parseadas son las
    // mismas que se hidratan y las mismas que se devuelven.
    const filas = rows.map((r: any) => ({ fila: r, ...idsDeOferta(r) }));
    const allIds = filas.flatMap((f) => [...f.offered, ...f.requested]);
    const map = await hydrateCardsByIds(allIds);
    return filas.map(({ fila: r, offered, requested }) => ({
      id: r.id, senderId: r.sender_id, senderName: r.sender_name, message: r.message, createdAt: r.created_at,
      offered: offered.map((id) => map[id]).filter(Boolean),
      requested: requested.map((id) => map[id]).filter(Boolean),
    }));
  } catch (e) {
    console.error("getIncomingTradeOffers error:", e);
    return [];
  }
}

export async function getOutgoingTradeOffers() {
  const { userId } = await auth();
  if (!userId) return [];
  try {
    const { rows } = await sql`
      SELECT t.id, t.receiver_id, COALESCE(u.username, 'Entrenador') AS receiver_name,
             t.offered_ids, t.requested_ids, t.status, t.created_at
      FROM trade_offers t LEFT JOIN users u ON u.id = t.receiver_id
      WHERE t.sender_id = ${userId} AND t.status = 'pending'
      ORDER BY t.created_at DESC
    `;
    // Igual que en la bandeja de entrada: fila a fila, y una sola vez.
    const filas = rows.map((r: any) => ({ fila: r, ...idsDeOferta(r) }));
    const allIds = filas.flatMap((f) => [...f.offered, ...f.requested]);
    const map = await hydrateCardsByIds(allIds);
    return filas.map(({ fila: r, offered, requested }) => ({
      id: r.id, receiverId: r.receiver_id, receiverName: r.receiver_name, status: r.status, createdAt: r.created_at,
      offered: offered.map((id) => map[id]).filter(Boolean),
      requested: requested.map((id) => map[id]).filter(Boolean),
    }));
  } catch (e) {
    console.error("getOutgoingTradeOffers error:", e);
    return [];
  }
}

export async function getTradeHistory() {
  const { userId } = await auth();
  if (!userId) return [];
  try {
    const { rows } = await sql`
      SELECT t.id, t.sender_id, t.receiver_id, t.status, t.updated_at,
             su.username AS sender_name, ru.username AS receiver_name,
             t.offered_ids, t.requested_ids
      FROM trade_offers t
      LEFT JOIN users su ON su.id = t.sender_id
      LEFT JOIN users ru ON ru.id = t.receiver_id
      WHERE (t.sender_id = ${userId} OR t.receiver_id = ${userId})
        AND t.status IN ('accepted','declined','cancelled')
      ORDER BY t.updated_at DESC LIMIT 30
    `;
    return rows.map((r: any) => ({
      id: r.id,
      status: r.status,
      iAmSender: r.sender_id === userId,
      otherName: r.sender_id === userId ? (r.receiver_name || "Entrenador") : (r.sender_name || "Entrenador"),
      offeredCount: parseIds(r.offered_ids).length,
      requestedCount: parseIds(r.requested_ids).length,
      updatedAt: r.updated_at,
    }));
  } catch (e) {
    console.error("getTradeHistory error:", e);
    return [];
  }
}

/**
 * Acepta una oferta y mueve las cartas. TODO el trasiego va en UNA sentencia,
 * porque las tres maneras de romper la versión anterior nacían de repartirlo
 * en muchas:
 *
 *  1) DUPLICABA CARTAS. El `status` pasaba a 'accepted' al FINAL y sin bloquear
 *     la fila, así que dos aceptaciones simultáneas del mismo id pasaban las
 *     dos el filtro 'pending' y transferían las dos. El receptor cobraba doble
 *     y el emisor quedaba en negativo: cartas de la nada, y monedas al
 *     venderlas. Ahora la oferta se bloquea (`FOR UPDATE`) al principio de la
 *     misma sentencia que mueve las cartas; la segunda espera al candado y,
 *     cuando se suelta, reevalúa `status = 'pending'` sobre la fila ya cerrada,
 *     se va de vacío y no mueve nada.
 *
 *  2) BORRABA FILAS DE OTRAS CUENTAS. El `DELETE FROM user_collection WHERE
 *     quantity <= 0` no llevaba filtro de usuario ni de carta: barría la tabla
 *     entera en cada intercambio. Ahora no se borra NADA: aceptar ya no ejecuta
 *     ningún DELETE. Las filas que quedan a cero se quedan, que para quien las
 *     lee es lo mismo que no estar (la nota de más abajo lo detalla, y mide por
 *     qué barrerlas costaba intercambios legítimos).
 *
 *  3) COMPROBABA Y DESCONTABA POR SEPARADO. Entre el SELECT que verificaba la
 *     posesión y el UPDATE que restaba cabía una venta del emisor: la fila
 *     acababa en negativo y el receptor cobraba igual. Ahora las filas
 *     implicadas se bloquean ANTES de mirarlas (`saldo`) y siguen bloqueadas
 *     hasta el final de la sentencia, así que lo que se comprueba es
 *     exactamente lo que se resta.
 *
 * Del cliente sólo llega `tradeId`: el receptor sale de `auth()` y las cartas
 * de cada lado salen de la propia fila de la oferta, nunca del payload.
 */
export async function acceptTradeOffer(tradeId: number) {
  const { userId } = await auth();
  if (!userId) return { error: "No autorizado" };
  // `tradeId` viaja desde el cliente: se normaliza antes de tocar la BD para
  // que un valor raro no llegue como texto a una columna entera.
  const id = Number(tradeId);
  if (!Number.isInteger(id)) return { error: "Oferta no válida" };

  try {
    const { rows } = await sql.query(
      `WITH oferta AS MATERIALIZED (
         -- El cerrojo del intercambio: el candado de fila se toma AQUÍ, en la
         -- misma sentencia que mueve las cartas, y no se suelta hasta el final.
         SELECT id, sender_id, receiver_id, offered_ids, requested_ids
         FROM trade_offers
         WHERE id = $1::int AND receiver_id = $2 AND status = 'pending'
         FOR UPDATE
       ),
       amistad AS MATERIALIZED (
         -- La amistad se exige TAMBIÉN al aceptar, no sólo al crear la oferta.
         -- Sin esto, una oferta de un ex amigo (o de alguien bloqueado) seguía
         -- siendo aceptable semanas después de quitarle. Es una lectura sin
         -- candado: quien corta la amistad cancela además la oferta en su misma
         -- sentencia y choca con el cerrojo de arriba, así que el orden entre
         -- los dos lo decide la fila de la oferta, no ésta.
         SELECT 1
         FROM oferta o
         JOIN friendships f
           ON f.status = 'accepted'
          AND ((f.user_id = o.sender_id AND f.friend_id = o.receiver_id)
            OR (f.user_id = o.receiver_id AND f.friend_id = o.sender_id))
       ),
       mov AS MATERIALIZED (
         -- Saldo NETO por (usuario, carta), no cuatro listas sueltas: una carta
         -- que aparezca en los dos lados tocaría la misma fila dos veces dentro
         -- de la misma sentencia (resultado indefinido en Postgres) y haría
         -- reventar el ON CONFLICT de abajo por repetir destino. Neteando, cada
         -- par sale una sola vez y con un único signo. Y como cada carta entra
         -- en las cuatro ramas con signos opuestos, la suma de deltas de una
         -- carta es SIEMPRE cero: la sentencia mueve cartas, no las crea.
         SELECT t.user_id, t.card_id, SUM(t.delta)::int AS delta
         FROM (
           SELECT o.sender_id AS user_id, e.card_id, -1 AS delta
             FROM oferta o, jsonb_array_elements_text(o.offered_ids::jsonb) AS e(card_id)
           UNION ALL
           SELECT o.receiver_id, e.card_id, 1
             FROM oferta o, jsonb_array_elements_text(o.offered_ids::jsonb) AS e(card_id)
           UNION ALL
           SELECT o.receiver_id, e.card_id, -1
             FROM oferta o, jsonb_array_elements_text(o.requested_ids::jsonb) AS e(card_id)
           UNION ALL
           SELECT o.sender_id, e.card_id, 1
             FROM oferta o, jsonb_array_elements_text(o.requested_ids::jsonb) AS e(card_id)
         ) t
         GROUP BY t.user_id, t.card_id
       ),
       saldo AS MATERIALIZED (
         -- Se bloquean TODAS las filas implicadas (no sólo las que se restan) y
         -- por orden de clave: dos intercambios que se crucen piden los candados
         -- en la misma secuencia y no se abrazan. Con FOR UPDATE, «quantity» es
         -- el valor ACTUAL —Postgres reevalúa la fila si otra transacción la
         -- tocó—, no el de la instantánea: por eso comprobar aquí ya es
         -- comprobar de verdad.
         --
         -- LAS COPIAS GRADUADAS SE DESCUENTAN AQUÍ, en el saldo, y no en un
         -- guard aparte: así «deuda» las ve sin tener que repetir la resta, y
         -- el orden de los candados —que es un invariante global de este
         -- repositorio— no cambia ni una coma. El LEFT JOIN no bloquea nada:
         -- graded_cards no participa del FOR UPDATE, sólo aporta el contador.
         --
         -- Ojo: esto NO introduce la copia reservada en el intercambio. Una
         -- carta única sin graduar sigue siendo intercambiable, que es la
         -- decisión documentada arriba. Lo único que se protege es la copia que
         -- tiene una fila de graded_cards apuntándola.
         --
         -- Y LO QUE EL BAZAR TIENE APALABRADO, que se descuenta igual y en el
         -- mismo sitio. El agujero: el bazar no aparta la carta al anunciarla
         -- (el anuncio es una fila, quantity no se mueve), así que con 2 copias
         -- y una anunciada se podía dar la otra en un trueque. El anuncio
         -- seguía abierto, la compra exige que al vendedor le quede una copia
         -- libre además de la que vende, y ya no la había: todo comprador
         -- recibía un «no disponible» y el anuncio no caducaba nunca. Mientras
         -- la carta tenga algún anuncio abierto no se pueden dar ni las copias
         -- de sus anuncios sueltos ni esa copia libre: «z.n» es
         -- (anuncios sueltos + 1), y no hay fila —no se resta nada— si la carta
         -- no tiene ningún anuncio. Para darla hay que retirar antes el anuncio.
         -- Tampoco bloquea nada: bazar_listings no participa del FOR UPDATE.
         -- Es la misma cuenta que hacen las ventas y la graduación en
         -- app/action.ts (ver «copiasComprometidas»).
         SELECT uc.user_id, uc.card_id,
                uc.quantity - COALESCE(g.n, 0) - COALESCE(z.n, 0) AS quantity
         FROM user_collection uc
         LEFT JOIN (
           SELECT user_id, card_id, count(*)::int AS n
           FROM graded_cards
           -- Solo las que siguen en la vitrina: una copia vendida conserva su
           -- fila para que su indice no se recicle, pero ya no ocupa copia.
           WHERE estado = 'activa'
             -- Y solo las de los pares de este trueque. Postgres no empuja el
             -- filtro de fuera dentro de un subselect agregado de un LEFT JOIN:
             -- sin esta linea cada aceptacion recorria y agrupaba la tabla
             -- ENTERA de graduadas con la oferta ya bloqueada, alargando justo
             -- la ventana de interbloqueo que se midio mas abajo. Con ella entra
             -- por idx_graded_cards_user_card. No cambia el orden de candados:
             -- graded_cards sigue sin participar del FOR UPDATE.
             AND (user_id, card_id) IN (SELECT m.user_id, m.card_id FROM mov m)
           GROUP BY user_id, card_id
         ) g ON g.user_id = uc.user_id AND g.card_id = uc.card_id
         LEFT JOIN (
           SELECT seller_id, card_id,
                  (count(*) FILTER (WHERE graded_id IS NULL) + 1)::int AS n
           FROM bazar_listings
           WHERE estado = 'activa'
             -- Mismo recorte que arriba, y por lo mismo: solo los pares de este
             -- trueque, para no agrupar el escaparate entero en cada aceptacion.
             AND (seller_id, card_id) IN (SELECT m.user_id, m.card_id FROM mov m)
           GROUP BY seller_id, card_id
         ) z ON z.seller_id = uc.user_id AND z.card_id = uc.card_id
         WHERE (uc.user_id, uc.card_id) IN (SELECT m.user_id, m.card_id FROM mov m)
         ORDER BY uc.user_id, uc.card_id
         FOR UPDATE OF uc
       ),
       deuda AS MATERIALIZED (
         -- Quién no puede pagar lo que le toca poner. Sin fila en «saldo» la
         -- carta no existe para ese usuario, que es lo mismo que no tenerla.
         SELECT m.user_id
         FROM mov m
         LEFT JOIN saldo s ON s.user_id = m.user_id AND s.card_id = m.card_id
         WHERE m.delta < 0 AND COALESCE(s.quantity, 0) < -m.delta
       ),
       via AS MATERIALIZED (
         -- Puerta única: o la oferta sigue viva y nadie queda en negativo, o no
         -- se toca nada. Las tres escrituras cuelgan de este EXISTS, así que el
         -- intercambio es entero o no es.
         SELECT 1
         WHERE EXISTS (SELECT 1 FROM oferta) AND NOT EXISTS (SELECT 1 FROM deuda)
           AND EXISTS (SELECT 1 FROM amistad)
       ),
       resta AS (
         UPDATE user_collection uc
         SET quantity = uc.quantity + m.delta
         FROM mov m
         WHERE uc.user_id = m.user_id AND uc.card_id = m.card_id
           AND m.delta < 0
           AND EXISTS (SELECT 1 FROM via)
         RETURNING uc.user_id AS user_id, uc.card_id AS card_id
       ),
       suma AS (
         INSERT INTO user_collection (user_id, card_id, quantity)
         SELECT m.user_id, m.card_id, m.delta
         FROM mov m
         WHERE m.delta > 0 AND EXISTS (SELECT 1 FROM via)
         ON CONFLICT (user_id, card_id)
         DO UPDATE SET quantity = user_collection.quantity + EXCLUDED.quantity
         RETURNING user_id
       ),
       cierre AS (
         UPDATE trade_offers t
         SET status = 'accepted', updated_at = NOW()
         WHERE t.id = $1::int AND t.receiver_id = $2 AND t.status = 'pending'
           AND EXISTS (SELECT 1 FROM via)
         RETURNING t.id
       )
       -- Sin FROM: la sentencia devuelve siempre exactamente una fila, con el
       -- diagnóstico de por qué no se cerró cuando no se cerró.
       SELECT (SELECT count(*)::int FROM cierre)                  AS cerrada,
              (SELECT count(*)::int FROM resta)                   AS restadas,
              (SELECT count(*)::int FROM suma)                    AS sumadas,
              (SELECT count(*)::int FROM mov WHERE delta < 0)     AS esperadas,
              EXISTS (SELECT 1 FROM oferta)                       AS viva,
              EXISTS (SELECT 1 FROM amistad)                      AS amigos,
              EXISTS (SELECT 1 FROM deuda d
                        JOIN oferta o ON o.sender_id = d.user_id) AS falta_emisor,
              EXISTS (SELECT 1 FROM deuda WHERE user_id = $2)     AS falta_receptor`,
      [id, userId],
    );

    const r = (rows[0] || {}) as Partial<{
      cerrada: number;
      restadas: number;
      sumadas: number;
      esperadas: number;
      viva: boolean;
      amigos: boolean;
      falta_emisor: boolean;
      falta_receptor: boolean;
    }>;

    if (Number(r.cerrada) === 1) {
      const restadas = Number(r.restadas ?? 0);
      const esperadas = Number(r.esperadas ?? 0);
      if (restadas !== esperadas) {
        // No debería pasar: el guard `via` se evalúa sobre filas ya bloqueadas.
        // Si pasa, queda anotado para poder cuadrar la colección a mano.
        console.error(
          `acceptTradeOffer: descuento parcial trade=${id} ${restadas}/${esperadas}`,
        );
      }

      // NO se barren las filas que quedan a cero. Medido con Postgres real (320
      // aceptaciones concurrentes): el DELETE de limpieza que había aquí hacía
      // fallar el 11% de los intercambios legítimos con un interbloqueo.
      //
      // POR QUÉ: la sentencia de arriba pide los candados ORDENADOS (el ORDER BY
      // de `saldo`; el plan confirma que LockRows va encima del Sort), pero la
      // limpieza es OTRA sentencia y los pedía en el orden en que el planificador
      // le devolvía las filas. Se abrazaban: la limpieza de un trueque retenía una
      // fila que la aceptación de otro esperaba, y al revés. Ordenar el array de
      // pares NO lo arregla —probado: 36 interbloqueos frente a 35—, porque el
      // orden de los candados lo decide el plan del DELETE, no el de los
      // parámetros. Y la víctima que Postgres mataba era la mitad de las veces la
      // sentencia grande: un intercambio legítimo perdido.
      //
      // Y POR QUÉ SE PUEDE NO BARRER: una fila a 0 es indistinguible de una fila
      // ausente. Todas las lecturas de `user_collection` filtran `quantity > 0`, y
      // las escrituras que no lo hacen van guardadas por `quantity > 1` (venta) o
      // `>= cantidad + 1` (mercado), así que una fila a 0 no se vende ni se
      // entrega; el INSERT ... ON CONFLICT de `suma` la reutiliza sumando sobre 0,
      // igual que si la insertara. Encima conservarla conserva su `is_favorite`
      // para cuando la carta vuelva. Sin esta sentencia, aceptar un intercambio
      // deja de ejecutar ningún DELETE: el movimiento de bienes es UN solo comando
      // y nada más toca filas de `user_collection`.
      revalidatePath("/friends");
      revalidatePath("/collection");
      return { success: true };
    }

    // No se cerró: la propia sentencia dice por qué, sin volver a leer nada.
    if (!r.viva) return { error: "La oferta ya no está disponible" };
    if (!r.amigos) {
      // Una oferta entre dos que ya no son amigos no se va a poder aceptar
      // nunca, así que se cancela aquí en vez de dejarla en la bandeja diciendo
      // lo mismo en cada intento. Son las que quedaron vivas de antes de que
      // quitar a un amigo cancelase sus ofertas. El NOT EXISTS repite la
      // comprobación para no cancelar la de dos que acaban de volver a serlo.
      await sql.query(
        `UPDATE trade_offers t SET status = 'cancelled', updated_at = NOW()
         WHERE t.id = $1::int AND t.receiver_id = $2 AND t.status = 'pending'
           AND NOT EXISTS (
             SELECT 1 FROM friendships f
              WHERE f.status = 'accepted'
                AND ((f.user_id = t.sender_id AND f.friend_id = t.receiver_id)
                  OR (f.user_id = t.receiver_id AND f.friend_id = t.sender_id)))`,
        [id, userId],
      );
      revalidatePath("/friends");
      return { error: "Ya no sois amigos: la oferta se ha cancelado." };
    }
    if (r.falta_emisor) {
      await sql.query(
        `UPDATE trade_offers SET status = 'cancelled', updated_at = NOW()
         WHERE id = $1::int AND receiver_id = $2 AND status = 'pending'`,
        [id, userId],
      );
      revalidatePath("/friends");
      // "Ya no PUEDE entregar" y no "ya no tiene": desde que `saldo` descuenta
      // las graduadas, este camino también lo pisa quien graduó sus copias
      // después de mandar la oferta, y decirle al otro que no las tiene sería
      // falso. Crear la oferta ya no se puede con copias graduadas, así que lo
      // que queda aquí es lo que cambió DESPUÉS: venta, otro trueque o vitrina.
      return { error: "El emisor ya no puede entregar esas cartas. Oferta cancelada." };
    }
    // Las dos causas por las que una copia que se tiene no se puede dar: está
    // en la vitrina o está apalabrada en el bazar. Antes sólo nombraba la
    // primera, y a quien tenía la copia anunciada le hablaba de graduadas.
    if (r.falta_receptor) {
      return { error: "No tienes disponibles todas las cartas pedidas: las graduadas y las anunciadas en el bazar no cuentan" };
    }
    return { error: "Error al procesar el intercambio" };
  } catch (e) {
    // Aquí caen también los interbloqueos que Postgres corta: no se ha movido
    // nada (la sentencia es una), así que reintentar es seguro.
    console.error("acceptTradeOffer error:", e);
    return { error: "Error al procesar el intercambio" };
  }
}

/*
 * Rechazar y cancelar DICEN LA VERDAD SOBRE SI HAN HECHO ALGO.
 *
 * Las dos devolvían `{ success: true }` pasara lo que pasara: el UPDATE lleva
 * filtro de dueño y de estado, así que con una oferta ajena, ya resuelta o
 * inexistente no tocaba ninguna fila y la pantalla cantaba "Oferta rechazada"
 * igual. `rowCount` es el número de filas que de verdad han cambiado, y es lo
 * único que hace falta para no mentir. La forma de retorno no cambia —sigue
 * siendo `{ success }` o `{ error }`, que es lo que espera app/friends/page.tsx
 * para elegir el aviso— y el texto del error es el mismo que ya usa
 * `acceptTradeOffer` para este caso.
 *
 * EL ID SE VALIDA CON `idDeFila`, y la sentencia va en un try. Con
 * `Number(tradeId)` e `isInteger` a secas pasaba 2147483648: es un entero de
 * JS, pero no cabe en la columna, Postgres respondía 22003 y, sin try/catch,
 * la acción LANZABA en vez de contestar (la pantalla lo pintaba como un fallo
 * de conexión). `idDeFila` exige además que sea un número de verdad: `Number`
 * convertía "1", `true` y `[1]` en la oferta 1.
 */
export async function declineTradeOffer(tradeId: number) {
  const { userId } = await auth();
  if (!userId) return { error: "No autorizado" };
  const id = idDeFila(tradeId);
  if (id === null) return { error: "Oferta no válida" };
  try {
    const { rowCount } = await sql`UPDATE trade_offers SET status = 'declined', updated_at = NOW() WHERE id = ${id} AND receiver_id = ${userId} AND status = 'pending'`;
    if (!rowCount) return { error: "La oferta ya no está disponible" };
    revalidatePath("/friends");
    return { success: true };
  } catch (e) {
    console.error("declineTradeOffer error:", e);
    return { error: "No se pudo rechazar la oferta" };
  }
}

export async function cancelTradeOffer(tradeId: number) {
  const { userId } = await auth();
  if (!userId) return { error: "No autorizado" };
  const id = idDeFila(tradeId);
  if (id === null) return { error: "Oferta no válida" };
  try {
    const { rowCount } = await sql`UPDATE trade_offers SET status = 'cancelled', updated_at = NOW() WHERE id = ${id} AND sender_id = ${userId} AND status = 'pending'`;
    if (!rowCount) return { error: "La oferta ya no está disponible" };
    revalidatePath("/friends");
    return { success: true };
  } catch (e) {
    console.error("cancelTradeOffer error:", e);
    return { error: "No se pudo cancelar la oferta" };
  }
}

export async function getTradableCollection(targetId: string) {
  const { userId } = await auth();
  if (!userId) return [];
  // `targetId` llega de una petición HTTP: lo que no sea un id plausible no
  // toca la base.
  if (typeof targetId !== "string" || targetId.length === 0 || targetId.length > MAX_ID_USUARIO) return [];
  try {
    // DENTRO del try, como el resto: un id con un carácter NUL o un surrogate
    // suelto hace lanzar a Postgres (22021 / 22P05) en esta misma consulta, y
    // fuera del try la acción lanzaba en vez de devolver la lista vacía.
    if (targetId !== userId) {
      const { rows: fr } = await sql`
        SELECT 1 FROM friendships WHERE status = 'accepted'
        AND ((user_id = ${userId} AND friend_id = ${targetId}) OR (user_id = ${targetId} AND friend_id = ${userId}))
      `;
      if (fr.length === 0) return [];
    }
    // Ordenado por RANGO de rareza, no por la cadena. `ORDER BY c.rarity DESC`
    // comparaba texto, así que "Uncommon" salía por delante de "Special
    // Illustration Rare" y el selector de intercambio parecía desordenado.
    // Aquí no hay una segunda ordenación en el cliente que lo disimule.
    // `quantity` AQUÍ ES LO ENTREGABLE, no lo que hay en el álbum: las copias
    // graduadas activas van descontadas y las cartas que se quedan a cero no
    // salen. El selector (components/social/TradeBuilder.tsx) usa este número
    // como tope de lo que se puede elegir, así que descontarlo en el servidor
    // —que es quien sabe qué copias están en la vitrina— evita que el cliente
    // tenga que repetir la cuenta y que ofrezca cartas que `acceptTradeOffer`
    // va a rechazar luego. Es la misma resta que hace el CTE `saldo`, ENTERA:
    // las graduadas y lo que el bazar tiene apalabrado (anuncios sueltos
    // abiertos más uno, sólo si la carta tiene algún anuncio). Mientras esto
    // restaba sólo las graduadas, el selector ofrecía la copia anunciada y la
    // oferta nacía muerta.
    const { rows } = await sql`
      SELECT c.id, c.name, c.rarity, c.images, c.set_id,
             (uc.quantity - COALESCE(g.n, 0) - COALESCE(z.n, 0)) AS quantity
      FROM user_collection uc
      JOIN cards c ON uc.card_id = c.id
      LEFT JOIN (
        SELECT card_id, count(*)::int AS n
          FROM graded_cards
         WHERE user_id = ${targetId} AND estado = 'activa'
         GROUP BY card_id
      ) g ON g.card_id = uc.card_id
      LEFT JOIN (
        SELECT card_id,
               (count(*) FILTER (WHERE graded_id IS NULL) + 1)::int AS n
          FROM bazar_listings
         WHERE seller_id = ${targetId} AND estado = 'activa'
         GROUP BY card_id
      ) z ON z.card_id = uc.card_id
      WHERE uc.user_id = ${targetId}
        AND uc.quantity - COALESCE(g.n, 0) - COALESCE(z.n, 0) > 0
    `;
    // `rangoDe` y no `RARITY_RANK[r] || 0`: la rareza llega de una API que no
    // controlamos, y con una llamada "constructor" el índice devolvía una
    // función heredada de Object.prototype, la resta daba NaN y el orden del
    // selector quedaba indefinido.
    const rangoDe = (rareza: unknown): number => {
      const r = String(rareza ?? "");
      return Object.prototype.hasOwnProperty.call(RARITY_RANK, r) ? RARITY_RANK[r] : 0;
    };
    rows.sort((a: any, b: any) => {
      return rangoDe(b.rarity) - rangoDe(a.rarity) || String(a.name).localeCompare(String(b.name));
    });
    return [...(await traducirCartasEs(
      rows.map((r: any) => ({
        id: r.id, name: r.name, rarity: r.rarity, quantity: r.quantity, set_id: r.set_id,
        images: typeof r.images === "string" ? JSON.parse(r.images) : r.images,
      })),
      await idiomaActual(),
    ))];
  } catch (e) {
    console.error("getTradableCollection error:", e);
    return [];
  }
}
