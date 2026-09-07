"use client";

import type { ReactNode } from "react";
import { IconoCerrar, IconoVolver } from "../icons";

/**
 * EL TÍTULO DE UNA HOJA INFERIOR.
 *
 * Lo montaban por su cuenta la hoja de confirmar, la de ajustes, la de publicar
 * en el bazar (dos veces: el paso 1 sin flecha y el paso 2 con ella), el
 * selector de entrega del mercado, el selector de carta de la vitrina y la de
 * añadir amigo. Siete sitios, y otra vez el mismo trabajo hecho de formas
 * distintas: seis lo escribían en `text-[17px] font-semibold` centrado y el de
 * añadir amigo en `text-lg font-bold` alineado a la izquierda; el párrafo de
 * apoyo iba en 12px en unas y en 13px en otras; y el relleno superior saltaba
 * entre `pt-1`, `pt-2`, `pt-3` y nada.
 *
 * EL CENTRADO NO ES GRATIS, Y AQUÍ ESTÁ EL DETALLE QUE SE OLVIDA. Cuando hay un
 * botón a un lado —la flecha de volver del paso 2 de publicar, o el aspa de
 * añadir amigo— un título "centrado" sin nada al otro lado NO queda centrado:
 * queda desplazado justo la mitad del ancho del botón. La hoja de publicar ya
 * lo había resuelto poniendo un hueco vacío de 44px al otro lado; aquí eso pasa
 * a ser automático, para que no dependa de que quien escriba la siguiente hoja
 * se acuerde.
 *
 * EL ASPA SÓLO LA LLEVABA AÑADIR AMIGO, y se queda como prop en vez de
 * unificarse a todas: la hoja ya se cierra arrastrando el asa hacia abajo,
 * tocando el fondo o con Escape, así que el aspa es redundante salvo cuando la
 * hoja tiene el teclado abierto tapando media pantalla — que es exactamente el
 * caso de añadir amigo, y por eso allí sí tiene sentido.
 *
 * `descripcion` ES UN SUBTÍTULO, NO UN CUERPO DE TEXTO, y por eso va en
 * `t-cuerpo-2` (12px). Es una decisión ya tomada, para que no haya que
 * rediscutirla hoja por hoja: seis de las siete copias originales estaban ya en
 * 12px y lo que ponen ahí es una línea de contexto ("Hoja 1, funda 3", "Sólo
 * salen las copias que te sobran"). Si lo que hay que enseñar es un PÁRRAFO que
 * se lee de corrido —el aviso de una confirmación destructiva, por ejemplo—, eso
 * no es el subtítulo de la hoja: va debajo, en `t-cuerpo`, y lo monta la hoja.
 * Es lo que hace components/ui/ConfirmSheet.tsx, y allí está explicado.
 */

interface CabeceraDeHojaProps {
  titulo: string;
  /** El subtítulo, bajo el título. Una línea de contexto — ver la cabecera. */
  descripcion?: ReactNode;
  /**
   * Marca la descripción como región viva. Sólo donde el texto CAMBIA mientras
   * la hoja está abierta —el selector de la vitrina anuncia ahí "Colocando la
   * carta…"—: sin esto, un lector de pantalla no se entera de que la acción ha
   * empezado, y con esto puesto donde el texto es fijo, lo lee dos veces.
   */
  descripcionViva?: boolean;
  /** Retrocede un paso DENTRO de la hoja (no la cierra). */
  onVolver?: () => void;
  /**
   * Qué anuncia el lector de pantalla al llegar a la flecha de volver. Por
   * defecto dice de dónde viene ("Volver al paso anterior"), pero una hoja que
   * sabe A QUÉ vuelve dice algo más útil: publicar en el bazar lo usa para
   * "Elegir otra carta", que es lo que hace ese botón en ese paso.
   */
  rotuloVolver?: string;
  /** Cierra la hoja. Ver la nota de arriba: sólo donde de verdad hace falta. */
  onCerrar?: () => void;
  /** Apaga los dos botones mientras hay una escritura en vuelo. */
  bloqueada?: boolean;
  /** Sólo espacio alrededor (`pb-1`, `mb-4`…). Nada de estilo interno. */
  className?: string;
}

export default function CabeceraDeHoja({
  titulo,
  descripcion,
  descripcionViva = false,
  onVolver,
  rotuloVolver = "Volver al paso anterior",
  onCerrar,
  bloqueada = false,
  className = "",
}: CabeceraDeHojaProps) {
  // El hueco simétrico: si hay botón a un lado y no al otro, el título se
  // descentraría media anchura de botón. Ver la cabecera.
  const hueco = <div className="h-11 w-11 shrink-0" aria-hidden="true" />;

  return (
    <div className={className}>
      <div className="flex items-center gap-2">
        {onVolver ? (
          <button
            type="button"
            onClick={onVolver}
            disabled={bloqueada}
            aria-label={rotuloVolver}
            className="btn-ghost press control-44 shrink-0 rounded-xl disabled:opacity-40"
          >
            <IconoVolver tam={16} />
          </button>
        ) : (
          onCerrar && hueco
        )}

        <h2 className="ink t-titulo flex-1 text-center font-semibold">{titulo}</h2>

        {onCerrar ? (
          <button
            type="button"
            onClick={onCerrar}
            disabled={bloqueada}
            aria-label="Cerrar"
            className="btn-ghost press control-44 shrink-0 rounded-xl disabled:opacity-40"
          >
            <IconoCerrar tam={16} />
          </button>
        ) : (
          onVolver && hueco
        )}
      </div>

      {/* LA REGIÓN VIVA TIENE QUE ESTAR EN EL DOM ANTES DE QUE CAMBIE EL TEXTO.
          Un `aria-live` se arma cuando el nodo se monta y sólo anuncia lo que
          cambia DESPUÉS; si el nodo aparece ya con el texto dentro, el lector de
          pantalla no dice nada. Por eso, con `descripcionViva`, el párrafo se
          pinta siempre —vacío si hace falta—, y con eso basta: el mercado le
          pasa `requisito?.descripcion ?? ""`, que es falsy mientras la hoja se
          está abriendo, y sin esta rama el anuncio se perdía. Sin
          `descripcionViva` se mantiene el comportamiento de antes: nada de nodo
          vacío ocupando margen. */}
      {(descripcion || descripcionViva) && (
        <p
          aria-live={descripcionViva ? "polite" : undefined}
          className="ink-soft t-cuerpo-2 mt-1.5 text-center empty:mt-0"
        >
          {descripcion}
        </p>
      )}
    </div>
  );
}
