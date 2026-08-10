  // src/app/action.ts
  'use server'

  import { auth, currentUser } from "@clerk/nextjs/server";
  import { sql } from '@vercel/postgres';
  import { revalidatePath } from 'next/cache';
  import { SELL_PRICES, RARITY_RANK, STARTING_COINS, DAILY_BASE, DAILY_STREAK_STEP, DAILY_STREAK_CAP, SET_COMPLETION_BONUS } from "../utils/constanst";
  import { loadLocalSets } from "../services/localData";
  // --- 1. GESTIÓN DE USUARIO Y MONEDAS ---

  export async function getUserData() {
    const { userId } = await auth();
    if (!userId) return null;

    try {
      const { rows } = await sql`SELECT * FROM users WHERE id = ${userId}`;
      if (rows.length > 0) return { coins: rows[0].coins };

      console.log(`🆕 Creando usuario: ${userId}`);
      await sql`INSERT INTO users (id, coins) VALUES (${userId}, ${STARTING_COINS})`;
      return { coins: STARTING_COINS };
    } catch (error) {
      console.error("❌ Error getUserData:", error);
      return null;
    }
  }

  /**
   * Cobro atómico. Es la única forma correcta de gastar monedas.
   *
   * La alternativa que había (escribir un total absoluto calculado en el
   * cliente) tenía dos agujeros: se fiaba del saldo que dijera el navegador, y
   * pisaba cualquier ingreso que hubiera ocurrido entretanto —reclamas la
   * recompensa diaria (+100) y al comprar un sobre acto seguido el total viejo
   * borraba esos 100—. Aquí la resta la hace la base de datos, la condición
   * `coins >= price` impide saldos negativos y dobles cobros, y se devuelve el
   * saldo resultante para que el cliente adopte el del servidor.
   *
   * Devuelve el saldo tras el cobro, o null si no hay sesión, fondos o falla.
   */
  export async function spendCoinsAction(price: number): Promise<number | null> {
    const { userId } = await auth();
    if (!userId) return null;
    if (!Number.isFinite(price) || price <= 0) return null;

    try {
      const { rows } = await sql`
        UPDATE users
        SET coins = coins - ${price}
        WHERE id = ${userId} AND coins >= ${price}
        RETURNING coins
      `;
      if (rows.length === 0) return null; // fondos insuficientes
      revalidatePath('/');
      return Number(rows[0].coins);
    } catch (error) {
      console.error("❌ Error spendCoinsAction:", error);
      return null;
    }
  }

  /**
   * @deprecated Escribe un total absoluto que viene del cliente: se fía de él y
   * pisa ingresos concurrentes. Para gastar usa `spendCoinsAction`.
   */
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
export async function savePackToCollection(cards: any[], packPrice: number = 100, packCount: number = 1) {
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
      SET packs_opened = COALESCE(packs_opened, 0) + ${packCount},
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
    WHERE uc.user_id = ${userId} AND uc.quantity > 0
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
        WHERE user_id = ${userId} AND card_id = ${cardId} AND quantity > 0
      `;

      // Si no encuentra la carta, es que no la tienes
      if (currentStatus.rowCount === 0) return { error: "No tienes esta carta" };

      const isFav = currentStatus.rows[0]?.is_favorite || false;

      // 2. Comprobar límite de 10 (solo si vamos a activar el favorito)
      if (!isFav) {
        const countResult = await sql`
          SELECT count(*) as total FROM user_collection
          WHERE user_id = ${userId} AND is_favorite = true AND quantity > 0
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
        WHERE user_id = ${userId} AND card_id = ${cardId} AND quantity > 0
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
      
      // Si la tabla está vacía todavía no se ha ejecutado el seed.
      if (rows.length === 0) return loadLocalSets();

      return rows.map(set => ({
        ...set,
        releaseDate: set.release_date,
        images: typeof set.images === 'string' ? JSON.parse(set.images) : set.images
      }));
    } catch (error) {
      // Sin Postgres configurado servimos el catálogo del repositorio.
      console.error("Error al obtener sets, uso el JSON local:", error);
      return loadLocalSets();
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
        WHERE uc.user_id = ${trainerId} AND uc.quantity > 0
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
          WHERE uc.user_id = ${friend.friend_id} AND uc.quantity > 0
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
  // El sistema de intercambios antiguo (tabla `trades`) vivía aquí. Se retiró:
  // ninguna migración crea esa tabla y no quedaba ningún consumidor. El sistema
  // vigente es app/social.ts, sobre la tabla `trade_offers`.

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
    const baseReward = DAILY_BASE;
    const bonus = Math.min(newStreak * DAILY_STREAK_STEP, DAILY_STREAK_CAP);
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
      WHERE uc.user_id = ${userId} AND uc.quantity > 0
    `;
    const { rows: setsRows } = await sql`SELECT id, total FROM sets`;
    const { rows: userRows } = await sql`SELECT packs_opened, money_spent FROM users WHERE id = ${userId}`;
    const packsOpened = userRows[0]?.packs_opened || 0;
    const moneySpent = userRows[0]?.money_spent || 0;
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

    // Conteo de rarezas tier alto para logros
    let rareHits = 0;
    cards.forEach((row: any) => {
      if ((RARITY_RANK[row.rarity] || 0) >= 70) rareHits += 1; // Illustration Rare+
    });

    return {
      totalValue,
      totalCards,
      totalUnique,
      setsCompleted,
      setsTotal: setsRows.length,
      packsOpened,
      moneySpent,
      rareHits,
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
export async function searchCardsInDB(query: string, page = 1, pageSize = 10) {
  try {
    const { userId } = await auth();
    const term = `%${query.toLowerCase()}%`;
    const offset = Math.max(0, (page - 1) * pageSize);

    // Total
    const { rows: countRows } = await sql`
      SELECT count(*)::int AS total FROM cards WHERE LOWER(name) LIKE ${term}
    `;
    const total = countRows[0]?.total || 0;

    let rows: any[];
    if (userId) {
      const res = await sql`
        SELECT c.id, c.name, c.rarity, c.images, c.set_id,
               EXISTS(SELECT 1 FROM user_collection uc WHERE uc.user_id = ${userId} AND uc.card_id = c.id AND uc.quantity > 0) AS owned
        FROM cards c
        WHERE LOWER(c.name) LIKE ${term}
        ORDER BY c.name ASC
        LIMIT ${pageSize} OFFSET ${offset}
      `;
      rows = res.rows;
    } else {
      const res = await sql`
        SELECT id, name, rarity, images, set_id, false AS owned
        FROM cards
        WHERE LOWER(name) LIKE ${term}
        ORDER BY name ASC
        LIMIT ${pageSize} OFFSET ${offset}
      `;
      rows = res.rows;
    }
    const setIds = Array.from(new Set(rows.map((r: any) => r.set_id)));
    const setMap: Record<string, any> = {};
    if (setIds.length > 0) {
      const { rows: setRows } = await sql.query(
        `SELECT id, name FROM sets WHERE id = ANY($1::text[])`,
        [setIds],
      );
      setRows.forEach((s: any) => { setMap[s.id] = s; });
    }
    const data = rows.map((r: any) => ({
      id: r.id,
      name: r.name,
      rarity: r.rarity,
      images: typeof r.images === 'string' ? JSON.parse(r.images) : r.images,
      set: setMap[r.set_id] || { id: r.set_id },
      owned: r.owned,
    }));
    return { data, total, page, pageSize };
  } catch (e) {
    console.error("searchCardsInDB error:", e);
    return { data: [], total: 0, page, pageSize };
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
      WHERE uc.user_id = ${userId} AND uc.quantity > 0
      GROUP BY c.set_id
    `;
    const { rows: setsRows } = await sql`SELECT id, total, name FROM sets`;
    const totals: Record<string, { total: number; name: string }> = {};
    setsRows.forEach((s: any) => { totals[s.id] = { total: s.total, name: s.name }; });

    const { rows: already } = await sql`SELECT set_id FROM set_rewards WHERE user_id = ${userId}`;
    const rewarded = new Set(already.map((r: any) => r.set_id));

    const BONUS = SET_COMPLETION_BONUS;
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

// --- VENDER DUPLICADOS DE UN SOBRE (resumen) ---
// Recibe ids de cartas que YA poseías antes del sobre (los duplicados ganados).
// Vende 1 copia de cada (sin bajar de 1), acredita precio segun rareza.
export async function sellPackDuplicates(cardIds: string[]) {
  const { userId } = await auth();
  if (!userId || !cardIds || cardIds.length === 0) return { earned: 0, sold: 0 };
  try {
    // Contar cuántas veces aparece cada id en el sobre
    const counts: Record<string, number> = {};
    cardIds.forEach((id) => { counts[id] = (counts[id] || 0) + 1; });

    let earned = 0;
    let sold = 0;
    for (const [cardId, qtyToSell] of Object.entries(counts)) {
      const { rows } = await sql`
        SELECT uc.quantity, c.rarity
        FROM user_collection uc JOIN cards c ON uc.card_id = c.id
        WHERE uc.user_id = ${userId} AND uc.card_id = ${cardId} AND uc.quantity > 0
      `;
      if (rows.length === 0) continue;
      const have = rows[0].quantity;
      const rarity = rows[0].rarity;
      // No bajar de 1 copia
      const sellable = Math.min(qtyToSell, Math.max(0, have - 1));
      if (sellable <= 0) continue;
      const price = SELL_PRICES[rarity as keyof typeof SELL_PRICES] || 10;
      await sql`UPDATE user_collection SET quantity = quantity - ${sellable} WHERE user_id = ${userId} AND card_id = ${cardId}`;
      earned += price * sellable;
      sold += sellable;
    }
    if (earned > 0) {
      await sql`UPDATE users SET coins = coins + ${earned} WHERE id = ${userId}`;
      revalidatePath('/');
      revalidatePath('/collection');
    }
    return { earned, sold };
  } catch (e) {
    console.error("sellPackDuplicates error:", e);
    return { earned: 0, sold: 0 };
  }
}

// --- WISHLIST ---
export async function toggleWishlist(cardId: string) {
  const { userId } = await auth();
  if (!userId) return { error: "No logueado" };
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS wishlist (
        user_id TEXT NOT NULL,
        card_id TEXT NOT NULL,
        added_at TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (user_id, card_id)
      )
    `;
    const { rows } = await sql`SELECT 1 FROM wishlist WHERE user_id = ${userId} AND card_id = ${cardId}`;
    if (rows.length > 0) {
      await sql`DELETE FROM wishlist WHERE user_id = ${userId} AND card_id = ${cardId}`;
      return { wishlisted: false };
    }
    await sql`INSERT INTO wishlist (user_id, card_id) VALUES (${userId}, ${cardId}) ON CONFLICT DO NOTHING`;
    return { wishlisted: true };
  } catch (e) {
    console.error("toggleWishlist error:", e);
    return { error: "Error servidor" };
  }
}

export async function getWishlistIds() {
  const { userId } = await auth();
  if (!userId) return [];
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS wishlist (
        user_id TEXT NOT NULL,
        card_id TEXT NOT NULL,
        added_at TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (user_id, card_id)
      )
    `;
    const { rows } = await sql`SELECT card_id FROM wishlist WHERE user_id = ${userId}`;
    return rows.map((r: any) => r.card_id);
  } catch (e) {
    return [];
  }
}

export async function getWishlistCards() {
  const { userId } = await auth();
  if (!userId) return [];
  try {
    const { rows } = await sql`
      SELECT c.id, c.name, c.rarity, c.images, c.set_id,
             EXISTS(SELECT 1 FROM user_collection uc WHERE uc.user_id = ${userId} AND uc.card_id = c.id AND uc.quantity > 0) AS owned
      FROM wishlist w JOIN cards c ON w.card_id = c.id
      WHERE w.user_id = ${userId}
      ORDER BY w.added_at DESC
    `;
    return rows.map((r: any) => ({
      ...r,
      images: typeof r.images === 'string' ? JSON.parse(r.images) : r.images,
    }));
  } catch (e) {
    return [];
  }
}

// --- USER THEME PREFERENCE (persistido por usuario) ---
export async function getUserTheme(): Promise<"light" | "dark" | null> {
  const { userId } = await auth();
  if (!userId) return null;
  try {
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS theme TEXT`;
    const { rows } = await sql`SELECT theme FROM users WHERE id = ${userId}`;
    const t = rows[0]?.theme;
    if (t === "light" || t === "dark") return t;
    return null;
  } catch (e) {
    console.error("getUserTheme error:", e);
    return null;
  }
}

export async function setUserTheme(theme: "light" | "dark") {
  const { userId } = await auth();
  if (!userId) return { error: "No logueado" };
  if (theme !== "light" && theme !== "dark") return { error: "Tema inválido" };
  try {
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS theme TEXT`;
    await sql`
      INSERT INTO users (id, theme) VALUES (${userId}, ${theme})
      ON CONFLICT (id) DO UPDATE SET theme = ${theme}
    `;
    return { success: true };
  } catch (e) {
    console.error("setUserTheme error:", e);
    return { error: "Error servidor" };
  }
}
