import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

/**
 * Lo que tiene que medir un secreto para darlo por bueno. Es el mismo mínimo
 * que exige `secretoDeNotas` (app/action.ts) para GRADING_SECRET y el que
 * /db-stats usa para decir si una variable es «utilizable».
 */
export const LONGITUD_MINIMA_SECRETO = 16;

/**
 * El secreto de una variable de entorno, RECORTADO, o null si no sirve.
 *
 * LOS DOS AGUJEROS QUE CIERRA, que eran la misma línea (`process.env.X` usado
 * tal cual, aquí y copiado en los tres crons):
 *
 *  1. Cualquier valor no vacío valía. Con ADMIN_SECRET=admin, /seed-database y
 *     las migraciones quedaban abiertas a «Bearer admin» mientras /db-stats
 *     decía que el secreto «se queda corto»: el diagnóstico exigía 16
 *     caracteres y la puerta ninguno.
 *  2. No se recortaba. Un CRON_SECRET pegado con un salto de línea detrás no
 *     puede viajar en una cabecera HTTP (se recorta por el camino), así que la
 *     comparación no casaba nunca: los crons respondían 401 todas las noches y
 *     /db-stats, que sí recorta antes de medir, decía «correcta».
 *
 * Ahora la puerta y el diagnóstico hacen LO MISMO: recortar y exigir 16. Un
 * secreto corto cierra la ruta (503), igual que si no estuviera puesto.
 */
export function secretoDeEntorno(nombre: string): string | null {
  const bruto = process.env[nombre];
  const limpio = typeof bruto === "string" ? bruto.trim() : "";
  return limpio.length >= LONGITUD_MINIMA_SECRETO ? limpio : null;
}

/** ¿Trae la petición `Authorization: Bearer <secreto>`? En tiempo constante. */
export function bearerCoincide(request: Request, secreto: string): boolean {
  const cabecera = request.headers.get("authorization") ?? "";
  // El nombre del esquema no distingue mayúsculas (RFC 9110): rechazar "bearer"
  // daría un 401 sin pistas ante un secreto correcto.
  const token = /^bearer\s+(.+)$/i.exec(cabecera)?.[1]?.trim() ?? "";
  return token.length > 0 && coincide(token, secreto);
}

/**
 * Puerta común: 503 si el secreto de `variable` no está (o no sirve), 401 si la
 * petición no lo trae, null si puede continuar.
 */
function requireSecreto(
  request: Request,
  variable: string,
  mensajeSinSecreto: string,
): NextResponse | null {
  const secreto = secretoDeEntorno(variable);

  // Sin secreto utilizable la ruta se cierra en vez de quedarse abierta: un
  // despliegue al que se le olvide la variable no debe dejar la ingesta, el
  // seed, las migraciones o los crons al alcance de cualquiera.
  if (!secreto) {
    return NextResponse.json({ error: mensajeSinSecreto }, { status: 503 });
  }

  if (!bearerCoincide(request, secreto)) {
    // Sin detalles: la respuesta no distingue entre falta de cabecera, formato
    // incorrecto o secreto equivocado.
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  return null;
}

/**
 * Puerta común de las rutas de administración (ingesta, migraciones, seed y
 * estadísticas). Devuelve la respuesta de error si la petición no está
 * autorizada, o null si el handler puede continuar.
 *
 * Se espera la cabecera: Authorization: Bearer <ADMIN_SECRET>
 */
export function requireAdmin(request: Request): NextResponse | null {
  // El 503 dice por qué. No delata nada que sirva para entrar —la ruta está
  // cerrada— y es la única pista que queda cuando el secreto corto es justo el
  // de administración, porque entonces /db-stats tampoco se puede consultar.
  return requireSecreto(
    request,
    "ADMIN_SECRET",
    `Ruta de administración no disponible: ADMIN_SECRET no está configurado o mide menos de ${LONGITUD_MINIMA_SECRETO} caracteres.`,
  );
}

/**
 * Puerta de los crons (/api/cron/*). Vercel Cron envía
 * `Authorization: Bearer $CRON_SECRET`.
 *
 * Sustituye a las tres copias de `igualEnTiempoConstante` que llevaba cada
 * ruta: comparaban contra `process.env.CRON_SECRET` sin recortar y sin mínimo,
 * y al estar copiadas, corregir una no corregía las otras dos.
 */
export function requireCron(request: Request): NextResponse | null {
  return requireSecreto(
    request,
    "CRON_SECRET",
    `CRON_SECRET no está configurado o mide menos de ${LONGITUD_MINIMA_SECRETO} caracteres: sincronización deshabilitada.`,
  );
}

// Comparar con === corta en el primer carácter distinto, así que el tiempo de
// respuesta filtra cuánto prefijo se ha acertado. Los digest miden siempre lo
// mismo, que es además lo que timingSafeEqual exige para no lanzar.
function coincide(a: string, b: string): boolean {
  const da = createHash("sha256").update(a).digest();
  const db = createHash("sha256").update(b).digest();
  return timingSafeEqual(da, db);
}
