import { sql } from "@vercel/postgres";
import { NextResponse } from "next/server";
import { requireAdmin } from "../_admin-auth";
import { SENTENCIAS_MEJORAS } from "@/services/esquemaMejoras";

/* ==================================================================== *
 * MIGRACIÓN DE LAS FUNCIONES NUEVAS
 * ====================================================================
 *
 * Crea las tres tablas que no existían: `graded_cards` (graduación),
 * `card_prices` (precios reales de Cardmarket) y `bazar_listings` (bazar entre
 * jugadores), con sus índices.
 *
 * ORDEN EN UN DESPLIEGUE NUEVO:
 *   1. /migrate-core      las cinco tablas base
 *   2. /migrate-schema    columnas ricas de `cards` e índices
 *   3. /migrate-social    `trade_offers`
 *   4. /migrate-mejoras   <- este fichero
 *   5. /seed-database     las cartas del repositorio
 *
 * SOBRE UNA BASE QUE YA FUNCIONA se puede ejecutar sola y en cualquier momento:
 * no toca ninguna tabla existente, sólo crea las nuevas. Hasta que se ejecute,
 * las funciones nuevas se apagan solas en vez de romperse — los módulos que
 * leen estas tablas capturan el fallo y devuelven vacío, igual que hace
 * services/idiomaBD.ts con las traducciones.
 *
 * CADA SENTENCIA POR SU CUENTA, como en /migrate-core y NO como en
 * /migrate-schema: que un índice que no cuaja impida crear las tablas
 * restantes es el peor resultado posible de una migración.
 */
export async function GET(request: Request) {
  const noAutorizado = requireAdmin(request);
  if (noAutorizado) return noAutorizado;

  const aplicadas: string[] = [];
  const fallidas: { sentencia: string; error: string }[] = [];

  for (const stmt of SENTENCIAS_MEJORAS) {
    try {
      await sql.query(stmt);
      aplicadas.push(resumen(stmt));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("migrate-mejoras:", resumen(stmt), msg);
      fallidas.push({ sentencia: resumen(stmt), error: msg });
    }
  }

  return NextResponse.json(
    {
      ok: fallidas.length === 0,
      aplicadas,
      fallidas,
      siguiente:
        "nada más: /api/cron/sync-precios empezará a llenar card_prices en su próxima pasada",
    },
    { status: fallidas.length === 0 ? 200 : 207 },
  );
}

/** "CREATE TABLE graded_cards" a partir de la sentencia, para el informe. */
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
