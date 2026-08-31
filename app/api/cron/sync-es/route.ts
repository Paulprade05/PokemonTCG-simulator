// app/api/cron/sync-es/route.ts
// Disparador programado de la ingesta de TRADUCCIONES: mira si TCGdex ya tiene
// en español alguna de las expansiones que la app enseña en inglés, y la guarda
// en Postgres para que se aplique sin desplegar.
//
// Va DESPUÉS de /api/cron/sync-sets (05:00) y no encadenado a él: aquél trunca
// por tiempo casi todas las noches, así que encadenar éste sería matarlo de
// hambre. Los nombres ingleses contra los que empareja salen de la tabla
// `cards`, o sea de lo que aquél haya ingerido.

import { NextResponse } from "next/server";
import { sincronizarTraducciones } from "@/services/idiomaIngest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Mismo tope que el otro cron: 60 s en el plan Hobby.
export const maxDuration = 60;

// Por debajo del maxDuration, dejando margen para cerrar y responder.
const PRESUPUESTO_MS = 45_000;

/**
 * Comparación en tiempo constante, calcada de sync-sets: el tiempo de respuesta
 * no puede delatar cuántos caracteres del secreto se han acertado.
 */
function igualEnTiempoConstante(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diferencia = 0;
  for (let i = 0; i < a.length; i++) diferencia |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diferencia === 0;
}

export async function GET(request: Request) {
  const secreto = process.env.CRON_SECRET;
  // Sin secreto configurado la ruta se cierra: nunca queda abierta a Internet.
  if (!secreto) {
    return NextResponse.json(
      { error: "CRON_SECRET no está configurado: sincronización deshabilitada." },
      { status: 503 },
    );
  }

  const autorizacion = request.headers.get("authorization") ?? "";
  if (!igualEnTiempoConstante(autorizacion, `Bearer ${secreto}`)) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  // `?setId=me6` fuerza una expansión concreta, saltándose la cola y la huella.
  // Es la vía para corregir a mano una que se quedó mal sin esperar a mañana.
  const { searchParams } = new URL(request.url);
  const soloSetId = searchParams.get("setId");

  try {
    const resumen = await sincronizarTraducciones({
      presupuestoMs: PRESUPUESTO_MS,
      soloSetId,
    });

    console.log(
      `[sync-es] revisados=${resumen.revisados.length}` +
        ` actualizados=${resumen.actualizados.length}` +
        ` sinCambios=${resumen.sinCambios}` +
        ` rechazados=${resumen.rechazados.length}` +
        ` truncado=${resumen.truncadoPorTiempo}` +
        ` errores=${resumen.errores.length}`,
    );
    if (resumen.actualizados.length > 0) {
      const lista = resumen.actualizados
        .map((a) => `${a.setId} (${a.antes} -> ${a.ahora})`)
        .join(", ");
      console.log(`[sync-es] traducciones nuevas: ${lista}`);
    }
    /* Los rechazos van como AVISO porque son lo único que pide una persona: casi
     * siempre significan que el id de TCGdex se adivinó mal y hay que ponerlo a
     * mano en src/data/es/mapa-sets.json. Que la guardia los corte es justo lo
     * que impide que una expansión salga traducida con los nombres de otra. */
    if (resumen.rechazados.length > 0) {
      const lista = resumen.rechazados.map((r) => `${r.setId}: ${r.motivo}`).join(" · ");
      console.warn(`[sync-es] rechazados: ${lista}`);
    }
    for (const e of resumen.errores) console.error(`[sync-es] ${e}`);

    return NextResponse.json(resumen);
  } catch (e: unknown) {
    console.error("[sync-es] error:", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
