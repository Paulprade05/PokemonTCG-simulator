import { sql } from "@vercel/postgres";
import { NextResponse } from "next/server";
import { requireAdmin } from "../_admin-auth";
import { GUARDAS_DE_DINERO, SENTENCIAS_MEJORAS } from "@/services/esquemaMejoras";

/* ==================================================================== *
 * MIGRACIÓN DE LAS FUNCIONES NUEVAS
 * ====================================================================
 *
 * Crea las cuatro tablas que no existían: `graded_cards` (graduación),
 * `binder_slots` (el archivador de la vitrina), `card_prices` (precios reales
 * de Cardmarket) y `bazar_listings` (bazar entre jugadores), con sus índices.
 *
 * ORDEN EN UN DESPLIEGUE NUEVO:
 *   1. /migrate-core      las cinco tablas base
 *   2. /migrate-schema    columnas ricas de `cards` e índices
 *   3. /migrate-social    `trade_offers`
 *   4. /migrate-mejoras   <- este fichero
 *   5. /migrate-sobres    el almacén de fotos de sobre
 *   6. /seed-database     las cartas del repositorio
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
 *
 * `?guardas=1` — LAS GUARDAS DE DINERO, SÓLO SI SE PIDEN. Añade a `users`,
 * `user_collection` y `bazar_listings` los CHECK de GUARDAS_DE_DINERO
 * (services/esquemaMejoras.ts explica qué son y por qué no se ponen solos). Sin
 * el parámetro esta ruta hace exactamente lo de siempre.
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

  const conGuardas = new URL(request.url).searchParams.get("guardas") === "1";
  const guardas = conGuardas ? await ponerGuardas() : undefined;
  const guardasBien = !guardas || guardas.every((g) => g.estado === "puesta" || g.estado === "ya-estaba");

  return NextResponse.json(
    {
      ok: fallidas.length === 0 && guardasBien,
      aplicadas,
      fallidas,
      ...(guardas ? { guardas } : {}),
      siguiente:
        "nada más: /api/cron/sync-precios empezará a llenar card_prices en su próxima pasada",
    },
    { status: fallidas.length === 0 && guardasBien ? 200 : 207 },
  );
}

type EstadoDeGuarda =
  /** Se ha creado y validado ahora. */
  | "puesta"
  /** Ya existía una restricción con ese nombre en esa tabla. */
  | "ya-estaba"
  /** Hay filas que la incumplen: NO se ha tocado nada. `filas` dice cuántas. */
  | "hay-filas-que-la-incumplen"
  /** Se creó, pero la validación falló: vigila las escrituras nuevas, no las viejas. */
  | "puesta-sin-validar"
  | "error";

interface LineaDeGuarda {
  guarda: string;
  tabla: string;
  estado: EstadoDeGuarda;
  /** Cuántas filas la incumplen, cuando es ése el motivo de no ponerla. */
  filas?: number;
  error?: string;
}

/**
 * Pone las guardas que falten, una a una.
 *
 * NUNCA SE PONE UNA GUARDA SOBRE DATOS QUE LA INCUMPLEN. Primero se cuentan las
 * filas que la violarían; si hay alguna, se informa y no se toca la tabla. No
 * es exceso de celo: un CHECK creado como NOT VALID no mira las filas viejas,
 * pero sí toda escritura NUEVA sobre ellas, así que una cuenta que ya tuviera
 * el saldo en negativo (el fichero de acciones documenta endpoints antiguos que
 * lo permitían) dejaría de poder recibir un abono —el UPDATE la dejaría en un
 * negativo menor, que sigue violando el CHECK— y con él fallaría entera la
 * compra de quien le estuviera pagando. Antes de poner la guarda hay que
 * arreglar esas filas a mano, y eso lo decide una persona.
 *
 * NOT VALID y luego VALIDATE, en dos sentencias: el ADD CONSTRAINT así sólo
 * toma su candado exclusivo un instante (no recorre la tabla), y el recorrido
 * lo hace VALIDATE con un candado que deja leer y escribir.
 */
async function ponerGuardas(): Promise<LineaDeGuarda[]> {
  const informe: LineaDeGuarda[] = [];
  for (const g of GUARDAS_DE_DINERO) {
    const linea = { guarda: g.nombre, tabla: g.tabla };
    try {
      const { rows: ya } = await sql.query(
        `SELECT 1 FROM pg_constraint WHERE conname = $1 AND conrelid = to_regclass($2)`,
        [g.nombre, g.tabla],
      );
      if (ya.length > 0) {
        informe.push({ ...linea, estado: "ya-estaba" });
        continue;
      }
      // Tabla, nombre y condición salen de una constante del repositorio, nunca
      // de la petición: por eso pueden ir interpolados en el texto.
      const { rows: malas } = await sql.query(
        `SELECT count(*)::int AS n FROM ${g.tabla} WHERE NOT (${g.condicion})`,
      );
      const filas = Number(malas[0]?.n ?? 0);
      if (filas > 0) {
        informe.push({ ...linea, estado: "hay-filas-que-la-incumplen", filas });
        continue;
      }
      await sql.query(
        `ALTER TABLE ${g.tabla} ADD CONSTRAINT ${g.nombre} CHECK (${g.condicion}) NOT VALID`,
      );
      try {
        await sql.query(`ALTER TABLE ${g.tabla} VALIDATE CONSTRAINT ${g.nombre}`);
        informe.push({ ...linea, estado: "puesta" });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("migrate-mejoras: validar", g.nombre, msg);
        informe.push({ ...linea, estado: "puesta-sin-validar", error: msg });
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("migrate-mejoras: guarda", g.nombre, msg);
      informe.push({ ...linea, estado: "error", error: msg });
    }
  }
  return informe;
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
