// src/services/pokemon.ts
'use server'

import { sql } from '@vercel/postgres';
import { loadLocalCards } from './localData';

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
      console.warn(`⚠️ No encontré cartas para ${setId} en la BD. Uso el JSON local.`);
      return loadLocalCards(setId);
    }
    
    // 2. MAPEO DE DATOS (Transformación)
    // La base de datos devuelve snake_case (set_id), pero tu app usa camelCase (setId).
    // Además, hay que convertir los strings JSON de vuelta a objetos.
    const parseJson = (v: any) => (typeof v === 'string' ? JSON.parse(v) : v);
    // Las columnas JSONB guardan `null` cuando la carta no traía el dato (la
    // ingesta escribe JSON.stringify(v ?? null)). Quien consume estas listas las
    // recorre con .some()/.map(), así que un null reventaría: se normaliza a [].
    const parseArray = (v: unknown): unknown[] => {
      const parsed = parseJson(v);
      return Array.isArray(parsed) ? parsed : [];
    };
    return rows.map((row: any) => ({
      id: row.id,
      name: row.name,
      rarity: row.rarity,
      set: { id: row.set_id },
      images: parseJson(row.images),
      tcgplayer: parseJson(row.tcgplayer),
      number: row.number,
      artist: row.artist,
      flavorText: row.flavor_text,
      hp: row.hp,
      types: parseArray(row.types),
      attacks: parseArray(row.attacks),
      weaknesses: parseArray(row.weaknesses),
      retreatCost: parseArray(row.retreat_cost),
      supertype: row.supertype,
      // Estos tres los escribe la ingesta (columnas subtypes, evolves_from y
      // national_pokedex_numbers) pero el mapeo los descartaba. Sin ellos los
      // filtros del mercado de "etapa", "evolucion" y "pokedex" no casan con
      // ninguna carta: la oferta se vuelve imposible sin decir por qué.
      subtypes: parseArray(row.subtypes),
      evolvesFrom: row.evolves_from ?? undefined,
      nationalPokedexNumbers: parseArray(row.national_pokedex_numbers),
    }));

  } catch (error) {
    // Sin Postgres configurado seguimos sirviendo las cartas del repositorio.
    console.error("❌ Error leyendo base de datos, uso el JSON local:", error);
    return loadLocalCards(setId);
  }
}