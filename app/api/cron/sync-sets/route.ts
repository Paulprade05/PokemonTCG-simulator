// app/api/cron/sync-sets/route.ts
// Disparador programado de la ingesta: busca sets nuevos o incompletos en la
// API de Pokémon TCG y los descarga a la base de datos.

import { NextResponse } from "next/server";
import { sincronizar } from "@/services/ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// El plan Hobby de Vercel corta las funciones a los 60 s (en Pro se puede
// subir). De ahí que la sincronización tenga que ser reanudable: en una sola
// ejecución no dan tiempo todos los sets, así que cada pasada descarga lo que
// puede —los más recientes primero— y la siguiente continúa por donde iba.
export const maxDuration = 60;

// Por debajo del maxDuration, dejando margen para cerrar y responder.
const PRESUPUESTO_MS = 45_000;

/**
 * Comparación en tiempo constante sin dependencias. Filtra por longitud (que no
 * es secreta) y luego recorre la cadena entera, de modo que el tiempo de
 * respuesta no delata cuántos caracteres del secreto se acertaron.
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

  // Vercel Cron envía "Authorization: Bearer $CRON_SECRET".
  const autorizacion = request.headers.get("authorization") ?? "";
  if (!igualEnTiempoConstante(autorizacion, `Bearer ${secreto}`)) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const soloSetId = searchParams.get("setId");

  try {
    const resumen = await sincronizar({ presupuestoMs: PRESUPUESTO_MS, soloSetId });

    // Los registros del cron son la única forma de comprobar que funcionó.
    console.log(
      `[sync-sets] nuevos=${resumen.setsNuevos.length}` +
        ` completados=${resumen.setsCompletados.length}` +
        ` cartas=${resumen.cartasInsertadas}` +
        ` pendientes=${resumen.pendientes.length}` +
        ` truncado=${resumen.truncadoPorTiempo}` +
        ` errores=${resumen.errores.length}`,
    );
    if (resumen.setsNuevos.length > 0) {
      console.log(`[sync-sets] sets nuevos: ${resumen.setsNuevos.join(", ")}`);
    }
    if (resumen.pendientes.length > 0) {
      const cola = resumen.pendientes.map((p) => `${p.id} (${p.enBD}/${p.total})`).join(", ");
      console.log(`[sync-sets] quedan por completar: ${cola}`);
    }

    return NextResponse.json(resumen);
  } catch (e: any) {
    console.error("[sync-sets] error:", e);
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}
