"use client";

import FundaCarta from "./FundaCarta";
import type { CartaEnColeccion } from "../../utils/tipos";

/**
 * UNA HOJA del archivador: nueve fundas en 3×3 sobre una lámina de papel.
 *
 * POR QUÉ RECIBE HUECOS Y NO UNA LISTA CORTA: la hoja SIEMPRE monta nueve
 * casillas, aunque sólo haya dos cartas. Es lo que distingue un archivador de
 * una rejilla con scroll —la última hoja se ve a medio llenar, igual que en la
 * mesa— y además es lo que mantiene el alto constante entre hojas: con una
 * rejilla de longitud variable, pasar de una hoja llena a la última con dos
 * cartas encogería el bloque a un tercio a mitad de animación y el pase de
 * página daría un salto. Quien llama rellena con `null` hasta nueve.
 *
 * La lámina lleva su propia sombra interior en el canto izquierdo: es el
 * doblez contra las anillas, y es lo que hace que la hoja parezca sujeta por
 * el lomo y no flotando. Va en `box-shadow` —nunca en `filter`— porque un
 * filtro sobre un ancestro de las cartas obliga a WebKit a rasterizar toda la
 * capa y la ilustración sale borrosa en iPhone.
 */

interface PaginaArchivadorProps {
  /** Exactamente nueve posiciones; `null` es funda vacía. */
  huecos: (CartaEnColeccion | null)[];
  onAbrir: (carta: CartaEnColeccion) => void;
  /** Para el rótulo del lector de pantalla: "Hoja 3 de 12". */
  numero: number;
  total: number;
}

/* Papel de la hoja. El grano es el mismo del tema (utilidad `.surface`), pero
 * aquí se compone a mano porque encima del grano van dos gradientes que
 * `.surface` no contempla: el tinte del papel y el doblez del lomo. */
const HOJA: React.CSSProperties = {
  background:
    "var(--grain), linear-gradient(105deg, color-mix(in srgb, var(--ink) 6%, var(--surface)) 0%, var(--surface) 14%, var(--surface) 100%)",
  border: "1px solid var(--border)",
  boxShadow:
    "inset 14px 0 20px -16px rgba(0,0,0,0.55), inset 0 0 0 1px color-mix(in srgb, #fff 6%, transparent), var(--shadow-md)",
};

export default function PaginaArchivador({
  huecos,
  onAbrir,
  numero,
  total,
}: PaginaArchivadorProps) {
  const cartasEnHoja = huecos.filter(Boolean).length;

  return (
    <div
      role="group"
      /* El rótulo dice también cuántas cartas trae porque las fundas vacías
       * están ocultas al lector: sin esto, una hoja con dos cartas y una hoja
       * llena sonarían igual salvo por el número de elementos. */
      aria-label={`Hoja ${numero} de ${total}, ${cartasEnHoja} de 9 fundas ocupadas`}
      /* pl mayor que el resto del relleno: es el margen que se comen las
       * anillas, que se dibujan montadas sobre el canto de la hoja. */
      className="grid grid-cols-3 gap-1.5 rounded-2xl py-2 pl-3 pr-2 sm:gap-3 sm:py-4 sm:pl-6 sm:pr-4"
      style={HOJA}
    >
      {huecos.map((carta, i) => (
        /* La clave lleva la posición y no sólo el id: dos hojas distintas
         * pueden compartir carta cuando se cambia de filtro a mitad de
         * animación, y `hueco-${i}` sin más colisionaría entre las dos hojas
         * que AnimatePresence tiene vivas a la vez. */
        <FundaCarta
          key={carta ? `c:${carta.id}` : `h:${i}`}
          carta={carta}
          posicion={i + 1}
          onAbrir={onAbrir}
        />
      ))}
    </div>
  );
}
