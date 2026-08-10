/**
 * Formato de números fijado a es-ES.
 *
 * `toLocaleString()` sin locale usa el del entorno: en Vercel el servidor
 * resuelve en-US ("1,000") y el navegador del usuario es-ES ("1000"). El HTML
 * del servidor y el del cliente dejan de coincidir y React aborta la
 * hidratación con el error #418. Fijando el locale, ambos lados coinciden.
 */
export const formatNumber = (value: number): string =>
  value.toLocaleString("es-ES");
