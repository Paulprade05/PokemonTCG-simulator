import { sql } from '@vercel/postgres';
import { NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';

export async function GET(request: Request) {
  try {
    // 1. Configuración: ¿Queremos forzar la recarga?
    // Si pones ?force=true en la URL, sobreescribirá todo. Si no, saltará lo existente.
    const { searchParams } = new URL(request.url);
    const forceUpdate = searchParams.get('force') === 'true';

    const dataDirectory = path.join(process.cwd(), 'src/data');
    const files = await fs.readdir(dataDirectory);
    const jsonFiles = files.filter(file => file.endsWith('.json'));

    console.log(`📂 Escaneando ${jsonFiles.length} archivos locales...`);

    let setsProcesados = 0;
    let setsSaltados = 0;

    for (const filename of jsonFiles) {
      const setId = filename.replace('.json', '');
      
      // 🛑 COMPROBACIÓN DE SEGURIDAD
      // Preguntamos si ya existen cartas de este set
      if (!forceUpdate) {
        const { rows } = await sql`SELECT count(*) FROM cards WHERE set_id = ${setId}`;
        const count = parseInt(rows[0].count);

        if (count > 0) {
          console.log(`⏭️ Saltando ${setId}: Ya tiene ${count} cartas en la base de datos.`);
          setsSaltados++;
          continue; // <--- ¡AQUÍ ESTÁ LA MAGIA! Pasa al siguiente archivo
        }
      }

      console.log(`💿 Procesando Set NUEVO: ${setId} ...`);

      // Leemos y procesamos el archivo solo si es necesario
      const filePath = path.join(dataDirectory, filename);
      const fileContents = await fs.readFile(filePath, 'utf8');
      const jsonData = JSON.parse(fileContents);
      const cards = Array.isArray(jsonData) ? jsonData : jsonData.data;

      if (!cards || cards.length === 0) continue;

      // Inserción masiva (Batch)
      // Para ir más rápido, procesamos carta a carta pero sin detenernos
      for (const card of cards) {
        const tcgplayer = JSON.stringify(card.tcgplayer || {});
        const images = JSON.stringify(card.images);
        const flavorText = card.flavorText || '';
        const number = String(card.number || '000');

        await sql`
          INSERT INTO cards (id, name, rarity, images, set_id, number, artist, flavor_text, tcgplayer)
          VALUES (
            ${card.id}, 
            ${card.name}, 
            ${card.rarity || 'Common'}, 
            ${images}, 
            ${setId}, 
            ${number},       
            ${card.artist || 'Desconocido'},       
            ${flavorText},   
            ${tcgplayer}
          )
          ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name,
            rarity = EXCLUDED.rarity,
            images = EXCLUDED.images,
            number = EXCLUDED.number,
            artist = EXCLUDED.artist,
            flavor_text = EXCLUDED.flavor_text,
            tcgplayer = EXCLUDED.tcgplayer;
        `;
      }
      
      setsProcesados++;
      console.log(`✅ ${setId} cargado correctamente.`);
    }

    return NextResponse.json({ 
      message: "Proceso completado", 
      setsNuevosCargados: setsProcesados,
      setsIgnorados: setsSaltados
    });

  } catch (error) {
    console.error("❌ Error:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}