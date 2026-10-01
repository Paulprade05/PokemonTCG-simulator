"use client";

import type { PeticionRecibida } from "../../utils/tiposSocial";
import { formatNumber } from "../../utils/format";
import AvatarEntrenador from "./AvatarEntrenador";

/**
 * UNA PETICIÓN DE AMISTAD RECIBIDA: QUIÉN ES, Y DEBAJO LOS DOS BOTONES.
 *
 * La fila anterior ponía el nombre y los botones en la misma línea, con los
 * botones sin encoger. Medido: a 320 px al nombre le quedaban 15 px —los
 * puntos suspensivos y nada más— y cero mientras el botón decía
 * «Procesando…»; a 375 px, nueve caracteres. Se aceptaba a alguien del que
 * sólo se veía la inicial.
 *
 * DOS PISOS: arriba el entrenador con toda la línea para su nombre; abajo una
 * rejilla de dos botones iguales de 44 px. A partir de `sm` hay sitio de sobra
 * y vuelven a ir en una fila.
 *
 * LOS BOTONES NO CAMBIAN DE RÓTULO MIENTRAS TRABAJAN. «Procesando…» mide 35 px
 * más que «Aceptar» y movía la fila bajo el dedo; se apagan los dos y el
 * estado se anuncia con `aria-busy`.
 *
 * DE UN TOQUE, también «Rechazar»: antes pedía confirmación y luego BORRABA la
 * fila, así que el otro podía volver a pedir sin fin. Ahora el rechazo guarda
 * la fila (el otro sigue viendo «Enviada» y no puede reenviar) y se deshace
 * añadiéndole yo cuando quiera: no hay nada irreversible que confirmar.
 *
 * La usan la pestaña Amigos y la hoja «Añadir amigo»: la misma petición no
 * puede tener dos caras según dónde se mire.
 */

interface FilaPeticionProps {
  peticion: PeticionRecibida;
  /** Hay una respuesta en vuelo para esta petición. */
  ocupada: boolean;
  onAceptar: () => void;
  onRechazar: () => void;
  /** En la hoja: «{nombre} quiere ser tu amigo» en vez del nombre a secas. */
  conFrase?: boolean;
}

export default function FilaPeticion({
  peticion,
  ocupada,
  onAceptar,
  onRechazar,
  conFrase = false,
}: FilaPeticionProps) {
  const { nombre, etiqueta, unicas, enComun } = peticion;
  return (
    <div className="surface-2 flex flex-col gap-2.5 rounded-xl p-3 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
      <div className="flex min-w-0 items-center gap-3">
        <AvatarEntrenador nombre={nombre} etiqueta={etiqueta} />
        <div className="min-w-0">
          {/* El nombre trunca solo; la etiqueta y la frase no encogen, para
              que lo que se pierda sea el final del nombre y no el `#2345` que
              distingue a dos homónimos. */}
          <p className="t-cuerpo flex min-w-0 items-baseline gap-1.5">
            <span className="truncate font-semibold">{nombre}</span>
            {etiqueta && <span className="ink-soft t-cuerpo-2 shrink-0 font-normal">#{etiqueta}</span>}
          </p>
          <p className="ink-soft t-meta tnum truncate">
            {conFrase ? "Quiere ser tu amigo · " : ""}
            {formatNumber(unicas)} únicas
            {enComun > 0 ? ` · ${formatNumber(enComun)} en común` : ""}
          </p>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:flex sm:shrink-0">
        <button
          type="button"
          onClick={onAceptar}
          disabled={ocupada}
          aria-busy={ocupada}
          aria-label={`Aceptar a ${nombre}`}
          className="btn-accent press control-44 t-cuerpo-2 rounded-lg px-4 font-semibold disabled:cursor-not-allowed disabled:opacity-50"
        >
          Aceptar
        </button>
        <button
          type="button"
          onClick={onRechazar}
          disabled={ocupada}
          aria-label={`Rechazar a ${nombre}`}
          className="btn-ghost press control-44 t-cuerpo-2 rounded-lg px-4 font-medium disabled:cursor-not-allowed disabled:opacity-50"
        >
          Rechazar
        </button>
      </div>
    </div>
  );
}
