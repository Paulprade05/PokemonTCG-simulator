"use client";

import { etiquetaNota } from "../../utils/graduacion";

/**
 * El distintivo de una carta graduada: su nota, y por qué está donde está.
 *
 * POR QUÉ ES UNA PIEZA APARTE Y NO TRES TROZOS DE JSX REPETIDOS: la nota es LO
 * QUE JUSTIFICA EL PRECIO de un anuncio. Una Charizard con un 10 vale el triple
 * que la misma carta suelta (MULTIPLICADOR_NOTA en utils/graduacion.ts: 3,0 para
 * el 10 y 1,5 para el 9), así que el comprador que ve "1.500 monedas" sin ver el
 * 10 sólo ve un precio abusivo. Sale en el escaparate, en la lista de anuncios
 * propios y en la hoja de publicar, y en los tres sitios tiene que decir lo
 * mismo o deja de ser una referencia.
 *
 * NADA DE `filter` NI DE `scale` AQUÍ: este distintivo se pinta ENCIMA de la
 * ilustración, o sea que es hermano de la carta y a veces ancestro suyo en el
 * mismo bloque apilado. Cualquiera de los dos promociona la capa y WebKit
 * rasteriza la ilustración a escala fija —borrosa en iPhone—; está documentado
 * en components/PokemonCard.tsx:140-163. El relieve va con box-shadow.
 */

/**
 * Tinta de la nota. Tres tramos, y no un degradado continuo, porque el salto de
 * valor tampoco es continuo: del 8 al 9 el multiplicador pasa de 0,9 a 1,5 y del
 * 9 al 10 de 1,5 a 3,0. Un 10 tiene que verse distinto de un 9 de un vistazo.
 *
 * Se usan --warn-ink y --ok, que son las variantes LEGIBLES de --warn y --accent
 * (los de marca dan 2,2:1 sobre el papel crema del tema claro: valen para un
 * relleno o un borde, no para texto). Está explicado en app/globals.css:40-47.
 */
function tintaDe(nota: number): string {
  if (nota >= 9) return "var(--warn-ink)";
  if (nota >= 7) return "var(--ok)";
  return "var(--ink-soft)";
}

interface NotaGraduadaProps {
  nota: number;
  /**
   * Rótulo ya calculado. `getVitrina` lo manda hecho (`etiqueta`), pero
   * `getBazar` sólo manda el número: en ese caso se deriva aquí con la misma
   * función del servidor, que es pura y vive en utils/graduacion.ts.
   */
  etiqueta?: string | null;
  /** "chapa" va superpuesta sobre la carta; "linea" va en una ficha de texto. */
  variante?: "chapa" | "linea";
}

export default function NotaGraduada({
  nota,
  etiqueta,
  variante = "chapa",
}: NotaGraduadaProps) {
  const tinta = tintaDe(nota);
  const rotulo = etiqueta ?? etiquetaNota(nota);

  if (variante === "chapa") {
    return (
      <div
        // aria-label completo y contenido oculto al lector: leído literalmente,
        // "10 Gema Impecable" no dice de qué habla.
        aria-label={`Carta graduada con nota ${nota}, ${rotulo}`}
        className="flex items-center gap-1.5 rounded-full py-1 pr-2.5 pl-2"
        style={{
          background: "var(--surface)",
          border: `1px solid color-mix(in srgb, ${tinta} 45%, transparent)`,
          boxShadow: "var(--shadow-sm)",
        }}
      >
        <span
          aria-hidden="true"
          className="tnum text-[13px] leading-none font-bold"
          style={{ color: tinta }}
        >
          {nota}
        </span>
        <span
          aria-hidden="true"
          className="ink-soft text-[9px] leading-none font-semibold tracking-wide uppercase"
        >
          Nota
        </span>
      </div>
    );
  }

  return (
    <span
      className="chip inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-semibold"
      style={{
        color: tinta,
        borderColor: `color-mix(in srgb, ${tinta} 40%, transparent)`,
        background: `color-mix(in srgb, ${tinta} 10%, transparent)`,
      }}
    >
      <span className="tnum">Nota {nota}</span>
      <span className="ink-soft font-normal">· {rotulo}</span>
    </span>
  );
}
