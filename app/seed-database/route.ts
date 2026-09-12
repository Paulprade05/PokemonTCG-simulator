import { sql } from '@vercel/postgres';
import { NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { requireAdmin } from '../_admin-auth';
import { upsertCards, upsertSets } from '@/services/ingest';

/* ==================================================================== *
 * LA SIEMBRA DESDE LOS JSON DEL REPOSITORIO
 * ====================================================================
 *
 * POR QUÉ ESCRIBE POR MEDIO DE services/ingest EN VEZ DE CON SU PROPIO INSERT:
 * esta ruta llegó a escribir 14 de las 28 columnas de `cards` y tiraba a la
 * basura lo que los JSON locales SÍ traen —`supertype` y `subtypes` los traen
 * las 6.779 cartas, las 6.779—, además de nationalPokedexNumbers, legalities,
 * regulationMark, evolvesFrom/evolvesTo, rules, level y convertedRetreatCost.
 * `abilities` y `resistances` incluso se calculaban en una variable que no
 * entraba en la sentencia.
 *
 * Eso no era cosmético: en un despliegue montado siguiendo el README (donde
 * /seed-database es el paso 5) `supertype` y `subtypes` quedaban NULL en TODAS
 * las expansiones, y los requisitos del mercado por supertipo, etapa y
 * evolución (utils/mercado.ts, categorías "supertipo", "etapa" y "evolucion")
 * no casaban con ninguna carta: ofertas imposibles de cumplir para cualquier
 * jugador, que es justo lo que npm test da por invariante. El detalle de carta
 * enseñaba además "Pokémon" en una carta de Entrenador.
 *
 * Al reutilizar `upsertCards` no hay una segunda lista de columnas que se pueda
 * quedar atrás: la siembra y la ingesta escriben la misma, por construcción.
 *
 * LOS JSON LOCALES NO TRAEN EL CAMPO `set` (comprobado: 0 de 6.779), y
 * `valoresCarta` lee `c.set?.id`. Sin inyectarlo, la reutilización escribiría
 * `set_id` NULL y las cartas no aparecerían en ninguna expansión: sería peor
 * que lo que había. Por eso el `set: { id: setId }` de más abajo no es un
 * adorno, es la condición para que esto funcione.
 *
 * VALORES DE RELLENO: los de la ingesta, que ahora son los mismos por venir del
 * mismo sitio. Antes esta ruta inventaba 'Desconocido' para el artista, '000'
 * para el número y '' para el texto de ambiente; eran peores que NULL: el
 * álbum y el detalle ya resuelven la falta de artista con su propio texto
 * (`detail.artist || "Desconocido"`), así que guardar el relleno en la base
 * sólo servía para meter un ilustrador que no existe en la columna por la que
 * filtra el mercado. Queda un tercer escritor con sus propios rellenos
 * ('Artista Desconocido', '???') y menos columnas todavía: `syncSetToDatabase`,
 * en app/action.ts, que no es de este fichero.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// El plan Hobby de Vercel corta a los 60 s. La siembra son ~6.800 cartas: antes
// iban de una en una (una ida y vuelta por carta) y no cabían ni de lejos, así
// que la ejecución moría a mitad de un set. Ahora van en lotes de 100 dentro de
// una sola sentencia, que es lo que hace que quepan; el presupuesto está por si
// aun así no llega.
export const maxDuration = 60;

// Por debajo del maxDuration, dejando margen para cerrar y responder.
const PRESUPUESTO_MS = 45_000;

// Antes de empezar un set hace falta margen para escribirlo entero: cortarse
// entre sus lotes es justo lo que dejaba sets a medias.
const MARGEN_SET_MS = 6_000;

export async function GET(request: Request) {
  const noAutorizado = requireAdmin(request);
  if (noAutorizado) return noAutorizado;

  const limite = Date.now() + PRESUPUESTO_MS;

  try {
    const { searchParams } = new URL(request.url);
    const forceUpdate = searchParams.get('force') === 'true';

    // RETOMAR POR DONDE SE QUEDÓ. Sin `force`, la comprobación de "ya completo"
    // basta para reanudar sola. Con `force` no hay tal comprobación: una pasada
    // truncada volvería a empezar por el mismo fichero y no avanzaría nunca, así
    // que se le dice por dónde seguir con el primer id de `sinComprobar` de la
    // respuesta anterior. Un id que no exista no siembra nada (y se avisa), en
    // vez de sembrarlo todo como si no se hubiera pedido.
    const desde = searchParams.get('desde');
    let saltandoHasta = !!desde;

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
    let cartasEscritas = 0;
    // Ficheros que esta pasada no ha llegado a abrir. Como nunca se corta a
    // mitad de un set, es TODO lo que puede quedar por hacer: llamar otra vez a
    // la ruta los retoma, y los que ya estén completos se saltan solos.
    let sinComprobar: string[] = [];
    let truncadoPorTiempo = false;

    for (let i = 0; i < jsonFiles.length; i++) {
      const filename = jsonFiles[i];
      const setId = filename.replace('.json', '');

      // Nada que abrir hasta llegar al fichero que pide `?desde=`.
      if (saltandoHasta) {
        if (setId !== desde) continue;
        saltandoHasta = false;
      }

      // SE PARA ANTES DE EMPEZAR UN SET, NUNCA A MITAD: la comprobación de
      // "ya sembrado" de abajo sólo sabe reanudar sets enteros.
      if (Date.now() + MARGEN_SET_MS > limite) {
        truncadoPorTiempo = true;
        sinComprobar = jsonFiles.slice(i).map(f => f.replace('.json', ''));
        console.warn(`⏱️ Sin tiempo: quedan ${sinComprobar.length} ficheros. Vuelve a llamar a la ruta para continuar.`);
        break;
      }

      // EL FICHERO SE LEE ANTES DE PREGUNTARLE A LA BASE: cuántas cartas trae es
      // justo el número contra el que hay que comparar lo que ya está guardado.
      const filePath = path.join(dataDirectory, filename);
      const fileContents = await fs.readFile(filePath, 'utf8');
      const jsonData = JSON.parse(fileContents);
      const cards = Array.isArray(jsonData) ? jsonData : jsonData.data;

      // En src/data viven también ficheros que no son de cartas (sobres.json,
      // sobres-bulbapedia.json): no traen lista y no son ninguna expansión.
      if (!Array.isArray(cards) || cards.length === 0) continue;

      // SI NO FORZAMOS, SALTAMOS LO QUE YA ESTÉ COMPLETO.
      //
      // Antes bastaba con que el set tuviera UNA carta para darlo por sembrado,
      // y como la ruta no cabía en el tiempo de una función, un set cortado a
      // mitad se quedaba incompleto para siempre: la llamada siguiente lo
      // saltaba precisamente por las cartas que sí le había dado tiempo a
      // escribir. Comparar contra las cartas que trae el fichero es lo que
      // vuelve la siembra reanudable, y como el upsert es idempotente, repetir
      // un set a medio escribir no duplica nada.
      //
      // OJO: esto mira CUÁNTAS cartas hay, no si están completas por columnas.
      // Una base sembrada con la versión vieja tiene el número correcto y las 14
      // columnas nuevas en NULL, y por aquí se saltaría: para rellenarlas hay
      // que pasar ?force=true una vez.
      if (!forceUpdate) {
        const { rows } = await sql`SELECT count(*)::int AS n FROM cards WHERE set_id = ${setId}`;
        const enBD = Number(rows[0].n);
        if (enBD >= cards.length) {
            console.log(`⏭️ Saltando ${setId} (${enBD}/${cards.length} ya en la BD).`);
            continue;
        }
      }

      console.log(`💿 Procesando Set: ${setId} ...`);

      // --- A) INSERTAR DATOS DEL SET (Si existe en el maestro) ---
      // La ficha del set va antes que sus cartas: así nunca quedan cartas
      // huérfanas si la ejecución se corta.
      const setInfo = allSets.find((s: any) => s.id === setId);
      if (setInfo) {
          await upsertSets([setInfo]);
          console.log(`   ✅ Info del Set ${setId} guardada en DB.`);
      } else {
          console.warn(`   ⚠️ El set ${setId} no aparece en all-sets.json`);
      }

      // --- B) INSERTAR CARTAS ---
      // El `set` que `valoresCarta` necesita y el JSON no trae. El nombre del
      // fichero es la fuente de la verdad del set (comprobado: el prefijo del id
      // de las 6.779 cartas coincide con su fichero), así que se impone.
      const cartasConSet = cards.map((card) => ({ ...card, set: { id: setId } }));
      cartasEscritas += await upsertCards(cartasConSet);

      setsProcesados++;
    }

    if (saltandoHasta) {
      console.warn(`⚠️ ?desde=${desde} no coincide con ningún fichero de src/data: no se ha sembrado nada.`);
    }

    return NextResponse.json({
        message: "Base de datos actualizada (Sets + Cartas)",
        setsProcessed: setsProcesados,
        cartasEscritas,
        truncadoPorTiempo,
        sinComprobar,
    });

  } catch (error) {
    console.error("❌ Error:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
