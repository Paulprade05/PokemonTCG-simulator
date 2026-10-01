"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { IconoAvanzar } from "../icons";
import { formatNumber } from "../../utils/format";

/**
 * CUÁNTO LLEVAS DE LA EXPANSIÓN, DONDE SE ESTÁ ABRIENDO.
 *
 * El resumen del sobre decía "3 cartas nuevas" y nada más; para saber cómo iba
 * la expansión había que ir a Colección, desplegar "Progreso de colección" y
 * buscarla en la lista. La tienda tampoco lo enseñaba. Y el dato estaba ya en
 * memoria en las dos pantallas: el catálogo del set y los ids de la colección.
 *
 * SE MIDE CONTRA LAS CARTAS QUE EXISTEN (el catálogo cargado), no contra el
 * total que el set declara: es el mismo denominador que usa el álbum, al que
 * lleva el enlace, y el único contra el que se puede llegar al 100%.
 *
 * `nuevas` sólo se pasa desde el resumen: es lo que este sobre acaba de sumar.
 *
 * CON `hrefAlbum`, EL BLOQUE ENTERO ES EL ENLACE, y no un botón "Ver álbum" al
 * lado. Es por ALTO: un botón aparte tiene que medir 44 px, y con la barra
 * debajo el bloque se iba a 56. En la tienda, a 375x812, lo que hay debajo son
 * los sobres y sus dos botones de compra, que caben sin desplazar con el margen
 * justo (está medido en el comentario de PackCard, en app/page.tsx): 56 px más
 * de cabecera empujaban el botón de ×10 detrás de la barra de pestañas. Como
 * enlace, el bloque mide 44 px —texto y barra dentro del objetivo táctil— y
 * todo él responde al toque.
 */
interface ProgresoExpansionProps {
  /** Cartas distintas de la expansión que ya están en la colección. */
  tengo: number;
  /** Cartas que existen en la expansión. Con 0 no se pinta nada. */
  total: number;
  nuevas?: number;
  /** Si se pasa, el bloque entero enlaza al álbum de la expansión. */
  hrefAlbum?: string;
  className?: string;
}

export default function ProgresoExpansion({
  tengo,
  total,
  nuevas = 0,
  hrefAlbum,
  className = "",
}: ProgresoExpansionProps) {
  if (!(total > 0)) return null;
  // Acotado al catálogo: tras una resiembra la colección puede traer ids que
  // el catálogo de hoy ya no tiene, y un "201 de 198" no es un progreso.
  const llevo = Math.max(0, Math.min(tengo, total));
  const faltan = total - llevo;
  const porcentaje = Math.round((llevo / total) * 100);

  const contenido: ReactNode = (
    <>
      <span className="flex items-baseline justify-between gap-3">
        <span className="t-cuerpo-2 ink-soft min-w-0">
          {faltan === 0 ? (
            <span className="font-semibold" style={{ color: "var(--ok)" }}>
              Expansión completa · {formatNumber(total)} de {formatNumber(total)}
            </span>
          ) : (
            <>
              Llevas <span className="ink tnum font-semibold">{formatNumber(llevo)}</span> de{" "}
              <span className="tnum">{formatNumber(total)}</span>
              {nuevas > 0 && (
                <>
                  {" · "}
                  {/* --ok y no --accent: es texto, y --accent sobre el papel
                      claro se queda en 2:1. */}
                  <span className="tnum font-semibold" style={{ color: "var(--ok)" }}>
                    +{formatNumber(nuevas)}
                  </span>{" "}
                  con este sobre
                </>
              )}
              {" · "}te faltan <span className="tnum">{formatNumber(faltan)}</span>
            </>
          )}
        </span>
        {hrefAlbum && (
          <span className="ink t-cuerpo-2 flex shrink-0 items-center gap-0.5 self-center whitespace-nowrap font-medium">
            {/* El lector de pantalla oye la frase entera ("…te faltan 135. Ver
                álbum"); a la vista basta el nombre del destino. */}
            <span className="sr-only">Ver </span>Álbum
            <IconoAvanzar tam={16} className="ink-soft" />
          </span>
        )}
      </span>
      <span
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={llevo}
        aria-label="Progreso de la expansión"
        className="mt-1.5 block h-1.5 w-full overflow-hidden rounded-full"
        style={{ background: "var(--border-strong)" }}
      >
        {/* Ancho y no scaleX: es una barra de 6px sin nada dentro que pueda
            perder nitidez, pero así tampoco deja un transform permanente
            colgando encima de las cartas del resumen. */}
        <span
          className="block h-full rounded-full"
          style={{ width: `${porcentaje}%`, background: "var(--accent)" }}
        />
      </span>
    </>
  );

  const caja = `flex w-full min-h-[44px] flex-col justify-center ${className}`;
  return hrefAlbum ? (
    <Link href={hrefAlbum} className={`press-flat ${caja}`}>
      {contenido}
    </Link>
  ) : (
    <div className={caja}>{contenido}</div>
  );
}
