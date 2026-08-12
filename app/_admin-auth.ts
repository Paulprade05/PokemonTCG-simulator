import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

/**
 * Puerta común de las rutas de administración (ingesta, migraciones, seed y
 * estadísticas). Devuelve la respuesta de error si la petición no está
 * autorizada, o null si el handler puede continuar.
 *
 * Se espera la cabecera: Authorization: Bearer <ADMIN_SECRET>
 */
export function requireAdmin(request: Request): NextResponse | null {
  const secreto = process.env.ADMIN_SECRET;

  // Sin secreto configurado la ruta se cierra en vez de quedarse abierta: un
  // despliegue al que se le olvide la variable no debe dejar la ingesta, el
  // seed o las migraciones al alcance de cualquiera.
  if (!secreto) {
    return NextResponse.json(
      { error: "Ruta de administración no disponible" },
      { status: 503 },
    );
  }

  const cabecera = request.headers.get("authorization") ?? "";
  // El nombre del esquema no distingue mayúsculas (RFC 9110): rechazar "bearer"
  // daría un 401 sin pistas ante un secreto correcto.
  const token = /^bearer\s+(.+)$/i.exec(cabecera)?.[1] ?? "";

  if (!coincide(token, secreto)) {
    // Sin detalles: la respuesta no distingue entre falta de cabecera, formato
    // incorrecto o secreto equivocado.
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  return null;
}

// Comparar con === corta en el primer carácter distinto, así que el tiempo de
// respuesta filtra cuánto prefijo se ha acertado. Los digest miden siempre lo
// mismo, que es además lo que timingSafeEqual exige para no lanzar.
function coincide(a: string, b: string): boolean {
  const da = createHash("sha256").update(a).digest();
  const db = createHash("sha256").update(b).digest();
  return timingSafeEqual(da, db);
}
