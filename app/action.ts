// src/app/action.ts
'use server'

import { auth } from '@clerk/nextjs/server';
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

// --- 2. GESTIÓN DE LA COLECCIÓN (ACTUALIZADA) ---

export async function savePackToCollection(cards: any[]) {
  const { userId } = await auth();
  if (!userId) return { success: false, error: "No logueado" };

  try {
    for (const card of cards) {
      const setId = card.set?.id || card.setId || 'unknown_set';
      
      // PREPARAR DATOS EXTRA (Si no existen, ponemos null)
      const number = card.number || '';
      const artist = card.artist || 'Desconocido';
      const flavorText = card.flavorText || '';
      // El precio viene como objeto, lo pasamos a texto para guardarlo
      const tcgplayer = JSON.stringify(card.tcgplayer || {}); 

      // 1. INSERTAR EN TABLA MAESTRA CON TODOS LOS DATOS NUEVOS
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

      // 2. Guardar en la colección del usuario
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
    // Pedimos TODAS las columnas (c.*)
    const { rows } = await sql`
      SELECT c.*, uc.quantity 
      FROM user_collection uc
      JOIN cards c ON uc.card_id = c.id
      WHERE uc.user_id = ${userId}
      AND uc.quantity > 0
      ORDER BY uc.quantity DESC
    `;
    
    // Procesamos los datos para que el Frontend los entienda
    return rows.map((row: any) => ({
      ...row,
      // Convertimos de vuelta los JSONs guardados como texto
      images: typeof row.images === 'string' ? JSON.parse(row.images) : row.images,
      tcgplayer: typeof row.tcgplayer === 'string' ? JSON.parse(row.tcgplayer) : row.tcgplayer,
      // Postgres devuelve 'flavor_text' (snake_case), pero tu app usa 'flavorText' (camelCase)
      flavorText: row.flavor_text 
    }));
  } catch (error) {
    console.error("❌ Error cargando colección:", error);
    return [];
  }
}

// 3. VENDER CARTA
export async function sellCardAction(cardId: string, price: number) {
  const { userId } = await auth();
  if (!userId) return false;

  try {
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
// src/app/action.ts

export async function syncSetToDatabase(setId: string, cards: any[]) {
  try {
    // 1. Verificamos si ya tenemos cartas de este set para no trabajar doble
    const { count } = (await sql`SELECT count(*) FROM cards WHERE set_id = ${setId}`).rows[0];
    
    if (parseInt(count) > 0) return { status: 'already_synced' };

    console.log(`📥 Sincronizando ${setId} con la base de datos...`);

    // 2. Guardamos el catálogo completo
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