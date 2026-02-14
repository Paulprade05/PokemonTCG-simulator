// src/services/pokemon.ts
'use server'

import { sql } from '@vercel/postgres';

export async function getCardsFromSet(setId: string) {
  try {
    console.log(`🗄️ Consultando base de datos para set: ${setId}`);

    // 1. CONSULTA SQL
    // Seleccionamos todas las cartas de ese set.
    // El "ORDER BY" es un truco para ordenar números (1, 2, 10) correctamente.
    const { rows } = await sql`
      SELECT * FROM cards 
      WHERE set_id = ${setId}
      ORDER BY 
        CASE WHEN number ~ '^[0-9]+$' THEN number::int ELSE 9999 END ASC, 
        number ASC
    `;

    if (rows.length === 0) {
      console.warn(`⚠️ No encontré cartas para ${setId} en la BD. ¿Has ejecutado el seed-local?`);
      return [];
    }
    
    // 2. MAPEO DE DATOS (Transformación)
    // La base de datos devuelve snake_case (set_id), pero tu app usa camelCase (setId).
    // Además, hay que convertir los strings JSON de vuelta a objetos.
    return rows.map((row: any) => ({
      id: row.id,
      name: row.name,
      rarity: row.rarity,
      set: { id: row.set_id }, // Reconstruimos el objeto set básico
      // 👇 TRUCO: Si Postgres lo devuelve como texto, lo parseamos. Si ya es objeto, lo dejamos.
      images: typeof row.images === 'string' ? JSON.parse(row.images) : row.images,
      tcgplayer: typeof row.tcgplayer === 'string' ? JSON.parse(row.tcgplayer) : row.tcgplayer,
      number: row.number,
      artist: row.artist,
      flavorText: row.flavor_text
    }));

  } catch (error) {
    console.error("❌ Error leyendo base de datos:", error);
    return [];
  }
}