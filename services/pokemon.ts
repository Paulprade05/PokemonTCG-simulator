// src/services/pokemon.ts
'use server'

import { sql } from '@vercel/postgres';

// Definimos el tipo de carta para TypeScript
interface Card {
  id: string;
  name: string;
  rarity: string;
  images: { small: string; large: string };
}

export const getCardsFromSet = async (setId: string) => {
  console.log(`🔍 [DB] Buscando set: ${setId}...`);

  try {
    // 1. PRIMERO: Miramos en NUESTRA Base de Datos (Neon/Vercel)
    // Seleccionamos todas las cartas que tengan ese 'set_id'
    const { rows } = await sql`SELECT * FROM cards WHERE set_id = ${setId}`;

    if (rows.length > 0) {
      console.log(`⚡ ¡CACHE HIT! Encontradas ${rows.length} cartas en la BD.`);
      // La BD devuelve el JSON de 'images' como objeto, así que lo mapeamos directo
      return rows.map((row: any) => ({
        id: row.id,
        name: row.name,
        rarity: row.rarity,
        images: row.images, // Postgres ya lo convierte de JSON a objeto
      })) as Card[];
    }

    // 2. SEGUNDO: Si no están (Cache Miss), llamamos a la API Externa
    console.log(`🌍 [API] No están en BD. Descargando de Pokémon TCG API...`);
    
    const response = await fetch(
      `https://api.pokemontcg.io/v2/cards?q=set.id:${setId}&select=id,name,images,rarity`, 
      {
        headers: {
          // Asegúrate de que tu API KEY sigue aquí
          'X-Api-Key': 'TU_CLAVE_API_AQUI' 
        }
      }
    );

    if (!response.ok) throw new Error(`Error API Externa: ${response.status}`);
    
    const data = await response.json();
    const cards: Card[] = data.data;

    // 3. TERCERO: ¡Guardamos todo en la BD para siempre!
    console.log(`💾 [DB] Guardando ${cards.length} cartas nuevas...`);

    // Insertamos las cartas una a una (o en paralelo)
    // Usamos Promise.all para que sea más rápido
    await Promise.all(
      cards.map(card => {
        // OJO: 'images' es un objeto, hay que convertirlo a string para guardarlo si usas SQL puro,
        // pero con @vercel/postgres y JSONB suele ser automático. 
        // Por seguridad usamos JSON.stringify para asegurar el formato.
        return sql`
          INSERT INTO cards (id, name, rarity, images, set_id)
          VALUES (
            ${card.id}, 
            ${card.name}, 
            ${card.rarity || 'Common'}, 
            ${JSON.stringify(card.images)}, 
            ${setId}
          )
          ON CONFLICT (id) DO NOTHING; -- Si la carta ya existe, no falles
        `;
      })
    );

    console.log("✅ Set guardado. La próxima vez será instantáneo.");
    return cards;

  } catch (error) {
    console.error("❌ Error en getCardsFromSet:", error);
    return []; // En caso de emergencia devolvemos vacío
  }
};