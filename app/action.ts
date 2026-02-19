// src/app/action.ts
'use server'

import { auth } from '@clerk/nextjs/server'; // ✅ Importación correcta para Server Actions
import { sql } from '@vercel/postgres';
import { revalidatePath } from 'next/cache';

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
export async function getSetsFromDB() {
  try {
    const { rows } = await sql`
      SELECT id, name, series, images 
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