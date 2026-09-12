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

export async function searchUsersByName(query: string) {
  const { userId } = await auth();
  // Exige sesión: es un directorio de personas, no un dato público. Sin esta
  // guarda el filtro efectivo era `id != ""`, o sea ninguno.
  if (!userId) return [];
  if (!query || query.trim().length < 2) return [];
  try {
    // Se escapan los comodines de LIKE (%, _ y la propia barra de escape), igual
    // que hace searchCardsInDB en app/action.ts. Sin esto, buscar "%" devolvía
    // ocho usuarios cualesquiera del sistema.
    const safe = query.toLowerCase().replace(/[\\%_]/g, (m) => `\\${m}`);
    const term = `%${safe}%`;
    const { rows } = await sql`
      SELECT id, COALESCE(username, 'Entrenador') AS username
      FROM users
      WHERE LOWER(username) LIKE ${term} AND id != ${userId || ""}
      LIMIT 8
    `;
    const ids = rows.map((r: any) => r.id);
    const rel: Record<string, string> = {};
    if (userId && ids.length > 0) {
      const { rows: fr } = await sql.query(
        `SELECT user_id, friend_id, status FROM friendships
         WHERE (user_id = $1 AND friend_id = ANY($2::text[]))
            OR (friend_id = $1 AND user_id = ANY($2::text[]))`,
        [userId, ids],
      );
      fr.forEach((f: any) => {
        const other = f.user_id === userId ? f.friend_id : f.user_id;
        rel[other] = f.status;
      });
    }
    return rows.map((r: any) => ({ id: r.id, username: r.username, relation: rel[r.id] || null }));
  } catch (e) {
    console.error("searchUsersByName error:", e);
    return [];
  }
}

export async function addFriend(identifier: string) {
  const { userId } = await auth();
  if (!userId) return { error: "No autorizado" };
  const raw = identifier.trim();
  if (!raw) return { error: "Indica un ID o nombre" };

  let targetId = raw;
  if (!raw.startsWith("user_")) {
    const { rows } = await sql`SELECT id FROM users WHERE LOWER(username) = ${raw.toLowerCase()} LIMIT 1`;
    if (rows.length === 0) return { error: "No se encontró ese entrenador" };
    targetId = rows[0].id;
  }
  if (targetId === userId) return { error: "No puedes añadirte a ti mismo" };

  try {
    // El destinatario tiene que EXISTIR. Por el camino del nombre ya está
    // comprobado (sale de un SELECT), pero por el del id —cualquier cadena que
    // empiece por "user_"— se insertaba a ciegas: quedaba una fila colgante que
    // luego aparecía en la lista como un "Entrenador" fantasma imposible de
    // quitar. Esta comprobación estaba en la versión duplicada de app/action.ts
    // y no en ésta, que es la que usa la aplicación.
    const { rows: destino } = await sql`SELECT 1 FROM users WHERE id = ${targetId}`;
    if (destino.length === 0) return { error: "Ese entrenador no existe." };

    const { rows: existing } = await sql`
      SELECT status FROM friendships
      WHERE (user_id = ${userId} AND friend_id = ${targetId})
         OR (user_id = ${targetId} AND friend_id = ${userId})
    `;
    if (existing.length > 0) {
      const st = existing[0].status;
      return { error: st === "accepted" ? "Ya sois amigos" : "Ya hay una petición pendiente" };
    }
    await sql`INSERT INTO friendships (user_id, friend_id, status) VALUES (${userId}, ${targetId}, 'pending')`;
    return { success: true };
  } catch (e) {
    console.error("addFriend error:", e);
    return { error: "Error al enviar petición" };
  }
}

export async function acceptFriend(friendshipId: number) {
  const { userId } = await auth();
  if (!userId) return { error: "No autorizado" };
  await sql`UPDATE friendships SET status = 'accepted' WHERE id = ${friendshipId} AND friend_id = ${userId}`;
  revalidatePath("/friends");
  return { success: true };
}

export async function removeFriendship(friendshipId: number) {
  const { userId } = await auth();
  if (!userId) return { error: "No autorizado" };
  await sql`DELETE FROM friendships WHERE id = ${friendshipId} AND (user_id = ${userId} OR friend_id = ${userId})`;
  revalidatePath("/friends");
  return { success: true };
}

export async function getSocialOverview() {
  const { userId } = await auth();
  if (!userId) return { friends: [], requests: [], incomingTrades: 0 };
  try {
    const { rows: accepted } = await sql`
      SELECT
        f.id AS friendship_id,
        CASE WHEN f.user_id = ${userId} THEN f.friend_id ELSE f.user_id END AS friend_id,
        COALESCE(u.username, 'Entrenador') AS friend_name
      FROM friendships f
      LEFT JOIN users u ON u.id = (CASE WHEN f.user_id = ${userId} THEN f.friend_id ELSE f.user_id END)
      WHERE (f.user_id = ${userId} OR f.friend_id = ${userId}) AND f.status = 'accepted'
    `;
    const { rows: requests } = await sql`
      SELECT f.id, f.user_id AS requester_id, COALESCE(u.username, 'Entrenador') AS requester_name
      FROM friendships f
      LEFT JOIN users u ON u.id = f.user_id
      WHERE f.friend_id = ${userId} AND f.status = 'pending'
    `;

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

    const { rows: tc } = await sql`SELECT count(*)::int AS c FROM trade_offers WHERE receiver_id = ${userId} AND status = 'pending'`;
    return { friends: all, requests, incomingTrades: tc[0]?.c || 0 };
  } catch (e) {
    console.error("getSocialOverview error:", e);
    return { friends: [], requests: [], incomingTrades: 0 };
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
     */
    const offCount = countById(offeredIds);
    const { rows: saldos } = await sql.query(
      `SELECT uc.card_id,
              uc.quantity::int        AS quantity,
              COALESCE(g.n, 0)::int   AS graduadas
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
        WHERE uc.user_id = $1 AND uc.card_id = ANY($2::text[])`,
      [userId, Object.keys(offCount)],
    );
    const saldoPorCarta = new Map<string, { total: number; graduadas: number }>(
      saldos.map((r: any) => [String(r.card_id), { total: Number(r.quantity), graduadas: Number(r.graduadas) }]),
    );
    let bloqueadasEnVitrina = false;
    for (const [cid, qty] of Object.entries(offCount)) {
      const s = saldoPorCarta.get(cid) ?? { total: 0, graduadas: 0 };
      if (s.total - s.graduadas < qty) {
        // No tenerlas y tenerlas graduadas son dos cosas distintas y se dicen
        // distintas. Faltar de verdad manda: es el problema más gordo de los
        // dos, y el que el jugador no puede resolver quitando nada de la oferta.
        if (s.total < qty) return { error: "No posees todas las cartas ofrecidas" };
        bloqueadasEnVitrina = true;
      }
    }
    if (bloqueadasEnVitrina) {
      return { error: "Las copias graduadas no se intercambian: están en la vitrina" };
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
     */
    const { rowCount } = await sql.query(
      `INSERT INTO trade_offers (sender_id, receiver_id, offered_ids, requested_ids, status, message)
       SELECT $1::text, $2::text, $3::jsonb, $4::jsonb, 'pending', $5::text
        WHERE (SELECT count(*) FROM trade_offers
                WHERE sender_id = $1 AND receiver_id = $2 AND status = 'pending') < $6::int`,
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
    const { rows } = await sql`
      SELECT t.id, t.sender_id, COALESCE(u.username, 'Entrenador') AS sender_name,
             t.offered_ids, t.requested_ids, t.message, t.created_at
      FROM trade_offers t LEFT JOIN users u ON u.id = t.sender_id
      WHERE t.receiver_id = ${userId} AND t.status = 'pending'
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
         SELECT uc.user_id, uc.card_id, uc.quantity - COALESCE(g.n, 0) AS quantity
         FROM user_collection uc
         LEFT JOIN (
           SELECT user_id, card_id, count(*)::int AS n
           FROM graded_cards
           -- Solo las que siguen en la vitrina: una copia vendida conserva su
           -- fila para que su indice no se recicle, pero ya no ocupa copia.
           WHERE estado = 'activa'
           GROUP BY user_id, card_id
         ) g ON g.user_id = uc.user_id AND g.card_id = uc.card_id
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
    if (r.falta_receptor) return { error: "No tienes disponibles todas las cartas pedidas: las graduadas no cuentan" };
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
 * El `Number.isInteger` es el de `acceptTradeOffer`, por el mismo motivo: sin
 * él, un `tradeId` que no sea un número llega como texto a una columna entera y
 * Postgres lanza. Aquí, además, sin ningún try/catch que lo recoja.
 */
export async function declineTradeOffer(tradeId: number) {
  const { userId } = await auth();
  if (!userId) return { error: "No autorizado" };
  const id = Number(tradeId);
  if (!Number.isInteger(id)) return { error: "Oferta no válida" };
  const { rowCount } = await sql`UPDATE trade_offers SET status = 'declined', updated_at = NOW() WHERE id = ${id} AND receiver_id = ${userId} AND status = 'pending'`;
  if (!rowCount) return { error: "La oferta ya no está disponible" };
  revalidatePath("/friends");
  return { success: true };
}

export async function cancelTradeOffer(tradeId: number) {
  const { userId } = await auth();
  if (!userId) return { error: "No autorizado" };
  const id = Number(tradeId);
  if (!Number.isInteger(id)) return { error: "Oferta no válida" };
  const { rowCount } = await sql`UPDATE trade_offers SET status = 'cancelled', updated_at = NOW() WHERE id = ${id} AND sender_id = ${userId} AND status = 'pending'`;
  if (!rowCount) return { error: "La oferta ya no está disponible" };
  revalidatePath("/friends");
  return { success: true };
}

export async function getTradableCollection(targetId: string) {
  const { userId } = await auth();
  if (!userId) return [];
  if (targetId !== userId) {
    const { rows: fr } = await sql`
      SELECT 1 FROM friendships WHERE status = 'accepted'
      AND ((user_id = ${userId} AND friend_id = ${targetId}) OR (user_id = ${targetId} AND friend_id = ${userId}))
    `;
    if (fr.length === 0) return [];
  }
  try {
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
    // va a rechazar luego. Es la misma resta que hace el CTE `saldo`.
    const { rows } = await sql`
      SELECT c.id, c.name, c.rarity, c.images, c.set_id,
             (uc.quantity - COALESCE(g.n, 0)) AS quantity
      FROM user_collection uc
      JOIN cards c ON uc.card_id = c.id
      LEFT JOIN (
        SELECT card_id, count(*)::int AS n
          FROM graded_cards
         WHERE user_id = ${targetId} AND estado = 'activa'
         GROUP BY card_id
      ) g ON g.card_id = uc.card_id
      WHERE uc.user_id = ${targetId} AND uc.quantity - COALESCE(g.n, 0) > 0
    `;
    rows.sort((a: any, b: any) => {
      const ra = RARITY_RANK[a.rarity] || 0;
      const rb = RARITY_RANK[b.rarity] || 0;
      return rb - ra || String(a.name).localeCompare(String(b.name));
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
