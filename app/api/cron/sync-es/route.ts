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
import { sincronizarSobres, type ResumenSobres } from "@/services/sobresIngest";
import { ESTADOS_SOBRE } from "@/services/sobresEsquema";

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
 *
 * ====================================================================
 * Y POR QUÉ TAMBIÉN BAJA FOTOS DE SOBRE
 * ====================================================================
 *
 * Por lo mismo: no cabe en ningún otro sitio. Un tercer cron en vercel.json no
 * se ignora, HACE FALLAR EL DESPLIEGUE.
 *
 * POR QUÉ AQUÍ Y NO COLGADO DE sync-sets, que es quien descubre las expansiones
 * nuevas y por tanto el sitio "natural": porque aquél TRUNCA POR TIEMPO CASI
 * TODAS LAS NOCHES —lo dice su propia cabecera y lo saca por el log en cada
 * ejecución— y colgarle trabajo encima es matarlo. Éste, en cambio, termina
 * pronto la mayoría de las noches: si la huella sha256 de cada expansión
 * coincide, se saltan todas sin bajar una sola carta.
 *
 * DÓNDE EXACTAMENTE, QUE IMPORTA MÁS DE LO QUE PARECE: ENTRE las traducciones y
 * los precios, nunca después. `sincronizarPrecios` recibe el tiempo que quede y
 * baja precios HASTA AGOTARLO (services/preciosIngest.ts lo dice con esas
 * palabras): se come todo lo que se le dé. Un tramo colocado detrás no se
 * ejecutaría JAMÁS, ni una noche. Y el orden es además el correcto por
 * prioridad, con el mismo argumento de arriba: un sobre nuevo se ve en la
 * portada y un precio de ayer no lo nota nadie.
 *
 * CUÁNTO SE LLEVA: muy poco, y no por prudencia sino porque no hace falta más.
 * Salen 6-10 expansiones AL AÑO, así que en régimen permanente el trabajo real
 * son ~0 noches de cada 30 y, en las que hay algo, dos peticiones a la wiki más
 * una a tres descargas de miniatura. El presupuesto de aquí abajo es para el
 * ARRANQUE, cuando la tabla está vacía y hay 41 expansiones que clasificar.
 * Además se le exige dejar enteros los MINIMO_PRECIOS_MS: si una noche las
 * traducciones se comen su tope, quien se queda fuera es esto y no los precios.
 */
const PRESUPUESTO_TRADUCCIONES_MS = 30_000;

/** Por debajo de esto los precios no arrancan: ver PRESUPUESTO_MINIMO_MS allí. */
const MINIMO_PRECIOS_MS = 9_000;

/**
 * Techo del tramo de sobres. Con esto caben una noche de arranque completa (dos
 * peticiones a la API y unas cuantas descargas de miniatura) y sobran treinta
 * segundos para los precios.
 */
const PRESUPUESTO_SOBRES_MS = 10_000;

/**
 * Por debajo de esto ni se empieza.
 *
 * Es el coste de la noche MÍNIMA útil y está contado, no redondeado: dos
 * peticiones a la API de la wiki (el corte de cada una es TIMEOUT_MS pero
 * services/sobresIngest.ts lo recorta a lo que quede del presupuesto), la pausa
 * de cortesía de 900 ms entre ellas y el MARGEN_MS de 1,5 s que aquel módulo se
 * guarda para cerrar sin morir a mitad de un INSERT.
 *
 * Por debajo de esto lo que pasaba era peor que no hacer nada: se gastaba UNA
 * petición contra una wiki que se paga con donaciones, no daba tiempo a la
 * segunda y no se aprendía nada de la noche. Con 7 s, las noches en que las
 * traducciones se comen su tope entero (45 − 30 − 9 = 6 s) este tramo se salta
 * limpiamente, que es exactamente lo que promete el comentario de arriba: quien
 * se queda sin turno es esto y no los precios.
 */
const MINIMO_SOBRES_MS = 7_000;

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

    /* PRIMER ENCADENADO: LAS FOTOS DE SOBRE.
     *
     * Va delante de los precios porque los precios agotan todo lo que se les
     * dé y detrás no se ejecutaría nunca (ver el comentario largo de arriba).
     * Se reserva `MINIMO_PRECIOS_MS` para el tramo siguiente antes de decidir
     * cuánto se lleva éste, así que en el peor caso quien se queda sin turno es
     * esto y no los precios.
     *
     * CON `?setId=` SÍ SE ENCADENA, al revés que los precios, y la diferencia
     * es deliberada: forzar una expansión concreta es EXACTAMENTE lo que hace
     * falta después de corregir a mano su entrada en
     * src/data/sobres-bulbapedia.json, y quien dispara esa URL está esperando
     * justo ese resultado. Los precios se omiten con `?setId=` porque para eso
     * está /api/cron/sync-precios?setId=; para los sobres no hay otra puerta.
     *
     * NUNCA PUEDE TUMBAR ESTA RUTA: su propio try/catch, como los precios. Para
     * cuando esto se ejecuta, las traducciones ya están escritas, y perderlas
     * porque Bulbapedia esté caída sería absurdo. Un fallo sale en
     * `sobres.error` y la respuesta sigue siendo 200. */
    let sobres: ResumenSobres | { omitido: string } | { error: string } | null = null;
    const paraSobresMs =
      PRESUPUESTO_MS - (Date.now() - arranque) - (soloSetId ? 0 : MINIMO_PRECIOS_MS);
    if (paraSobresMs < MINIMO_SOBRES_MS) {
      sobres = { omitido: `sólo quedaban ${paraSobresMs} ms del presupuesto` };
      console.log(`[sync-sobres] sin sobras esta noche (${paraSobresMs} ms)`);
    } else {
      const presupuestoSobres = Math.min(PRESUPUESTO_SOBRES_MS, paraSobresMs);
      try {
        const s = await sincronizarSobres({ presupuestoMs: presupuestoSobres, soloSetId });
        sobres = s;
        console.log(
          `[sync-sobres] (encadenado, ${presupuestoSobres} ms)` +
            ` revisados=${s.revisados.length}` +
            ` nuevos=${s.nuevos.length}` +
            ` sinSobre=${s.sinSobre.length}` +
            ` pendientes=${s.pendientes}` +
            ` truncado=${s.truncadoPorTiempo}` +
            ` errores=${s.errores.length}`,
        );
        /* Una foto nueva es la única línea de este cron que alguien querría
         * leer: significa que una expansión ha dejado de enseñar el sobre
         * dibujado. Va con la página de la wiki de la que salió, porque cuando
         * un emparejamiento se tuerce ésa es la primera pregunta. */
        if (s.nuevos.length > 0) {
          const lista = s.nuevos
            .map((n) => `${n.setId} (${n.variantes} var, "${n.pagina}")`)
            .join(", ");
          console.log(`[sync-sobres] fotos nuevas: ${lista}`);
        }
        /* Los conflictos son lo único que pide una persona: significan que dos
         * expansiones apuntan al mismo fichero de la wiki, casi siempre porque
         * el mapa a mano manda a las dos a la misma página. Lo demás (promos,
         * subsets, kits) es el resultado esperado y no merece un aviso. */
        const conflictos = s.sinSobre.filter((x) => x.estado === ESTADOS_SOBRE.CONFLICTO);
        if (conflictos.length > 0) {
          const lista = conflictos.map((c) => `${c.setId}: ${c.motivo}`).join(" · ");
          console.warn(`[sync-sobres] conflictos: ${lista}`);
        }
        for (const e of s.errores) console.error(`[sync-sobres] ${e}`);
      } catch (e: unknown) {
        const mensaje = e instanceof Error ? e.message : String(e);
        console.error("[sync-sobres] error encadenado:", mensaje);
        sobres = { error: mensaje };
      }
    }

    /* SEGUNDO ENCADENADO. Ver el comentario largo de arriba: aquí es donde el
     * cron de traducciones gasta sus sobras en bajar precios de Cardmarket.
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

    return NextResponse.json({ ...resumen, sobres, precios });
  } catch (e: unknown) {
    console.error("[sync-es] error:", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
