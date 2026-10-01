// app/api/cron/sync-sets/route.ts
// Disparador programado de la ingesta: busca sets nuevos o incompletos en la
// API de Pokémon TCG y los descarga a la base de datos.

import { NextResponse } from "next/server";
import { sql } from "@vercel/postgres";
import { sincronizar } from "@/services/ingest";
import { setsConEspanol } from "@/services/idiomaBD";
import { requireCron } from "@/app/_admin-auth";

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
  // Las dos vías: los ficheros del despliegue y lo que haya traído el cron de
  // traducciones. Sin esto, avisaría de expansiones que ya están traducidas.
  const conEs = await setsConEspanol();
  const nuevosSinEs = setsNuevos.filter((id) => !conEs.has(id));
  let enBD: number | null = null;
  let sinEsEnBD: number | null = null;
  try {
    const { rows } = await sql`SELECT id FROM sets`;
    enBD = rows.length;
    sinEsEnBD = rows
      .map((r) => String(r.id))
      .filter((id) => !conEs.has(id)).length;
  } catch {
    // La cuenta global es informativa: si la consulta falla, el aviso de las
    // recién ingeridas —que es el accionable— sale igual.
  }
  return { nuevosSinEs, conEspanol: conEs.size, enBD, sinEsEnBD };
}

export async function GET(request: Request) {
  // La puerta es la de las tres rutas de cron y vive en app/_admin-auth.ts:
  // sin CRON_SECRET utilizable (recortado y de 16 caracteres o más) la ruta se
  // cierra con 503, nunca queda abierta a Internet.
  const noAutorizado = requireCron(request);
  if (noAutorizado) return noAutorizado;

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
    /* RAREZAS QUE EL JUEGO NO CONOCE. Como AVISO y con sus nombres, porque es
     * lo único de esta ruta que pide una decisión de economía: esas cartas se
     * venden a la tarifa de respaldo (menos que una Rara), casi ninguna sale en
     * sobre estándar ni premium y el mercado no las admite. Hasta ahora
     * entraban en silencio. El recuento de toda la base está en /db-stats. */
    if (resumen.rarezasDesconocidas.length > 0) {
      const lista = resumen.rarezasDesconocidas
        .map((r) => `${JSON.stringify(r.rareza)} ×${r.cartas}`)
        .join(", ");
      console.warn(
        `[sync-sets] RAREZAS FUERA DE TABLA (sin precio ni rango en utils/constanst.ts): ${lista}`,
      );
    }
    if (resumen.cartasSinRareza > 0) {
      console.warn(
        `[sync-sets] ${resumen.cartasSinRareza} cartas llegaron sin rareza y se han guardado como 'Common'`,
      );
    }

    const idioma = await cobertura(resumen.setsNuevos);
    if (idioma.nuevosSinEs.length > 0) {
      // console.warn y no console.log: en Vercel sale marcado como aviso, que es
      // lo que hace que se vea entre las líneas normales del cron.
      console.warn(
        `[sync-sets] SIN ESPAÑOL: ${idioma.nuevosSinEs.join(", ")}` +
          " · se verán en inglés (marcadas con «EN» en la tienda) hasta que" +
          " /api/cron/sync-es las alcance. Si mañana siguen aquí, mira su" +
          " `estado` en set_translations: 'sin_fuente' o '404' significan que" +
          " el candidato de TCGdex no vale y hay que mapearlas a mano en" +
          " src/data/es/mapa-sets.json.",
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
