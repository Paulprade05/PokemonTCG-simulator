import { sql } from "@vercel/postgres";
import { NextResponse } from "next/server";
import { requireAdmin } from "../_admin-auth";

/* ==================================================================== *
 * ¿ESTÁ PUESTA ESTA VARIABLE DE ENTORNO?
 * ====================================================================
 *
 * POR QUÉ EXISTE ESTO. `GRADING_SECRET` se puso en Vercel, se redesplegó, y el
 * registro seguía avisando de que no llegaba. A partir de ahí no había forma de
 * saber qué pasaba: la única función que la lee está detrás de una sesión, así
 * que ni siquiera con el secreto de administrador se podía comprobar desde
 * fuera. La respuesta era "entra en la app, ve a graduar y mira los logs", que
 * es una manera lentísima de contestar a un sí o un no.
 *
 * Con esto, `/db-stats` responde también qué variables llegan a ESTE despliegue.
 * Es el sitio natural: ya es la ruta de diagnóstico y ya está detrás de
 * ADMIN_SECRET.
 *
 * LO QUE SE PUBLICA Y LO QUE NO, que es la parte importante:
 *
 *   · si la variable llega (sí/no) y CUÁNTOS caracteres mide;
 *   · NUNCA su valor, ni un trozo, ni un hash. Saber que un secreto mide 64
 *     caracteres no ayuda a adivinarlo; ver cuatro de sus letras, sí. Un hash
 *     tampoco vale: con el valor delante se comprueba, así que sería un oráculo
 *     para confirmar un secreto robado.
 *
 * La longitud se mide DESPUÉS de recortar espacios, que es lo mismo que hace
 * quien la consume: así "64" aquí significa exactamente lo que el código va a
 * usar, y no lo que se pegó con un salto de línea detrás.
 */
function estadoDeVariable(nombre: string, minimo = 1) {
  const bruto = process.env[nombre];
  const limpio = typeof bruto === "string" ? bruto.trim() : "";
  return {
    // El nombre va en la respuesta para poder leerla sin ir a buscar el orden.
    variable: nombre,
    llega: bruto !== undefined,
    caracteres: limpio.length,
    // Lo único accionable: ¿la puede usar el código o no?
    utilizable: limpio.length >= minimo,
    // Se distingue "no definida" de "definida pero vacía": la primera es un
    // problema del panel de Vercel (entorno equivocado, o sin redesplegar) y la
    // segunda es un valor mal pegado. Se arreglan en sitios distintos.
    nota:
      bruto === undefined
        ? "no llega a este despliegue: revisa que esté marcada para Production y redespliega después de guardarla"
        : limpio.length === 0
          ? "llega vacía"
          : limpio.length < minimo
            ? `llega pero se queda corta (hacen falta ${minimo})`
            : "correcta",
  };
}

export async function GET(request: Request) {
  const noAutorizado = requireAdmin(request);
  if (noAutorizado) return noAutorizado;

  /* Las variables se comprueban ANTES de tocar la base y se devuelven pase lo
   * que pase con ella: si Postgres está caído, saber si el entorno está bien
   * puesto sigue siendo útil —y a veces es justo lo que se está buscando—. */
  const entorno = [
    // El mínimo de 16 es el mismo que exige secretoDeNotas en app/action.ts.
    estadoDeVariable("GRADING_SECRET", 16),
    estadoDeVariable("CRON_SECRET", 16),
    estadoDeVariable("ADMIN_SECRET", 16),
    estadoDeVariable("POSTGRES_URL"),
    estadoDeVariable("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"),
    estadoDeVariable("CLERK_SECRET_KEY"),
    estadoDeVariable("POKEMONTCG_API_KEY"),
  ];

  try {
    const { rows } = await sql`
      SELECT
        (SELECT count(*)::int FROM cards) AS cards_total,
        (SELECT count(*)::int FROM cards WHERE abilities IS NULL OR abilities::text IN ('null','[]','{}')) AS cards_no_abilities,
        (SELECT count(*)::int FROM cards WHERE legalities IS NULL OR legalities::text IN ('null','[]','{}')) AS cards_no_legalities,
        (SELECT count(*)::int FROM cards WHERE cardmarket IS NULL OR cardmarket::text IN ('null','[]','{}')) AS cards_no_cardmarket,
        (SELECT count(*)::int FROM cards WHERE rules IS NULL OR rules::text IN ('null','[]','{}')) AS cards_no_rules,
        (SELECT count(*)::int FROM cards WHERE evolves_from IS NULL AND (evolves_to IS NULL OR evolves_to::text IN ('null','[]','{}'))) AS cards_no_evolution,
        (SELECT count(*)::int FROM cards WHERE attacks IS NULL OR attacks::text IN ('null','[]','{}')) AS cards_no_attacks,
        (SELECT count(*)::int FROM sets) AS sets_total
    `;

    /* Las tablas nuevas se cuentan aparte y con su propio try: son de las
     * migraciones que se ejecutan a mano, así que en un despliegue sin migrar
     * NO EXISTEN, y una sola consulta que las juntara con las de arriba haría
     * fallar el informe entero justo cuando más falta hace. */
    let tablasNuevas: Record<string, number | string> = {};
    try {
      const { rows: n } = await sql`
        SELECT
          (SELECT count(*)::int FROM graded_cards)  AS graduadas,
          (SELECT count(*)::int FROM binder_slots)  AS fundas_archivador,
          (SELECT count(*)::int FROM card_prices WHERE eur IS NOT NULL) AS cartas_con_precio_eur,
          (SELECT count(*)::int FROM bazar_listings WHERE estado = 'activa') AS anuncios_bazar
      `;
      tablasNuevas = n[0] as Record<string, number>;
    } catch {
      tablasNuevas = {
        aviso: "faltan tablas de /migrate-mejoras (graded_cards, binder_slots, card_prices o bazar_listings)",
      };
    }

    return NextResponse.json({ ...rows[0], ...tablasNuevas, entorno });
  } catch (e: unknown) {
    // Aun con la base caída se devuelve el estado del entorno.
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e), entorno },
      { status: 500 },
    );
  }
}
