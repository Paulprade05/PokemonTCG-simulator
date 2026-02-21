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

export async function savePackToCollection(cards: any[]) {
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
    
    return rows.map((row: any) => ({
      ...row,
      images: typeof row.images === 'string' ? JSON.parse(row.images) : row.images,
      tcgplayer: typeof row.tcgplayer === 'string' ? JSON.parse(row.tcgplayer) : row.tcgplayer,
      flavorText: row.flavor_text 
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
      /* 👇 AÑADIMOS 'total' A LA LISTA DE COSAS QUE PEDIMOS 👇 */
      SELECT id, name, series, images, total 
      FROM sets 
      ORDER BY release_date DESC
    `;
    
    // Parseamos las imágenes ya que vienen como string JSON
    return rows.map(set => ({
      ...set,
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
    return rows.map((row: any) => ({
      ...row,
      // Si las imágenes están guardadas como texto (JSON), las convertimos a objeto
      images: typeof row.images === 'string' ? JSON.parse(row.images) : row.images,
      // Adaptamos el set para que funcione con tu componente PokemonCard
      set: { id: row.set_id, name: row.set_name } 
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

// --- FUNCIÓN ACTUALIZADA: Obtener amigos CON ESTADÍSTICAS Y RANKING ---
export async function getFriendsList() {
  const { userId } = await auth();
  if (!userId) return { accepted: [], pendingRequests: [] };

  try {
    const { rows: accepted } = await sql`
      SELECT 
        f.id as friendship_id, 
        CASE WHEN f.user_id = ${userId} THEN f.friend_id ELSE f.user_id END as friend_id,
        COALESCE(u.username, 'Entrenador') as friend_name
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

    // === NUEVO: Calcular estadísticas de cada amigo en vivo ===
    for (const friend of accepted) {
      // Buscamos todas las cartas de este amigo en la BD
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

      // Calculamos las 4 estadísticas
      friendCards.forEach((row) => {
        totalUnique += 1;
        totalCards += row.quantity;
        if (row.is_favorite) totalFavs += 1;
        
        // Calcular valor basado en SELL_PRICES
        const price = SELL_PRICES[row.rarity as keyof typeof SELL_PRICES] || 10;
        totalValue += (price * row.quantity);
      });

      // Se las guardamos en su perfil
      friend.stats = {
        value: totalValue,
        cards: totalCards,
        unique: totalUnique,
        favs: totalFavs
      };
    }

    // 🔥 LA MAGIA: Ordenamos la lista de amigos por Valor de Colección (De mayor a menor)
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