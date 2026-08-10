"use server";

import { auth } from "@clerk/nextjs/server";
import { sql } from "@vercel/postgres";
import { revalidatePath } from "next/cache";
import { SELL_PRICES } from "../utils/constanst";

// ============================================================
// SOCIAL v2 — amigos + intercambios multi-carta
// ============================================================

function countById(ids: string[]): Record<string, number> {
  const m: Record<string, number> = {};
  for (const id of ids) m[id] = (m[id] || 0) + 1;
  return m;
}

function parseIds(v: any): string[] {
  if (!v) return [];
  return typeof v === "string" ? JSON.parse(v) : v;
}

async function hydrateCardsByIds(ids: string[]) {
  const unique = Array.from(new Set(ids));
  if (unique.length === 0) return {} as Record<string, any>;
  const { rows } = await sql.query(
    `SELECT id, name, rarity, images, set_id FROM cards WHERE id = ANY($1::text[])`,
    [unique],
  );
  const map: Record<string, any> = {};
  rows.forEach((r: any) => {
    map[r.id] = {
      id: r.id,
      name: r.name,
      rarity: r.rarity,
      images: typeof r.images === "string" ? JSON.parse(r.images) : r.images,
      set_id: r.set_id,
    };
  });
  return map;
}

export async function searchUsersByName(query: string) {
  const { userId } = await auth();
  if (!query || query.trim().length < 2) return [];
  try {
    const term = `%${query.toLowerCase()}%`;
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
    for (const fr of all) {
      const { rows: cards } = await sql`
        SELECT uc.quantity, c.rarity
        FROM user_collection uc JOIN cards c ON uc.card_id = c.id
        WHERE uc.user_id = ${fr.friend_id} AND uc.quantity > 0
      `;
      let value = 0, total = 0, unique = 0;
      cards.forEach((r: any) => {
        unique += 1; total += r.quantity;
        value += (SELL_PRICES[r.rarity as keyof typeof SELL_PRICES] || 10) * r.quantity;
      });
      fr.stats = { value, cards: total, unique };
    }
    all.sort((a, b) => b.stats.value - a.stats.value);

    const { rows: tc } = await sql`SELECT count(*)::int AS c FROM trade_offers WHERE receiver_id = ${userId} AND status = 'pending'`;
    return { friends: all, requests, incomingTrades: tc[0]?.c || 0 };
  } catch (e) {
    console.error("getSocialOverview error:", e);
    return { friends: [], requests: [], incomingTrades: 0 };
  }
}

export async function createTradeOffer(receiverId: string, offeredIds: string[], requestedIds: string[], message?: string) {
  const { userId } = await auth();
  if (!userId) return { error: "No autorizado" };
  if (receiverId === userId) return { error: "No puedes intercambiar contigo" };
  if (offeredIds.length === 0 || requestedIds.length === 0) return { error: "Selecciona cartas en ambos lados" };
  if (offeredIds.length > 12 || requestedIds.length > 12) return { error: "Máximo 12 cartas por lado" };

  try {
    const { rows: fr } = await sql`
      SELECT 1 FROM friendships
      WHERE status = 'accepted' AND ((user_id = ${userId} AND friend_id = ${receiverId}) OR (user_id = ${receiverId} AND friend_id = ${userId}))
    `;
    if (fr.length === 0) return { error: "Solo puedes intercambiar con amigos" };

    const offCount = countById(offeredIds);
    for (const [cid, qty] of Object.entries(offCount)) {
      const { rows } = await sql`SELECT quantity FROM user_collection WHERE user_id = ${userId} AND card_id = ${cid}`;
      if ((rows[0]?.quantity || 0) < qty) return { error: "No posees todas las cartas ofrecidas" };
    }

    await sql`
      INSERT INTO trade_offers (sender_id, receiver_id, offered_ids, requested_ids, status, message)
      VALUES (${userId}, ${receiverId}, ${JSON.stringify(offeredIds)}, ${JSON.stringify(requestedIds)}, 'pending', ${message || null})
    `;
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
    const allIds = rows.flatMap((r: any) => [...parseIds(r.offered_ids), ...parseIds(r.requested_ids)]);
    const map = await hydrateCardsByIds(allIds);
    return rows.map((r: any) => ({
      id: r.id, senderId: r.sender_id, senderName: r.sender_name, message: r.message, createdAt: r.created_at,
      offered: parseIds(r.offered_ids).map((id) => map[id]).filter(Boolean),
      requested: parseIds(r.requested_ids).map((id) => map[id]).filter(Boolean),
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
    const allIds = rows.flatMap((r: any) => [...parseIds(r.offered_ids), ...parseIds(r.requested_ids)]);
    const map = await hydrateCardsByIds(allIds);
    return rows.map((r: any) => ({
      id: r.id, receiverId: r.receiver_id, receiverName: r.receiver_name, status: r.status, createdAt: r.created_at,
      offered: parseIds(r.offered_ids).map((id) => map[id]).filter(Boolean),
      requested: parseIds(r.requested_ids).map((id) => map[id]).filter(Boolean),
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

export async function acceptTradeOffer(tradeId: number) {
  const { userId } = await auth();
  if (!userId) return { error: "No autorizado" };
  try {
    const { rows } = await sql`SELECT * FROM trade_offers WHERE id = ${tradeId} AND receiver_id = ${userId} AND status = 'pending'`;
    if (rows.length === 0) return { error: "La oferta ya no está disponible" };
    const t = rows[0];
    const offered = parseIds(t.offered_ids);
    const requested = parseIds(t.requested_ids);
    const offCount = countById(offered);
    const reqCount = countById(requested);

    for (const [cid, qty] of Object.entries(offCount)) {
      const { rows: r } = await sql`SELECT quantity FROM user_collection WHERE user_id = ${t.sender_id} AND card_id = ${cid}`;
      if ((r[0]?.quantity || 0) < qty) {
        await sql`UPDATE trade_offers SET status = 'cancelled', updated_at = NOW() WHERE id = ${tradeId}`;
        return { error: "El emisor ya no tiene esas cartas. Oferta cancelada." };
      }
    }
    for (const [cid, qty] of Object.entries(reqCount)) {
      const { rows: r } = await sql`SELECT quantity FROM user_collection WHERE user_id = ${userId} AND card_id = ${cid}`;
      if ((r[0]?.quantity || 0) < qty) return { error: "No tienes todas las cartas pedidas" };
    }

    for (const [cid, qty] of Object.entries(offCount)) {
      await sql`UPDATE user_collection SET quantity = quantity - ${qty} WHERE user_id = ${t.sender_id} AND card_id = ${cid}`;
      await sql`INSERT INTO user_collection (user_id, card_id, quantity) VALUES (${userId}, ${cid}, ${qty}) ON CONFLICT (user_id, card_id) DO UPDATE SET quantity = user_collection.quantity + ${qty}`;
    }
    for (const [cid, qty] of Object.entries(reqCount)) {
      await sql`UPDATE user_collection SET quantity = quantity - ${qty} WHERE user_id = ${userId} AND card_id = ${cid}`;
      await sql`INSERT INTO user_collection (user_id, card_id, quantity) VALUES (${t.sender_id}, ${cid}, ${qty}) ON CONFLICT (user_id, card_id) DO UPDATE SET quantity = user_collection.quantity + ${qty}`;
    }
    await sql`DELETE FROM user_collection WHERE quantity <= 0`;

    await sql`UPDATE trade_offers SET status = 'accepted', updated_at = NOW() WHERE id = ${tradeId}`;
    revalidatePath("/friends");
    revalidatePath("/collection");
    return { success: true };
  } catch (e) {
    console.error("acceptTradeOffer error:", e);
    return { error: "Error al procesar el intercambio" };
  }
}

export async function declineTradeOffer(tradeId: number) {
  const { userId } = await auth();
  if (!userId) return { error: "No autorizado" };
  await sql`UPDATE trade_offers SET status = 'declined', updated_at = NOW() WHERE id = ${tradeId} AND receiver_id = ${userId} AND status = 'pending'`;
  revalidatePath("/friends");
  return { success: true };
}

export async function cancelTradeOffer(tradeId: number) {
  const { userId } = await auth();
  if (!userId) return { error: "No autorizado" };
  await sql`UPDATE trade_offers SET status = 'cancelled', updated_at = NOW() WHERE id = ${tradeId} AND sender_id = ${userId} AND status = 'pending'`;
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
    const { rows } = await sql`
      SELECT c.id, c.name, c.rarity, c.images, c.set_id, uc.quantity
      FROM user_collection uc JOIN cards c ON uc.card_id = c.id
      WHERE uc.user_id = ${targetId} AND uc.quantity > 0
      ORDER BY c.rarity DESC, c.name ASC
    `;
    return rows.map((r: any) => ({
      id: r.id, name: r.name, rarity: r.rarity, quantity: r.quantity, set_id: r.set_id,
      images: typeof r.images === "string" ? JSON.parse(r.images) : r.images,
    }));
  } catch (e) {
    console.error("getTradableCollection error:", e);
    return [];
  }
}
