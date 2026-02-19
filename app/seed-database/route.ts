import { sql } from '@vercel/postgres';
import { NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const forceUpdate = searchParams.get('force') === 'true';

    const dataDirectory = path.join(process.cwd(), 'src/data');
    
    // 1. CARGAMOS EL MAESTRO DE SETS
    const setsFilePath = path.join(dataDirectory, 'all-sets.json');
    let allSets = [];
    try {
        const setsFileContent = await fs.readFile(setsFilePath, 'utf8');
        allSets = JSON.parse(setsFileContent);
        console.log(`📚 Maestro de Sets cargado: ${allSets.length} sets disponibles.`);
    } catch (e) {
        console.error("⚠️ No se encontró src/data/all-sets.json. Los sets no se actualizarán.");
    }

    // 2. LEEMOS LOS ARCHIVOS DE CARTAS
    const files = await fs.readdir(dataDirectory);
    const jsonFiles = files.filter(file => file.endsWith('.json') && file !== 'all-sets.json');

    console.log(`📂 Escaneando ${jsonFiles.length} archivos de cartas...`);
    let setsProcesados = 0;

    for (const filename of jsonFiles) {
      const setId = filename.replace('.json', '');
      
      // Si NO forzamos, saltamos lo que ya existe
      if (!forceUpdate) {
        const { rows } = await sql`SELECT count(*) FROM cards WHERE set_id = ${setId}`;
        if (parseInt(rows[0].count) > 0) {
            console.log(`⏭️ Saltando ${setId} (Ya existe).`);
            continue;
        }
      }

      console.log(`💿 Procesando Set: ${setId} ...`);

      // --- A) INSERTAR DATOS DEL SET (Si existe en el maestro) ---
      const setInfo = allSets.find((s: any) => s.id === setId);
      if (setInfo) {
          const legalities = JSON.stringify(setInfo.legalities || {});
          const images = JSON.stringify(setInfo.images || {});
          
          await sql`
            INSERT INTO sets (id, name, series, printed_total, total, legalities, ptcgo_code, release_date, images)
            VALUES (
                ${setInfo.id},
                ${setInfo.name},
                ${setInfo.series},
                ${setInfo.printedTotal},
                ${setInfo.total},
                ${legalities},
                ${setInfo.ptcgoCode || null},
                ${setInfo.releaseDate},
                ${images}
            )
            ON CONFLICT (id) DO UPDATE SET
                name = EXCLUDED.name,
                series = EXCLUDED.series,
                total = EXCLUDED.total,
                release_date = EXCLUDED.release_date,
                images = EXCLUDED.images;
          `;
          console.log(`   ✅ Info del Set ${setId} guardada en DB.`);
      } else {
          console.warn(`   ⚠️ El set ${setId} no aparece en all-sets.json`);
      }

      // --- B) INSERTAR CARTAS ---
      const filePath = path.join(dataDirectory, filename);
      const fileContents = await fs.readFile(filePath, 'utf8');
      const jsonData = JSON.parse(fileContents);
      const cards = Array.isArray(jsonData) ? jsonData : jsonData.data;

      if (!cards || cards.length === 0) continue;

      for (const card of cards) {
        const tcgplayer = JSON.stringify(card.tcgplayer || {});
        const images = JSON.stringify(card.images);
        const flavorText = card.flavorText || '';
        const number = String(card.number || '000');
        
        const hp = card.hp || null;
        const types = JSON.stringify(card.types || []);
        const attacks = JSON.stringify(card.attacks || []);
        const weaknesses = JSON.stringify(card.weaknesses || []);
        const retreatCost = JSON.stringify(card.retreatCost || []);

        // Guardamos también las habilidades y resistencia si existen en el JSON
        const abilities = JSON.stringify(card.abilities || []);
        const resistance = JSON.stringify(card.resistances || []);

        await sql`
          INSERT INTO cards (id, name, rarity, images, set_id, number, artist, flavor_text, tcgplayer, hp, types, attacks, weaknesses, retreat_cost)
          VALUES (
            ${card.id}, 
            ${card.name}, 
            ${card.rarity || 'Common'}, 
            ${images}, 
            ${setId}, 
            ${number},       
            ${card.artist || 'Desconocido'},       
            ${flavorText},   
            ${tcgplayer},
            ${hp},
            ${types},
            ${attacks},
            ${weaknesses},
            ${retreatCost}
          )
          ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name,
            rarity = EXCLUDED.rarity,
            images = EXCLUDED.images,
            hp = EXCLUDED.hp,
            attacks = EXCLUDED.attacks;
        `;
      }
      setsProcesados++;
    }

    return NextResponse.json({ 
        message: "Base de datos actualizada (Sets + Cartas)", 
        setsProcessed: setsProcesados 
    });

  } catch (error) {
    console.error("❌ Error:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
