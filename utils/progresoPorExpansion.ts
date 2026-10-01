import type { Expansion } from "./tipos";

/**
 * PROGRESO POR EXPANSIÓN: una sola cuenta para todas las pantallas que la dan.
 *
 * Vivía dentro de app/collection/page.tsx y el álbum de un entrenador tenía su
 * propia copia, más vieja: medía contra el total DECLARADO del set (así que un
 * set que declara 258 con 252 cartas decía "252/258" al lado de un 100 %) y
 * pintaba las 171 expansiones aunque casi todas estuvieran a cero. Fuera del
 * componente, la regla es una y quien quiera decir "cómo voy" la importa.
 *
 * Es PURA a propósito: recibe las cartas y las expansiones y no toca ni el
 * servidor ni el almacenamiento, así que sirve igual para la colección propia,
 * la de otro entrenador o la del invitado.
 *
 * LAS DOS DECISIONES QUE LLEVA DENTRO (las dos fueron un fallo antes):
 *
 * 1. EL DENOMINADOR es `cardsCount`, las cartas que EXISTEN, y no `total`, lo
 *    que el set declara: viene inflado de la API y la ingesta es reanudable,
 *    así que midiendo contra él el 100 % era inalcanzable. `total` queda de
 *    respaldo para el catálogo local, que no cuenta cartas.
 * 2. EL NUMERADOR VA ACOTADO al denominador: cuenta lo que hay en la colección
 *    y puede no cuadrar con el catálogo de hoy tras una resiembra. Sin el tope
 *    salía "150 de 100".
 */

/** Una expansión con el progreso del jugador en ella. */
export interface ProgresoDeExpansion extends Expansion {
  /** URL del logotipo, o cadena vacía si la expansión no lo trae. */
  logo: string;
  /** Cartas DISTINTAS que se tienen de la expansión, acotadas a `totalInSet`. */
  owned: number;
  /** Cartas que existen en la expansión: el denominador honesto. */
  totalInSet: number;
  /** 0 a 100, redondeado. */
  percentage: number;
  /** Cuántas faltan para completarla. */
  missing: number;
}

/**
 * Expansión a la que pertenece una carta, leída de su id (`sv8-12` es de
 * `sv8`). Se corta por el ÚLTIMO guion: hay ids de expansión con guion dentro.
 * Devuelve null si el id no tiene esa forma.
 */
export function expansionDeCartaId(id: unknown): string | null {
  const texto = String(id ?? "");
  const guion = texto.lastIndexOf("-");
  return guion > 0 ? texto.slice(0, guion) : null;
}

/** Cuántas cartas distintas hay de cada expansión. Una fila, una carta. */
export function conteoPorExpansion(
  cartas: readonly { id: string }[],
): Map<string, number> {
  const conteo = new Map<string, number>();
  for (const c of cartas) {
    const sid = expansionDeCartaId(c.id);
    if (!sid) continue;
    conteo.set(sid, (conteo.get(sid) ?? 0) + 1);
  }
  return conteo;
}

/**
 * El progreso de TODAS las expansiones, de más a menos avanzada. Quien sólo
 * quiera las empezadas filtra por `owned > 0`: con la base sincronizada son más
 * de ciento cincuenta y casi todas están a cero.
 */
export function progresoPorExpansion(
  cartas: readonly { id: string }[],
  expansiones: readonly Expansion[],
): ProgresoDeExpansion[] {
  const conteo = conteoPorExpansion(cartas);
  return expansiones
    .map((set) => {
      const totalInSet = Number(set.cardsCount) || Number(set.total) || 1;
      const owned = Math.min(conteo.get(set.id) ?? 0, totalInSet);
      return {
        ...set,
        logo: set.images?.logo || "",
        owned,
        totalInSet,
        percentage: Math.min(100, Math.round((owned / totalInSet) * 100)),
        missing: Math.max(0, totalInSet - owned),
      };
    })
    .sort((a, b) => b.percentage - a.percentage || b.owned - a.owned);
}
