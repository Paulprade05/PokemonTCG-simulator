// app/api/cron/sync-precios/route.ts
// Disparador de la ingesta de PRECIOS REALES: baja de TCGdex el precio en euros
// que Cardmarket da a las cartas caras y lo guarda en `card_prices`, de donde lo
// lee services/preciosBD.ts para ajustar lo que paga la tienda.
//
// OJO, ESTA RUTA NO ESTÁ EN vercel.json Y NO DEBE ESTARLO. El plan Hobby permite
// DOS cron jobs y los dos están ya cogidos (sync-sets a las 05:00 y sync-es a
// las 07:00); declarar un tercero no es que no se ejecute, es que HACE FALLAR EL
// DESPLIEGUE entero. La ejecución diaria de los precios va encadenada al final
// de /api/cron/sync-es, que casi todas las noches termina pronto y le cede sus
// sobras — está explicado en el comentario de aquella ruta.
//
// ENTONCES ¿PARA QUÉ EXISTE ESTE FICHERO? Para lo que el encadenado no puede
// hacer: darle a los precios un presupuesto ENTERO de 45 s cuando hace falta
// (una expansión recién ingerida son ~50 cartas caras que el goteo nocturno
// tardaría días en alcanzar) y forzar una expansión concreta con `?setId=`.
// Se dispara a mano, con el mismo `Authorization: Bearer $CRON_SECRET` que
// mandaría Vercel, o desde un programador externo si algún día se quiere.

import { NextResponse } from "next/server";
import { sincronizarPrecios } from "@/services/preciosIngest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Mismo tope que los otros dos crons: 60 s en el plan Hobby.
export const maxDuration = 60;

// Por debajo del maxDuration, dejando margen para cerrar y responder.
const PRESUPUESTO_MS = 45_000;

/**
 * Comparación en tiempo constante, calcada de sync-sets y sync-es: el tiempo de
 * respuesta no puede delatar cuántos caracteres del secreto se han acertado.
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

  // `?setId=sv08` fuerza una expansión concreta y se salta la cola. Es la vía
  // para tasar hoy una expansión que acaba de entrar, sin esperar a que el
  // goteo nocturno llegue hasta ella.
  const { searchParams } = new URL(request.url);
  const soloSetId = searchParams.get("setId");

  try {
    const resumen = await sincronizarPrecios({ presupuestoMs: PRESUPUESTO_MS, soloSetId });

    console.log(
      `[sync-precios] sets=${resumen.setsRevisados.length}` +
        ` cartas=${resumen.revisados}` +
        ` actualizados=${resumen.actualizados}` +
        ` sinCambios=${resumen.sinCambios}` +
        ` sinPrecio=${resumen.sinPrecio}` +
        ` sinFuente=${resumen.sinFuente}` +
        ` truncado=${resumen.truncadoPorTiempo}` +
        ` errores=${resumen.errores.length + resumen.erroresOmitidos}`,
    );
    /* Los rechazos van como AVISO porque son lo único que pide una persona, y
     * significan lo mismo que en sync-es: el id de TCGdex de esa expansión se
     * adivinó mal y hay que ponerlo a mano en src/data/es/mapa-sets.json. Que
     * la guardia los corte es justo lo que impide que una carta acabe con el
     * precio de otra, que aquí sería dinero de verdad mal pagado. */
    if (resumen.setsRechazados.length > 0) {
      const lista = resumen.setsRechazados.map((s) => `${s.setId}: ${s.motivo}`).join(" · ");
      console.warn(`[sync-precios] rechazados: ${lista}`);
    }
    for (const e of resumen.errores) console.error(`[sync-precios] ${e}`);
    if (resumen.erroresOmitidos > 0) {
      console.error(`[sync-precios] y ${resumen.erroresOmitidos} errores más, omitidos`);
    }

    return NextResponse.json(resumen);
  } catch (e: unknown) {
    console.error("[sync-precios] error:", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
