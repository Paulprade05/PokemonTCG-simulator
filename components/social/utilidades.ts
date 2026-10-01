// components/social/utilidades.ts
//
// Dos piezas pequeñas que comparten la pantalla Social, la hoja de añadir, la
// ficha de entrenador y la página de invitación. No importan nada de React.
// (La abreviatura de cifras que vivía aquí es ahora `cifraCorta` de
// utils/format.ts, la misma que usa el saldo de la barra superior.)

/**
 * El aviso de un fallo de TRANSPORTE. Las acciones de app/social.ts capturan
 * sus errores de SQL y devuelven `{ ok: false, error }` con su propio texto;
 * lo que llega al `catch` del cliente es otra cosa —sin cobertura, un 500, un
 * despliegue caducado— y antes no lo recogía nadie: el botón se quedaba en
 * «Enviando…» hasta cerrar la hoja.
 */
export const SIN_CONEXION = "No se pudo completar. Revisa tu conexión.";

/**
 * Copia al portapapeles y dice si se pudo.
 *
 * `navigator.clipboard` no existe fuera de HTTPS (ni en algún navegador
 * embebido) y en iOS rechaza si la llamada ya no cuenta como gesto del
 * usuario; el respaldo del área de texto cubre los dos casos. Si tampoco
 * funciona se devuelve `false` y quien llama lo DICE: un «copiado» que no ha
 * copiado nada es peor que un error, porque el fallo se descubre al pegar.
 */
export async function copiarTexto(texto: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(texto);
      return true;
    }
  } catch {
    // Se sigue con el respaldo.
  }
  try {
    const area = document.createElement("textarea");
    area.value = texto;
    area.setAttribute("readonly", "");
    // Fuera de la vista pero DENTRO del documento y a 16 px: con una fuente
    // menor iOS amplía la página al seleccionar.
    area.style.position = "fixed";
    area.style.top = "0";
    area.style.left = "0";
    area.style.opacity = "0";
    area.style.fontSize = "16px";
    document.body.appendChild(area);
    area.select();
    area.setSelectionRange(0, texto.length);
    const copiado = document.execCommand("copy");
    area.remove();
    return copiado;
  } catch {
    return false;
  }
}
