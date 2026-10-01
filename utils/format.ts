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

/**
 * UNA CIFRA QUE CABE DONDE NO CABE ENTERA: "123k", "1,2M".
 *
 * Hasta 99.999 es la cifra de siempre; a partir de seis cifras se abrevia, que
 * además es lo único que se lee de un vistazo en un hueco pequeño. Nunca ocupa
 * más que las seis posiciones de "99.999".
 *
 * TRUNCA, no redondea: 199.999 es "199k". Enseñar "200k" a quien no llega a
 * 200.000 monedas es decirle que puede pagar algo que no puede.
 *
 * ES UNA SOLA. Había dos: la del saldo de la barra superior ("123k") y la de
 * las teselas de Social ("123 k"), escritas el mismo día con un espacio de
 * diferencia, así que el mismo saldo se leía distinto según la pantalla. Se
 * queda la forma sin espacio, que es la que está medida para el hueco más
 * estrecho (la barra a 320 px). Quien tenga sitio —escritorio, un lector de
 * pantalla— debe seguir dando la cifra entera con `formatNumber`.
 */
export function cifraCorta(valor: number): string {
  if (!Number.isFinite(valor)) return "—";
  if (valor < 100_000) return formatNumber(valor);
  if (valor < 1_000_000) return `${Math.floor(valor / 1_000)}k`;
  const millones = Math.floor(valor / 100_000) / 10;
  return `${millones.toLocaleString("es-ES", { maximumFractionDigits: 1 })}M`;
}
