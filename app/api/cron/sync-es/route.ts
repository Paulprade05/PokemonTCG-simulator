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
import { sincronizarPrecios, type ResumenPrecios } from "@/services/preciosIngest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Mismo tope que el otro cron: 60 s en el plan Hobby.
export const maxDuration = 60;

// Por debajo del maxDuration, dejando margen para cerrar y responder.
const PRESUPUESTO_MS = 45_000;

/* ==================================================================== *
 * POR QUÉ EL CRON DE TRADUCCIONES BAJA PRECIOS
 * ====================================================================
 *
 * Si has llegado aquí preguntándote qué pinta `sincronizarPrecios` dentro de
 * una ruta que se llama sync-es: no cabe en ningún otro sitio.
 *
 * EL PLAN HOBBY DE VERCEL PERMITE DOS CRON JOBS. vercel.json ya declara los dos
 * que hay: sync-sets a las 05:00 (hace crecer el catálogo) y sync-es a las
 * 07:00 (traduce lo que aquél trajo). Un TERCERO no es que se ignore: el
 * despliegue FALLA. Así que la elección real no era "¿dónde queda más limpio?"
 * sino "¿encadenado, o los precios no se bajan nunca?".
 *
 * EL REPARTO. Las traducciones son el trabajo declarado de esta ruta y van
 * primero, con PRESUPUESTO_TRADUCCIONES_MS. Pero ese número es un TECHO, no un
 * gasto: `sincronizarTraducciones` vuelve en cuanto agota su cola, y la mayoría
 * de las noches no hay nada que traducir —la huella sha256 de cada expansión
 * coincide y se saltan todas sin bajar una sola carta—, así que termina en unos
 * pocos segundos y deja casi el presupuesto entero. Lo que sobre hasta
 * PRESUPUESTO_MS es lo que se le pasa a los precios, medido contra el reloj y
 * no estimado. Las noches en que sí hay traducciones nuevas, éstas se llevan lo
 * suyo y los precios bajan menos cartas: es el orden de prioridad correcto,
 * porque una expansión sin traducir se ve en la tienda y un precio de ayer no
 * lo nota nadie (`avg30` es una media de 30 días).
 *
 * LOS PRECIOS NUNCA PUEDEN TUMBAR ESTA RUTA. Van en su propio try/catch: para
 * cuando se lanzan, las traducciones ya están escritas y perderlas por un fallo
 * de TCGdex en la segunda mitad sería absurdo. Un fallo sale en `precios.error`
 * y la respuesta sigue siendo 200.
 *
 * SI ALGÚN DÍA HAY PLAN PRO: sáquense a /api/cron/sync-precios (que ya existe,
 * con su propio presupuesto de 45 s) y decláresele su hora en vercel.json.
 * Entonces todo este encadenado se puede quitar de aquí.
 */
const PRESUPUESTO_TRADUCCIONES_MS = 30_000;

/** Por debajo de esto los precios no arrancan: ver PRESUPUESTO_MINIMO_MS allí. */
const MINIMO_PRECIOS_MS = 9_000;

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

  // El reloj de TODA la petición, no sólo el de las traducciones: es lo que
  // permite saber cuánto sobra de verdad para los precios.
  const arranque = Date.now();

  try {
    const resumen = await sincronizarTraducciones({
      presupuestoMs: PRESUPUESTO_TRADUCCIONES_MS,
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

    /* EL ENCADENADO. Ver el comentario largo de arriba: aquí es donde el cron
     * de traducciones gasta sus sobras en bajar precios de Cardmarket.
     *
     * Con `?setId=` NO se encadena: esa vía es la de corregir a mano UNA
     * expansión y quien la dispara está esperando el resultado de esa
     * expansión, no que la petición se quede otros treinta segundos haciendo
     * otra cosa. Para forzar precios de una expansión está
     * /api/cron/sync-precios?setId=, que hace exactamente eso. */
    let precios: ResumenPrecios | { omitido: string } | { error: string } | null = null;
    const restanteMs = PRESUPUESTO_MS - (Date.now() - arranque);
    if (soloSetId) {
      precios = { omitido: "con ?setId= sólo se sincronizan traducciones" };
    } else if (restanteMs < MINIMO_PRECIOS_MS) {
      precios = { omitido: `sólo quedaban ${restanteMs} ms del presupuesto` };
      console.log(`[sync-precios] sin sobras esta noche (${restanteMs} ms)`);
    } else {
      try {
        const p = await sincronizarPrecios({ presupuestoMs: restanteMs });
        precios = p;
        console.log(
          `[sync-precios] (encadenado, ${restanteMs} ms)` +
            ` sets=${p.setsRevisados.length}` +
            ` cartas=${p.revisados}` +
            ` actualizados=${p.actualizados}` +
            ` sinCambios=${p.sinCambios}` +
            ` sinPrecio=${p.sinPrecio}` +
            ` sinFuente=${p.sinFuente}` +
            ` truncado=${p.truncadoPorTiempo}` +
            ` errores=${p.errores.length + p.erroresOmitidos}`,
        );
        if (p.setsRechazados.length > 0) {
          const lista = p.setsRechazados.map((s) => `${s.setId}: ${s.motivo}`).join(" · ");
          console.warn(`[sync-precios] rechazados: ${lista}`);
        }
        for (const e of p.errores) console.error(`[sync-precios] ${e}`);
      } catch (e: unknown) {
        // Las traducciones ya están escritas: un fallo aquí no puede convertir
        // esta petición en un 500 ni borrar lo que sí funcionó.
        const mensaje = e instanceof Error ? e.message : String(e);
        console.error("[sync-precios] error encadenado:", mensaje);
        precios = { error: mensaje };
      }
    }

    return NextResponse.json({ ...resumen, precios });
  } catch (e: unknown) {
    console.error("[sync-es] error:", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
