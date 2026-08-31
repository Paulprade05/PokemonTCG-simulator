/**
 * Equivalencia de expansiones repo -> TCGdex, COMPARTIDA.
 *
 * POR QUÉ EN JSON Y NO AQUÍ MISMO: la tabla la necesitan dos consumidores que
 * no pueden importarse entre sí. El generador es `scripts/generar-diccionario-es.mjs`,
 * un `.mjs` que corre en Node suelto y no puede importar TypeScript; el cron de
 * traducciones es TypeScript compilado por Next y no puede importar el `.mjs`
 * sin arrastrar `fs` y `node:url` al bundle. JSON lo leen los dos sin build: el
 * script con `readFile` + `JSON.parse` (ya lo hace en tres sitios) y la app con
 * el `resolveJsonModule` que ya usa `services/idioma.ts` para `indice.json`.
 *
 * Y TIENE QUE SER UNA SOLA TABLA: dos copias que se desincronizan acaban
 * traduciendo una carta con el nombre de otra, que es exactamente el desastre
 * que las guardias antimapeo existen para impedir.
 *
 * NO SE DERIVA, se declara. Una regla de "pt" -> "." con relleno de cero acierta
 * en la mayoría y falla en swsh35, swsh45, swsh45sv y —sin remedio posible— en
 * `zsv10pt5`, que en TCGdex es `sv10.5b` (pierde la "z" y gana una "b"), y en
 * `rsv10pt5`, que es `sv10.5w`.
 */
import mapaCrudo from "../src/data/es/mapa-sets.json";

export const MAPA_SETS_ES: Readonly<Record<string, string>> = mapaCrudo;

/**
 * Candidato DERIVADO para una expansión que nadie ha mapeado a mano. Lo usa el
 * cron para poder cubrir expansiones nuevas sin esperar a un despliegue.
 *
 * ES UNA CONJETURA, NO UNA EQUIVALENCIA. Quien la use está OBLIGADO a pasar las
 * guardias antimapeo antes de escribir nada: que TCGdex responda 200 al id que
 * le pides no prueba que sea el mismo set —emparejar sv10 contra sv08 casa el
 * 100% de las cartas por número y escribiría 244 nombres equivocados—. Si el
 * candidato acierta, el cron guarda el id confirmado y ya no vuelve a adivinar.
 */
export function candidatoTcgdex(idLocal: string): string {
  return idLocal
    .replace(/pt/g, ".")
    .replace(/^(sv|me)(\d+)/, (_, bloque, numero) => bloque + String(numero).padStart(2, "0"));
}
