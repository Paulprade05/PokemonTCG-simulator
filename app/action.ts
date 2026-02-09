// src/app/actions.ts
'use server'

import { auth } from '@clerk/nextjs/server';
import { sql } from '@vercel/postgres';
import { revalidatePath } from 'next/cache';

// --- 1. GESTIÓN DE USUARIO Y MONEDAS ---

export async function getUserData() {
  const { userId } = await auth();
  if (!userId) return null;

  try {
    // Buscamos al usuario
    const { rows } = await sql`SELECT * FROM users WHERE id = ${userId}`;

    // Si existe, devolvemos sus datos
    if (rows.length > 0) {
      return { coins: rows[0].coins };
    }

    // Si NO existe, lo creamos con 500 monedas de regalo
    console.log(`🆕 Creando nuevo usuario: ${userId}`);
    await sql`INSERT INTO users (id, coins) VALUES (${userId}, 500)`;
    
    return { coins: 500 };

  } catch (error) {
    console.error("❌ Error en getUserData:", error);
    return null;
  }
}

export async function updateCoins(newAmount: number) {
  const { userId } = await auth();
  if (!userId) throw new Error("No autorizado");

  try {
    await sql`UPDATE users SET coins = ${newAmount} WHERE id = ${userId}`;
    revalidatePath('/'); // Actualiza la vista principal
    return true;
  } catch (error) {
    console.error("❌ Error en updateCoins:", error);
    return false;
  }
}

// --- 2. GESTIÓN DE LA COLECCIÓN (EL CORAZÓN DEL SISTEMA) ---

export async function savePackToCollection(cards: any[]) {
  const { userId } = await auth();
  if (!userId) return { success: false, error: "Usuario no logueado" };

  try {
    console.log(`💾 Guardando ${cards.length} cartas para el usuario ${userId}...`);

    for (const card of cards) {
      // A. PREPARAR DATOS
      // A veces la API devuelve 'set.id' dentro de un objeto, o 'setId' suelto.
      // Esto asegura que siempre tengamos un ID válido.
      const setId = card.set?.id || card.setId || 'unknown_set';
      
      // B. INSERTAR EN TABLA MAESTRA 'CARDS' (Vital para evitar errores)
      // Si la carta ya existe (ON CONFLICT), no hacemos nada.
      await sql`
        INSERT INTO cards (id, name, rarity, images, set_id)
        VALUES (
            ${card.id}, 
            ${card.name}, 
            ${card.rarity || 'Common'}, 
            ${JSON.stringify(card.images)}, 
            ${setId}
        )
        ON CONFLICT (id) DO NOTHING;
      `;

      // C. INSERTAR EN LA COLECCIÓN DEL USUARIO
      // Si ya la tiene (ON CONFLICT), sumamos +1 a la cantidad.
      await sql`
        INSERT INTO user_collection (user_id, card_id, quantity)
        VALUES (${userId}, ${card.id}, 1)
        ON CONFLICT (user_id, card_id) 
        DO UPDATE SET quantity = user_collection.quantity + 1;
      `;
    }

    console.log("✅ Pack guardado correctamente.");
    revalidatePath('/collection'); // Actualiza la página de colección
    return { success: true };

  } catch (error) {
    console.error("❌ ERROR GRAVE guardando pack:", error);
    // Devolvemos el error como texto para poder verlo en el navegador si hace falta
    return { success: false, error: String(error) };
  }
}

export async function getFullCollection() {
  const { userId } = await auth();
  if (!userId) return [];

  try {
    // Hacemos un JOIN para traer los datos de la carta + la cantidad que tiene el usuario
    const { rows } = await sql`
      SELECT c.id, c.name, c.rarity, c.images, c.set_id, uc.quantity 
      FROM user_collection uc
      JOIN cards c ON uc.card_id = c.id
      WHERE uc.user_id = ${userId}
      ORDER BY uc.quantity DESC
    `;
    
    // Postgres devuelve el campo JSONB 'images' ya parseado, pero por seguridad
    // aseguramos que tenga la estructura correcta.
    return rows.map((row: any) => ({
      ...row,
      // Si por alguna razón images viene como string, lo parseamos. Si no, lo dejamos.
      images: typeof row.images === 'string' ? JSON.parse(row.images) : row.images,
    }));

  } catch (error) {
    console.error("❌ Error cargando colección:", error);
    return [];
  }
}