"use client";

import FundaCarta from "./FundaCarta";
import type { CartaEnColeccion } from "../../utils/tipos";

/**
 * UNA HOJA del archivador: nueve fundas en 3×3 sobre una lámina de papel.
 *
 * POR QUÉ RECIBE HUECOS Y NO UNA LISTA CORTA: la hoja SIEMPRE monta nueve
 * casillas, aunque sólo haya dos cartas. Es lo que distingue un archivador de
 * una rejilla con scroll —la hoja se ve a medio llenar, igual que en la mesa— y
 * además es lo que mantiene el alto constante entre hojas: con una rejilla de
 * longitud variable, pasar de una hoja llena a otra con dos cartas encogería el
 * bloque a un tercio a mitad de animación y el pase de página daría un salto.
 * Quien llama rellena con `null` hasta nueve.
 *
 * Y ahora eso importa el doble: el archivador NACE VACÍO y se monta funda a
 * funda, así que la hoja de nueve huecos no es el caso raro del final sino la
 * primera pantalla que ve todo el mundo. Cada hueco es el botón con el que se
 * coloca una carta (ver components/vitrina/FundaCarta.tsx).
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
  /**
   * Toque en una funda, con su ranura 0..8.
   *
   * OPCIONAL, y no por comodidad: LibroArchivador pinta DOS hojas mientras dura
   * el giro (la que gira y la de debajo), y la que gira es una copia en
   * movimiento. Sin manejador, la hoja entera se vuelve decorativa —ni se toca
   * ni se anuncia— y así el lector de pantalla no ve dos archivadores ni el
   * dedo puede colocar una carta en una hoja que está de perfil.
   */
  onFunda?: (ranura: number) => void;
  /** Para el rótulo del lector de pantalla: "Hoja 3 de 12". */
  numero: number;
  total: number;
  /**
   * Ranura que escribe la invitación completa dentro del hueco, o -1. La usa
   * la vitrina sólo en el archivador recién estrenado: ver `invita` en
   * FundaCarta.
   */
  invitacion?: number;
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
  onFunda,
  numero,
  total,
  invitacion = -1,
}: PaginaArchivadorProps) {
  const cartasEnHoja = huecos.filter(Boolean).length;
  const viva = !!onFunda;

  return (
    <div
      /* Sin manejador esto es la hoja que gira: se ve y nada más. `aria-hidden`
       * la retira entera del árbol de accesibilidad, que es lo correcto durante
       * el medio segundo en que hay dos hojas montadas a la vez. */
      {...(viva
        ? {
            role: "group" as const,
            /* El rótulo dice también cuántas cartas trae porque las fundas
             * vacías se anuncian una a una como "vacía, colocar una carta": sin
             * el resumen habría que recorrer las nueve para saber si la hoja
             * está llena. */
            "aria-label": `Hoja ${numero} de ${total}, ${cartasEnHoja} de 9 fundas ocupadas`,
          }
        : { "aria-hidden": true as const })}
      /* pl mayor que el resto del relleno: es el margen que se comen las
       * anillas, que se dibujan montadas sobre el canto de la hoja. */
      className="grid grid-cols-3 gap-1.5 rounded-2xl py-2 pl-3 pr-2 sm:gap-3 sm:py-4 sm:pl-6 sm:pr-4"
      style={HOJA}
    >
      {huecos.map((carta, i) => (
        /* LA CLAVE ES LA RANURA, nunca el id de la carta. En este archivador la
         * misma carta puede ocupar VARIAS fundas de la misma hoja (quien tiene
         * tres Pikachu puede enseñar los tres), así que una clave por id se
         * repetiría dentro de la propia hoja y React tiraría la advertencia —y
         * lo que es peor, reutilizaría el nodo equivocado al quitar una de las
         * dos. La posición sí es única: nueve fundas, nueve claves. */
        <FundaCarta
          key={i}
          carta={carta}
          posicion={i + 1}
          invita={i === invitacion}
          onTocar={onFunda ? () => onFunda(i) : undefined}
        />
      ))}
    </div>
  );
}
