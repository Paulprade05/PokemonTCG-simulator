// app/api/cron/sync-sets/route.ts
// Disparador programado de la ingesta: busca sets nuevos o incompletos en la
// API de Pokémon TCG y los descarga a la base de datos.

import { NextResponse } from "next/server";
import { sql } from "@vercel/postgres";
import { sincronizar } from "@/services/ingest";
import { SETS_CON_ES } from "@/services/idioma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// El plan Hobby de Vercel corta las funciones a los 60 s (en Pro se puede
// subir). De ahí que la sincronización tenga que ser reanudable: en una sola
// ejecución no dan tiempo todos los sets, así que cada pasada descarga lo que
// puede —los más recientes primero— y la siguiente continúa por donde iba.
export const maxDuration = 60;

// Por debajo del maxDuration, dejando margen para cerrar y responder.
const PRESUPUESTO_MS = 45_000;

/* ==================================================================== *
 * AVISO DE COBERTURA DEL ESPAÑOL
 * ====================================================================
 *
 * POR QUÉ EXISTE: esta ruta hace crecer el catálogo sola, pero el diccionario
 * español (src/data/es) es un artefacto GENERADO A MANO con
 * scripts/generar-diccionario-es.mjs. Nada conectaba las dos cosas, así que
 * cada expansión que llegaba por aquí nacía en inglés y en silencio — y como la
 * tienda ordena por fecha descendente, salía la PRIMERA. El resultado fue un
 * usuario convencido de que el idioma estaba roto cuando funcionaba
 * perfectamente, y una tarde de diagnóstico para descubrirlo.
 *
 * QUÉ SE AVISA Y QUÉ NO: sólo lo que se ha ingerido EN ESTA PASADA, por su
 * nombre. El cron sincroniza las ~174 expansiones del catálogo y más de un
 * centenar no tiene español (las anteriores a 2020 están fuera del alcance de
 * la app), así que listarlas todas sería ruido que nadie leería. Del resto sólo
 * va la cuenta, que es lo que deja ver la deriva sin ensuciar el registro.
 */
async function cobertura(setsNuevos: string[]) {
  const nuevosSinEs = setsNuevos.filter((id) => !SETS_CON_ES.has(id));
  let enBD: number | null = null;
  let sinEsEnBD: number | null = null;
  try {
    const { rows } = await sql`SELECT id FROM sets`;
    enBD = rows.length;
    sinEsEnBD = rows
      .map((r) => String(r.id))
      .filter((id) => !SETS_CON_ES.has(id)).length;
  } catch {
    // La cuenta global es informativa: si la consulta falla, el aviso de las
    // recién ingeridas —que es el accionable— sale igual.
  }
  return { nuevosSinEs, conEspanol: SETS_CON_ES.size, enBD, sinEsEnBD };
}

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

    const idioma = await cobertura(resumen.setsNuevos);
    if (idioma.nuevosSinEs.length > 0) {
      // console.warn y no console.log: en Vercel sale marcado como aviso, que es
      // lo que hace que se vea entre las líneas normales del cron.
      console.warn(
        `[sync-sets] SIN ESPAÑOL: ${idioma.nuevosSinEs.join(", ")}` +
          " · se verán en inglés (marcadas con «EN» en la tienda)." +
          " Para traducirlas: añádelas al mapa SETS de" +
          " scripts/generar-diccionario-es.mjs y ejecuta" +
          ` node scripts/generar-diccionario-es.mjs --set ${idioma.nuevosSinEs[0]}`,
      );
    }
    if (idioma.sinEsEnBD !== null) {
      console.log(
        `[sync-sets] idioma: ${idioma.conEspanol} expansiones con español` +
          ` · ${idioma.sinEsEnBD} de las ${idioma.enBD} de la base sin él`,
      );
    }

    return NextResponse.json({ ...resumen, idioma });
  } catch (e: any) {
    console.error("[sync-sets] error:", e);
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}
