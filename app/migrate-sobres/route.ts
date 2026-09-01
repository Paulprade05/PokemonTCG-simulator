import { sql } from "@vercel/postgres";
import { NextResponse } from "next/server";
import { requireAdmin } from "../_admin-auth";
import { SENTENCIAS_SOBRES } from "@/services/sobresEsquema";

/* ==================================================================== *
 * MIGRACIÓN DEL ALMACÉN DE FOTOS DE SOBRE
 * ====================================================================
 *
 * Crea `set_pack_art` (los bytes de cada foto) y `set_pack_art_estado` (la cola
 * del cron y la memoria de los negativos), con sus índices.
 *
 * ORDEN EN UN DESPLIEGUE NUEVO:
 *   1. /migrate-core      las cinco tablas base
 *   2. /migrate-schema    columnas ricas de `cards` e índices
 *   3. /migrate-social    `trade_offers`
 *   4. /migrate-mejoras   graduación, precios y bazar
 *   5. /migrate-sobres    <- este fichero
 *   6. /seed-database     las cartas del repositorio
 *
 * SOBRE UNA BASE QUE YA FUNCIONA se puede ejecutar sola y en cualquier momento:
 * no toca ninguna tabla existente, sólo crea las nuevas.
 *
 * Y EJECUTARLA NO ES URGENTE, que es la propiedad que de verdad importa aquí.
 * Hasta que se ejecute, la aplicación se comporta EXACTAMENTE como antes: las
 * 130 expansiones con foto estática la siguen enseñando (el manifiesto viaja en
 * el bundle y no pasa por Postgres) y las demás siguen con su sobre dibujado.
 * services/sobresBD.ts captura el `relation does not exist` y devuelve un mapa
 * vacío; la ruta de imagen responde 503 y el componente ni se inmuta. Es el
 * mismo criterio de /migrate-mejoras con `card_prices`.
 *
 * CADA SENTENCIA POR SU CUENTA, como en /migrate-core y /migrate-mejoras: que
 * un índice que no cuaja impida crear las tablas restantes es el peor resultado
 * posible de una migración. Aquí importa especialmente porque una de las dos
 * sentencias de índice es el UNIQUE de `fichero`, que es el cedazo de "un
 * fichero, una expansión": si no entra, las tablas tienen que quedar creadas
 * igualmente y el fallo tiene que salir en la respuesta para que se mire.
 */
export async function GET(request: Request) {
  const noAutorizado = requireAdmin(request);
  if (noAutorizado) return noAutorizado;

  const aplicadas: string[] = [];
  const fallidas: { sentencia: string; error: string }[] = [];

  for (const stmt of SENTENCIAS_SOBRES) {
    try {
      await sql.query(stmt);
      aplicadas.push(resumen(stmt));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("migrate-sobres:", resumen(stmt), msg);
      fallidas.push({ sentencia: resumen(stmt), error: msg });
    }
  }

  return NextResponse.json(
    {
      ok: fallidas.length === 0,
      aplicadas,
      fallidas,
      siguiente:
        "nada más: el tramo de sobres de /api/cron/sync-es empezará a llenar set_pack_art" +
        " en su próxima pasada. Para forzar una expansión concreta ahora mismo:" +
        " /api/cron/sync-es?setId=<id>",
    },
    { status: fallidas.length === 0 ? 200 : 207 },
  );
}

/** "CREATE TABLE set_pack_art" a partir de la sentencia, para el informe. */
function resumen(stmt: string): string {
  return (
    stmt
      .trim()
      .split("\n")[0]
      .replace(/\s+/g, " ")
      .replace(/\s*\($/, "")
      .trim() || stmt.slice(0, 60)
  );
}
