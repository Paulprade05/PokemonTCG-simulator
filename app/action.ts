  // src/app/action.ts
  'use server'

  import { auth, currentUser } from "@clerk/nextjs/server";
  import { sql } from '@vercel/postgres';
  import { revalidatePath } from 'next/cache';
  import { SELL_PRICES } from "../utils/constanst";
  // --- 1. GESTIÓN DE USUARIO Y MONEDAS ---

  export async function getUserData() {
    const { userId } = await auth();
    if (!userId) return null;

    try {
      const { rows } = await sql`SELECT * FROM users WHERE id = ${userId}`;
      if (rows.length > 0) return { coins: rows[0].coins };

      console.log(`🆕 Creando usuario: ${userId}`);
      await sql`INSERT INTO users (id, coins) VALUES (${userId}, 500)`;
      return { coins: 500 };
    } catch (error) {
      console.error("❌ Error getUserData:", error);
      return null;
    }
  }

  export async function updateCoins(newAmount: number) {
    const { userId } = await auth();
    if (!userId) throw new Error("No autorizado");

    try {
      await sql`UPDATE users SET coins = ${newAmount} WHERE id = ${userId}`;
      revalidatePath('/'); 
      return true;
    } catch (error) {
      console.error("❌ Error updateCoins:", error);
      return false;
    }
  }

  // --- 2. GESTIÓN DE LA COLECCIÓN ---

 // --- 2. GESTIÓN DE LA COLECCIÓN ---

// 👇 Añadimos "packPrice" como segundo parámetro (puedes cambiar el 100 por lo que cuesten tus sobres)
export async function savePackToCollection(cards: any[], packPrice: number = 100) {
  const { userId } = await auth();
  if (!userId) return { success: false, error: "No logueado" };

  try {
    for (const card of cards) {
      const setId = card.set?.id || card.setId || 'unknown_set';
      
      // PREPARAR DATOS EXTRA
      const number = card.number || '';
      const artist = card.artist || 'Desconocido';
      const flavorText = card.flavorText || '';
      const tcgplayer = JSON.stringify(card.tcgplayer || {}); 

      // 1. INSERTAR EN TABLA MAESTRA (Si no existe)
      await sql`
        INSERT INTO cards (id, name, rarity, images, set_id, number, artist, flavor_text, tcgplayer)
        VALUES (
            ${card.id}, 
            ${card.name}, 
            ${card.rarity || 'Common'}, 
            ${JSON.stringify(card.images)}, 
            ${setId},
            ${number},       
            ${artist},       
            ${flavorText},   
            ${tcgplayer}     
        )
        ON CONFLICT (id) DO NOTHING;
      `;

      // 2. INSERTAR EN COLECCIÓN DE USUARIO (Incrementar cantidad)
      await sql`
        INSERT INTO user_collection (user_id, card_id, quantity)
        VALUES (${userId}, ${card.id}, 1)
        ON CONFLICT (user_id, card_id) 
        DO UPDATE SET quantity = user_collection.quantity + 1;
      `;
    }

    // 🚨 NUEVO: SUMAR A LAS ESTADÍSTICAS DEL JUGADOR 🚨
    await sql`
      UPDATE users 
      SET packs_opened = COALESCE(packs_opened, 0) + 1,
          money_spent = COALESCE(money_spent, 0) + ${packPrice}
      WHERE id = ${userId}
    `;
    // ================================================

    revalidatePath('/collection');
    return { success: true };
  } catch (error) {
    console.error("❌ Error guardando pack:", error);
    return { success: false, error: String(error) };
  }
}

  export async function getFullCollection() {
    const { userId } = await auth();
    if (!userId) return [];

    try {
      // ✅ CORRECCIÓN IMPORTANTE:
      // 1. Pedimos la columna 'is_favorite'
      // 2. Ordenamos primero por favoritos (DESC) y luego por cantidad
      const { rows } = await sql`
    SELECT c.*, uc.quantity, uc.is_favorite -- 👈 Asegúrate de pedir esta columna
    FROM user_collection uc
    JOIN cards c ON uc.card_id = c.id
    WHERE uc.user_id = ${userId}
    ORDER BY 
      uc.is_favorite DESC,  -- 👈 PRIMERO LAS FAVORITAS (True va antes que False)
      c.rarity DESC,        -- Luego por rareza
      c.name ASC            -- Luego por nombre
  `;
      
      const parse = (v: any, fb: any = null) => {
        if (v == null) return fb;
        return typeof v === 'string' ? JSON.parse(v) : v;
      };
      return rows.map((row: any) => ({
        ...row,
        images: parse(row.images),
        tcgplayer: parse(row.tcgplayer),
        types: parse(row.types, []),
        attacks: parse(row.attacks, []),
        weaknesses: parse(row.weaknesses, []),
        retreatCost: parse(row.retreat_cost, []),
        flavorText: row.flavor_text,
      }));
    } catch (error) {
      console.error("❌ Error cargando colección:", error);
      return [];
    }
  }

  // --- 3. ACCIONES DE JUEGO (Vender / Favoritos) ---

  export async function sellCardAction(cardId: string, price: number) {
    const { userId } = await auth();
    if (!userId) return false;

    try {
      // Solo vendemos si tiene más de 1 copia (Protección)
      const result = await sql`
        UPDATE user_collection 
        SET quantity = quantity - 1 
        WHERE user_id = ${userId} AND card_id = ${cardId} AND quantity > 1
      `;

      if (result.rowCount === 0) return false; 

      await sql`UPDATE users SET coins = coins + ${price} WHERE id = ${userId}`;

      revalidatePath('/collection'); 
      return true;
    } catch (error) {
      console.error("Error vendiendo carta:", error);
      return false;
    }
  }

  // En src/app/action.ts

  export async function toggleFavorite(cardId: string) {
    // 🔴 ¡IMPORTANTE! El 'await' aquí es OBLIGATORIO en versiones nuevas
    const { userId } = await auth(); 
    
    if (!userId) return { error: "No estás logueado" };

    try {
      // 1. Verificamos estado actual
      const currentStatus = await sql`
        SELECT is_favorite FROM user_collection 
        WHERE user_id = ${userId} AND card_id = ${cardId}
      `;
      
      // Si no encuentra la carta, es que no la tienes
      if (currentStatus.rowCount === 0) return { error: "No tienes esta carta" };

      const isFav = currentStatus.rows[0]?.is_favorite || false;

      // 2. Comprobar límite de 10 (solo si vamos a activar el favorito)
      if (!isFav) {
        const countResult = await sql`
          SELECT count(*) as total FROM user_collection 
          WHERE user_id = ${userId} AND is_favorite = true
        `;
        const totalFavs = parseInt(countResult.rows[0].total);
        if (totalFavs >= 10) return { error: "¡Límite de 10 favoritos alcanzado!" };
      }

      // 3. Cambiar el estado
      await sql`
        UPDATE user_collection 
        SET is_favorite = ${!isFav} 
        WHERE user_id = ${userId} AND card_id = ${cardId}
      `;

      revalidatePath('/collection');
      return { success: true, isFavorite: !isFav };

    } catch (error) {
      console.error("Error toggleFavorite:", error); // 👈 Mira la terminal de VSCode si falla
      return { error: "Error interno del servidor" };
    }
  }

  // --- 4. HERRAMIENTAS DE SINCRONIZACIÓN (Opcional si usas JSON local) ---

  export async function syncSetToDatabase(setId: string, cards: any[]) {
    try {
      const { count } = (await sql`SELECT count(*) FROM cards WHERE set_id = ${setId}`).rows[0];
      
      if (parseInt(count) > 0) return { status: 'already_synced' };

      console.log(`📥 Sincronizando ${setId} con la base de datos...`);

      for (const card of cards) {
        await sql`
          INSERT INTO cards (id, name, rarity, images, set_id, number, artist, flavor_text, tcgplayer)
          VALUES (
            ${card.id}, ${card.name}, ${card.rarity || 'Common'}, 
            ${JSON.stringify(card.images)}, ${setId}, ${card.number || '???'},       
            ${card.artist || 'Artista Desconocido'}, ${card.flavorText || ''},   
            ${JSON.stringify(card.tcgplayer || {})}
          ) ON CONFLICT (id) DO NOTHING;
        `;
      }

      return { status: 'success' };
    } catch (error) {
      console.error("Error sincronizando set:", error);
      return { status: 'error' };
    }
  }
  export async function sellAllDuplicatesAction(cardId: string, unitPrice: number) {
    const { userId } = await auth();
    if (!userId) return { success: false, error: "No autorizado" };

    try {
      // 1. Consultamos cuántas tiene el usuario
      const { rows } = await sql`
        SELECT quantity FROM user_collection 
        WHERE user_id = ${userId} AND card_id = ${cardId}
      `;

      if (rows.length === 0) return { success: false, error: "No tienes la carta" };

      const currentQty = rows[0].quantity;
      const duplicates = currentQty - 1;

      // Si no hay duplicados, no hacemos nada
      if (duplicates <= 0) return { success: false, error: "No tienes duplicados" };

      const totalEarned = duplicates * unitPrice;

      // 2. Actualizamos la colección: Dejamos la cantidad en 1
      await sql`
        UPDATE user_collection 
        SET quantity = 1 
        WHERE user_id = ${userId} AND card_id = ${cardId}
      `;

      // 3. Damos el dinero total
      await sql`
        UPDATE users 
        SET coins = coins + ${totalEarned} 
        WHERE id = ${userId}
      `;

      revalidatePath('/collection');
      return { success: true, sold: duplicates, earned: totalEarned };

    } catch (error) {
      console.error("Error vendiendo todo:", error);
      return { success: false, error: "Error en servidor" };
    }
  }
  // src/app/action.ts
  // src/app/action.ts

  export async function getSetsFromDB() {
    try {
      const { rows } = await sql`
        SELECT id, name, series, images, total, release_date
        FROM sets
        ORDER BY release_date DESC NULLS LAST
      `;
      
      return rows.map(set => ({
        ...set,
        releaseDate: set.release_date,
        images: typeof set.images === 'string' ? JSON.parse(set.images) : set.images
      }));
    } catch (error) {
      console.error("Error al obtener sets:", error);
      return [];
    }
  }
  // Añade esto al final de tu src/app/action.ts

  export async function getTrainerCollection(trainerId: string) {
    try {
      // Hacemos un JOIN entre tus dos tablas correctas: user_collection y cards
      const { rows } = await sql`
        SELECT 
          c.*, 
          uc.quantity, 
          uc.is_favorite
        FROM user_collection uc
        JOIN cards c ON uc.card_id = c.id
        WHERE uc.user_id = ${trainerId}
      `;

      // Formateamos los datos para que tu página los entienda perfectamente
      const parse = (v: any, fb: any = null) => {
        if (v == null) return fb;
        return typeof v === 'string' ? JSON.parse(v) : v;
      };
      return rows.map((row: any) => ({
        ...row,
        images: parse(row.images),
        tcgplayer: parse(row.tcgplayer),
        types: parse(row.types, []),
        attacks: parse(row.attacks, []),
        weaknesses: parse(row.weaknesses, []),
        retreatCost: parse(row.retreat_cost, []),
        flavorText: row.flavor_text,
        set: { id: row.set_id, name: row.set_name },
      }));
      
    } catch (error) {
      console.error("❌ Error leyendo colección del entrenador:", error);
      return [];
    }
  }
  // --- SISTEMA DE AMIGOS ---

  // 1. Enviar petición de amistad
  export async function sendFriendRequest(friendId: string) {
    const { userId } = await auth();
    if (!userId) throw new Error("No autorizado");
    if (userId === friendId) return { error: "No puedes añadirte a ti mismo" };

    try {
      // Comprobar si ya existe la amistad o la petición
      const { rows: existing } = await sql`
        SELECT * FROM friendships 
        WHERE (user_id = ${userId} AND friend_id = ${friendId})
          OR (user_id = ${friendId} AND friend_id = ${userId})
      `;
      
      if (existing.length > 0) {
        return { error: "Ya sois amigos o hay una petición pendiente." };
      }

      await sql`
        INSERT INTO friendships (user_id, friend_id, status)
        VALUES (${userId}, ${friendId}, 'pending')
      `;
      return { success: true };
    } catch (error) {
      console.error("Error enviando petición:", error);
      return { error: "Error de servidor al enviar petición." };
    }
  }

  // --- NUEVA FUNCIÓN: Guarda tu nombre de Clerk en la BD ---
  export async function syncUserName() {
    const user = await currentUser();
    if (!user) return;

    // Intentamos coger tu nombre de usuario, si no, tu nombre de pila, y si no, "Entrenador"
    const displayName = user.username || user.firstName || "Entrenador";

    try {
      // Guarda o actualiza el nombre en tu tabla 'users'
      await sql`
        INSERT INTO users (id, username) 
        VALUES (${user.id}, ${displayName})
        ON CONFLICT (id) 
        DO UPDATE SET username = ${displayName}
      `;
    } catch (error) {
      console.error("Error sincronizando nombre de usuario:", error);
    }
  }

  // --- FUNCIÓN ACTUALIZADA: Obtener amigos + TÚ MISMO en el Ranking ---
  export async function getFriendsList() {
    const { userId } = await auth();
    if (!userId) return { accepted: [], pendingRequests: [] };

    try {
      const { rows: accepted } = await sql`
        SELECT 
          f.id as friendship_id, 
          CASE WHEN f.user_id = ${userId} THEN f.friend_id ELSE f.user_id END as friend_id,
          COALESCE(u.username, 'Entrenador') as friend_name,
          COALESCE(u.packs_opened, 0) as packs_opened,
          COALESCE(u.money_spent, 0) as money_spent
        FROM friendships f
        LEFT JOIN users u ON u.id = (CASE WHEN f.user_id = ${userId} THEN f.friend_id ELSE f.user_id END)
        WHERE (f.user_id = ${userId} OR f.friend_id = ${userId}) AND f.status = 'accepted'
      `;

      const { rows: pending } = await sql`
        SELECT 
          f.id, 
          f.user_id as requester_id,
          COALESCE(u.username, 'Entrenador') as requester_name
        FROM friendships f
        LEFT JOIN users u ON u.id = f.user_id
        WHERE f.friend_id = ${userId} AND f.status = 'pending'
      `;

      // === 🚨 NUEVO: Te añadimos a ti mismo a la lista del ranking ===
      const { rows: myData } = await sql`
        SELECT 
          id, 
          COALESCE(username, 'Entrenador') as username, 
          COALESCE(packs_opened, 0) as packs_opened, 
          COALESCE(money_spent, 0) as money_spent
        FROM users WHERE id = ${userId}
      `;

      if (myData.length > 0) {
        accepted.push({
          friendship_id: 'me', // Un ID ficticio para que React no se queje
          friend_id: myData[0].id,
          friend_name: myData[0].username + " (Tú)", // Destacamos que eres tú
          packs_opened: myData[0].packs_opened,
          money_spent: myData[0].money_spent
        });
      }
      // ===============================================================

      // Calcular estadísticas de todos (ahora te incluye a ti)
      for (const friend of accepted) {
        const { rows: friendCards } = await sql`
          SELECT uc.quantity, uc.is_favorite, c.rarity
          FROM user_collection uc
          JOIN cards c ON uc.card_id = c.id
          WHERE uc.user_id = ${friend.friend_id}
        `;

        let totalValue = 0;
        let totalCards = 0;
        let totalUnique = 0;
        let totalFavs = 0;

        friendCards.forEach((row) => {
          totalUnique += 1;
          totalCards += row.quantity;
          if (row.is_favorite) totalFavs += 1;
          const price = SELL_PRICES[row.rarity as keyof typeof SELL_PRICES] || 10;
          totalValue += (price * row.quantity);
        });

        friend.stats = {
          value: totalValue,
          cards: totalCards,
          unique: totalUnique,
          favs: totalFavs,
          packs: friend.packs_opened,
          spent: friend.money_spent
        };
      }

      // Ordenamos de mayor a menor valor
      accepted.sort((a, b) => b.stats.value - a.stats.value);

      return { accepted, pendingRequests: pending };
    } catch (error) {
      console.error("Error obteniendo amigos:", error);
      return { accepted: [], pendingRequests: [] };
    }
  }

  // 3. Aceptar petición
  export async function acceptFriendRequest(friendshipId: number) {
    const { userId } = await auth();
    if (!userId) return { error: "No autorizado" };

    try {
      await sql`
        UPDATE friendships SET status = 'accepted'
        WHERE id = ${friendshipId} AND friend_id = ${userId}
      `;
      return { success: true };
    } catch (error) {
      return { error: "Error al aceptar petición" };
    }
  }

  // 4. Eliminar amigo o rechazar petición
  export async function removeFriend(friendshipId: number) {
    const { userId } = await auth();
    if (!userId) return { error: "No autorizado" };

    try {
      await sql`
        DELETE FROM friendships
        WHERE id = ${friendshipId} AND (user_id = ${userId} OR friend_id = ${userId})
      `;
      return { success: true };
    } catch (error) {
      return { error: "Error al eliminar amigo" };
    }
  }
  // --- 5. SISTEMA DE INTERCAMBIOS ---

// --- 5. SISTEMA DE INTERCAMBIOS ---

// 1. Enviar una oferta de intercambio
export async function sendTradeRequest(friendId: string, myCardId: string, friendCardId: string) {
  const { userId } = await auth();
  if (!userId) return { error: "No autorizado" };

  try {
    await sql`
      INSERT INTO trades (sender_id, receiver_id, sender_card_id, receiver_card_id, status)
      VALUES (${userId}, ${friendId}, ${myCardId}, ${friendCardId}, 'pending')
    `;
    return { success: true };
  } catch (error) {
    console.error("Error enviando trade:", error);
    return { error: "Error al enviar la oferta" };
  }
}

// 2. Leer las peticiones que me han mandado
export async function getPendingTrades() {
  const { userId } = await auth();
  if (!userId) return [];

  try {
    const { rows } = await sql`
      SELECT 
        t.id as trade_id,
        t.sender_id,
        u.username as sender_name,
        t.sender_card_id,
        c1.name as sender_card_name,
        c1.images as sender_card_image,
        t.receiver_card_id,
        c2.name as receiver_card_name,
        c2.images as receiver_card_image
      FROM trades t
      JOIN users u ON u.id = t.sender_id
      JOIN cards c1 ON c1.id = t.sender_card_id
      JOIN cards c2 ON c2.id = t.receiver_card_id
      WHERE t.receiver_id = ${userId} AND t.status = 'pending'
    `;

    return rows.map(row => ({
      ...row,
      sender_card_image: typeof row.sender_card_image === 'string' ? JSON.parse(row.sender_card_image) : row.sender_card_image,
      receiver_card_image: typeof row.receiver_card_image === 'string' ? JSON.parse(row.receiver_card_image) : row.receiver_card_image,
    }));
  } catch (error) {
    console.error("Error leyendo trades:", error);
    return [];
  }
}

// 3. Aceptar un intercambio y cruzar las cartas
export async function acceptTrade(tradeId: number) {
  const { userId } = await auth();
  if (!userId) return { error: "No autorizado" };

  try {
    const { rows } = await sql`SELECT * FROM trades WHERE id = ${tradeId} AND receiver_id = ${userId} AND status = 'pending'`;
    if (rows.length === 0) return { error: "El intercambio ya no está disponible." };
    const trade = rows[0];

    // Comprobar si ambos aún tienen las cartas
    const senderCheck = await sql`SELECT quantity FROM user_collection WHERE user_id = ${trade.sender_id} AND card_id = ${trade.sender_card_id} AND quantity > 0`;
    const receiverCheck = await sql`SELECT quantity FROM user_collection WHERE user_id = ${userId} AND card_id = ${trade.receiver_card_id} AND quantity > 0`;
    
    if (senderCheck.rowCount === 0 || receiverCheck.rowCount === 0) {
        await sql`UPDATE trades SET status = 'failed' WHERE id = ${tradeId}`;
        return { error: "Alguien ya no tiene la carta prometida. Intercambio cancelado." };
    }

    // Restar las cartas
    await sql`UPDATE user_collection SET quantity = quantity - 1 WHERE user_id = ${trade.sender_id} AND card_id = ${trade.sender_card_id}`;
    await sql`UPDATE user_collection SET quantity = quantity - 1 WHERE user_id = ${userId} AND card_id = ${trade.receiver_card_id}`;

    // Sumar las cartas al nuevo dueño
    await sql`INSERT INTO user_collection (user_id, card_id, quantity) VALUES (${trade.sender_id}, ${trade.receiver_card_id}, 1) ON CONFLICT (user_id, card_id) DO UPDATE SET quantity = user_collection.quantity + 1`;
    await sql`INSERT INTO user_collection (user_id, card_id, quantity) VALUES (${userId}, ${trade.sender_card_id}, 1) ON CONFLICT (user_id, card_id) DO UPDATE SET quantity = user_collection.quantity + 1`;

    await sql`UPDATE trades SET status = 'accepted' WHERE id = ${tradeId}`;
    return { success: true };
  } catch (error) {
    return { error: "Error en el servidor al procesar el intercambio." };
  }
}

// 4. Rechazar intercambio
export async function rejectTrade(tradeId: number) {
  const { userId } = await auth();
  if (!userId) return false;
  await sql`UPDATE trades SET status = 'rejected' WHERE id = ${tradeId} AND receiver_id = ${userId}`;
  return true;
}
// 5. Leer notificaciones de mis ofertas respondidas
export async function getCompletedTrades() {
  const { userId } = await auth();
  if (!userId) return [];

  try {
    const { rows } = await sql`
      SELECT 
        t.id as trade_id,
        t.receiver_id,
        COALESCE(u.username, 'Entrenador') as receiver_name,
        t.status,
        c1.name as sender_card_name,
        c2.name as receiver_card_name
      FROM trades t
      JOIN users u ON u.id = t.receiver_id
      JOIN cards c1 ON c1.id = t.sender_card_id
      JOIN cards c2 ON c2.id = t.receiver_card_id
      WHERE t.sender_id = ${userId} 
        AND t.status IN ('accepted', 'rejected', 'failed') 
        AND t.is_read = FALSE
    `;
    return rows;
  } catch (error) {
    console.error("Error leyendo trades completados:", error);
    return [];
  }
}

// 6. Marcar notificación como leída
export async function markTradeAsRead(tradeId: number) {
  const { userId } = await auth();
  if (!userId) return false;
  try {
    await sql`UPDATE trades SET is_read = TRUE WHERE id = ${tradeId} AND sender_id = ${userId}`;
    return true;
  } catch (error) {
    return false;
  }
}
// --- DAILY REWARD ---
export async function claimDailyReward() {
  const { userId } = await auth();
  if (!userId) return { error: "No autorizado" };
  try {
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_daily_claim TIMESTAMP`;
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS streak INT DEFAULT 0`;

    const { rows } = await sql`SELECT last_daily_claim, streak FROM users WHERE id = ${userId}`;
    if (rows.length === 0) return { error: "Usuario no existe" };

    const last: Date | null = rows[0].last_daily_claim;
    const streak: number = rows[0].streak || 0;
    const now = new Date();

    if (last) {
      const diffMs = now.getTime() - new Date(last).getTime();
      const hours = diffMs / (1000 * 60 * 60);
      if (hours < 20) {
        const remaining = Math.ceil(20 - hours);
        return { error: `Recompensa lista en ~${remaining}h` };
      }
    }

    const wasYesterday = last
      ? (now.getTime() - new Date(last).getTime()) / (1000 * 60 * 60) < 48
      : false;
    const newStreak = wasYesterday ? streak + 1 : 1;
    const baseReward = 100;
    const bonus = Math.min(newStreak * 10, 100);
    const totalReward = baseReward + bonus;

    await sql`
      UPDATE users
      SET coins = coins + ${totalReward},
          last_daily_claim = NOW(),
          streak = ${newStreak}
      WHERE id = ${userId}
    `;
    revalidatePath('/');
    return { success: true, reward: totalReward, streak: newStreak };
  } catch (e) {
    console.error("Error daily reward:", e);
    return { error: "Error servidor" };
  }
}

export async function getDailyStatus() {
  const { userId } = await auth();
  if (!userId) return { available: false };
  try {
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_daily_claim TIMESTAMP`;
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS streak INT DEFAULT 0`;
    const { rows } = await sql`SELECT last_daily_claim, streak FROM users WHERE id = ${userId}`;
    if (rows.length === 0) return { available: true, streak: 0 };
    const last = rows[0].last_daily_claim;
    const streak = rows[0].streak || 0;
    if (!last) return { available: true, streak };
    const hours = (Date.now() - new Date(last).getTime()) / (1000 * 60 * 60);
    return { available: hours >= 20, streak, hoursLeft: Math.max(0, Math.ceil(20 - hours)) };
  } catch (e) {
    return { available: false };
  }
}

// --- PROFILE STATS (for home hero) ---
export async function getProfileStats() {
  const { userId } = await auth();
  if (!userId) return null;
  try {
    const { rows: cards } = await sql`
      SELECT uc.quantity, uc.is_favorite, c.rarity, c.set_id
      FROM user_collection uc
      JOIN cards c ON uc.card_id = c.id
      WHERE uc.user_id = ${userId}
    `;
    const { rows: setsRows } = await sql`SELECT id, total FROM sets`;
    const totalsBySet: Record<string, number> = {};
    setsRows.forEach((s: any) => { totalsBySet[s.id] = s.total; });

    let totalValue = 0;
    let totalCards = 0;
    let totalUnique = 0;
    const uniquePerSet: Record<string, number> = {};

    cards.forEach((row: any) => {
      totalUnique += 1;
      totalCards += row.quantity;
      const price = SELL_PRICES[row.rarity as keyof typeof SELL_PRICES] || 10;
      totalValue += price * row.quantity;
      uniquePerSet[row.set_id] = (uniquePerSet[row.set_id] || 0) + 1;
    });

    let setsCompleted = 0;
    Object.entries(uniquePerSet).forEach(([sid, owned]) => {
      const total = totalsBySet[sid];
      if (total && owned >= total) setsCompleted += 1;
    });

    return {
      totalValue,
      totalCards,
      totalUnique,
      setsCompleted,
      setsTotal: setsRows.length,
    };
  } catch (e) {
    console.error("Error stats:", e);
    return null;
  }
}

// --- CARD DETAIL FROM DB (replaces live API for modal) ---
export async function getCardFromDB(cardId: string) {
  try {
    const { rows } = await sql`SELECT * FROM cards WHERE id = ${cardId} LIMIT 1`;
    if (rows.length === 0) return null;
    const row: any = rows[0];
    const parse = (v: any, fb: any = null) => {
      if (v == null) return fb;
      return typeof v === 'string' ? JSON.parse(v) : v;
    };
    // Get set info too
    let setObj: any = { id: row.set_id };
    const { rows: setRows } = await sql`SELECT * FROM sets WHERE id = ${row.set_id} LIMIT 1`;
    if (setRows.length > 0) {
      const s: any = setRows[0];
      setObj = {
        id: s.id, name: s.name, series: s.series,
        printedTotal: s.printed_total, total: s.total,
        ptcgoCode: s.ptcgo_code, releaseDate: s.release_date,
        legalities: parse(s.legalities, {}),
        images: parse(s.images, {}),
      };
    }
    return {
      id: row.id,
      name: row.name,
      supertype: row.supertype,
      subtypes: parse(row.subtypes, []),
      level: row.level,
      hp: row.hp,
      types: parse(row.types, []),
      evolvesFrom: row.evolves_from,
      evolvesTo: parse(row.evolves_to, []),
      rules: parse(row.rules, []),
      ancientTrait: parse(row.ancient_trait, null),
      abilities: parse(row.abilities, []),
      attacks: parse(row.attacks, []),
      weaknesses: parse(row.weaknesses, []),
      resistances: parse(row.resistances, []),
      retreatCost: parse(row.retreat_cost, []),
      convertedRetreatCost: row.converted_retreat_cost,
      set: setObj,
      number: row.number,
      artist: row.artist,
      rarity: row.rarity,
      flavorText: row.flavor_text,
      nationalPokedexNumbers: parse(row.national_pokedex_numbers, []),
      legalities: parse(row.legalities, null),
      regulationMark: row.regulation_mark,
      images: parse(row.images, {}),
      tcgplayer: parse(row.tcgplayer, null),
      cardmarket: parse(row.cardmarket, null),
    };
  } catch (e) {
    console.error("getCardFromDB error:", e);
    return null;
  }
}

// --- SEARCH CARDS IN DB (replaces live API in GlobalSearch) ---
export async function searchCardsInDB(query: string, limit = 30) {
  try {
    const term = `%${query.toLowerCase()}%`;
    const { rows } = await sql`
      SELECT id, name, rarity, images, set_id
      FROM cards
      WHERE LOWER(name) LIKE ${term}
      ORDER BY name ASC
      LIMIT ${limit}
    `;
    const setIds = Array.from(new Set(rows.map((r: any) => r.set_id)));
    const setMap: Record<string, any> = {};
    if (setIds.length > 0) {
      const { rows: setRows } = await sql.query(
        `SELECT id, name FROM sets WHERE id = ANY($1::text[])`,
        [setIds],
      );
      setRows.forEach((s: any) => { setMap[s.id] = s; });
    }
    return rows.map((r: any) => ({
      id: r.id,
      name: r.name,
      rarity: r.rarity,
      images: typeof r.images === 'string' ? JSON.parse(r.images) : r.images,
      set: setMap[r.set_id] || { id: r.set_id },
    }));
  } catch (e) {
    console.error("searchCardsInDB error:", e);
    return [];
  }
}

// --- SET COMPLETION BONUS ---
// Grants one-time coin reward when user completes a full set.
export async function claimSetCompletionBonuses() {
  const { userId } = await auth();
  if (!userId) return { granted: 0, sets: [] };
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS set_rewards (
        user_id TEXT NOT NULL,
        set_id TEXT NOT NULL,
        rewarded_at TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (user_id, set_id)
      )
    `;
    // Unique owned cards per set
    const { rows: owned } = await sql`
      SELECT c.set_id, COUNT(*)::int AS owned
      FROM user_collection uc
      JOIN cards c ON uc.card_id = c.id
      WHERE uc.user_id = ${userId}
      GROUP BY c.set_id
    `;
    const { rows: setsRows } = await sql`SELECT id, total, name FROM sets`;
    const totals: Record<string, { total: number; name: string }> = {};
    setsRows.forEach((s: any) => { totals[s.id] = { total: s.total, name: s.name }; });

    const { rows: already } = await sql`SELECT set_id FROM set_rewards WHERE user_id = ${userId}`;
    const rewarded = new Set(already.map((r: any) => r.set_id));

    const BONUS = 1000;
    let granted = 0;
    const completedSets: string[] = [];

    for (const row of owned) {
      const meta = totals[row.set_id];
      if (!meta || !meta.total) continue;
      if (row.owned >= meta.total && !rewarded.has(row.set_id)) {
        await sql`INSERT INTO set_rewards (user_id, set_id) VALUES (${userId}, ${row.set_id}) ON CONFLICT DO NOTHING`;
        granted += BONUS;
        completedSets.push(meta.name);
      }
    }

    if (granted > 0) {
      await sql`UPDATE users SET coins = coins + ${granted} WHERE id = ${userId}`;
      revalidatePath('/');
    }
    return { granted, sets: completedSets, bonusPerSet: BONUS };
  } catch (e) {
    console.error("claimSetCompletionBonuses error:", e);
    return { granted: 0, sets: [] };
  }
}
