import type { ReactElement } from "react";

/**
 * "87/198" en la esquina de la tesela de una expansión.
 *
 * Las teselas de la portada eran logo y nombre, iguales tuviera el jugador 0 o
 * 190 de 198: para saber por dónde iba cada una había que ir a Colección y
 * desplegar el progreso. La tesela sigue siendo la de logos que pidió el dueño;
 * esto sólo añade la cifra, y sólo cuando hay algo que decir (con 0 no sale).
 *
 * Arriba a la IZQUIERDA: la derecha es del aviso "EN" de las expansiones sin
 * traducir. Es un <span>, no un botón: la tesela entera ya es el botón.
 */
export default function PastillaDeProgreso({
  llevo,
  total,
}: {
  llevo: number;
  total: number;
}): ReactElement | null {
  if (llevo <= 0) return null;
  // Acotado: tras una resiembra la colección puede traer más ids que cartas
  // tiene hoy la expansión, y "201/198" no es un progreso.
  const tengo = total > 0 ? Math.min(llevo, total) : llevo;
  const completa = total > 0 && tengo >= total;
  return (
    <span
      className="absolute top-2 left-2 md:top-3 md:left-3 z-10 chip px-1.5 py-0.5 t-micro tnum leading-none font-medium"
      // --ok y no --accent: es texto de 10px, y --accent sobre el papel claro
      // no llega a 2,5:1.
      style={{ color: completa ? "var(--ok)" : "var(--ink-soft)" }}
    >
      {tengo}
      {total > 0 ? `/${total}` : ""}
      <span className="sr-only"> cartas conseguidas</span>
    </span>
  );
}
