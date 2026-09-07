"use client";

import CabeceraDeHoja from "./CabeceraDeHoja";
import Sheet from "./Sheet";

interface ConfirmSheetProps {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

/**
 * Alternativa a `confirm()` que no rompe el aspecto de app instalada.
 *
 * POR QUÉ LA DESCRIPCIÓN NO VA DENTRO DE `CabeceraDeHoja`. Ahí el hueco de
 * descripción es un SUBTÍTULO —una línea de contexto, 12px— y lo que se pinta
 * aquí no lo es: es la única explicación que hay antes de una acción que no se
 * puede deshacer ("Se venderán 1.234 cartas repetidas por 5.678 monedas. Cada
 * copia extra vale menos que la anterior. Las favoritas no se tocan."). Son tres
 * frases que se leen de corrido, y el mapa de la escala tipográfica manda ahí
 * `t-cuerpo`, no `t-cuerpo-2`. Al unificar las siete cabeceras de hoja esto se
 * había ido a 12px, un punto por debajo de los 13 que tenía, y encima había
 * perdido el `leading-relaxed`: se recupera aquí, que es su sitio.
 */
export default function ConfirmSheet({
  open,
  title,
  description,
  confirmLabel = "Confirmar",
  cancelLabel = "Cancelar",
  destructive = false,
  onConfirm,
  onClose,
}: ConfirmSheetProps) {
  return (
    <Sheet open={open} onClose={onClose} label={title}>
      <div className="px-5 pt-3 pb-6">
        <CabeceraDeHoja titulo={title} />
        {description && (
          <p className="ink-soft t-cuerpo mt-2 text-center leading-relaxed">
            {description}
          </p>
        )}
        <div className="mt-6 flex flex-col gap-2.5">
          <button
            onClick={() => {
              /* PRIMERO SE VA LA HOJA, DESPUÉS SE HACE EL TRABAJO.
               *
               * Antes era `onConfirm(); onClose();` en el mismo manejador, así
               * que React no repintaba nada hasta que onConfirm terminaba: si
               * lo que se confirma es vender media colección o llamar a una
               * server action, la hoja se quedaba clavada bajo el dedo el rato
               * que durase, y sólo entonces empezaba a cerrarse. Se percibe
               * como que el botón no ha funcionado — y en un botón destructivo
               * eso lleva a pulsar otra vez.
               *
               * Cerrando primero y aplazando el trabajo un fotograma, el cierre
               * ya está en marcha cuando empieza lo caro. El aplazamiento es de
               * ~16ms: sigue dentro de la activación del usuario, así que las
               * vibraciones y los sonidos que dispare onConfirm siguen
               * permitidos. */
              onClose();
              requestAnimationFrame(() => onConfirm());
            }}
            className={`press rounded-2xl py-3.5 t-cuerpo font-semibold ${
              destructive ? "" : "btn-accent"
            }`}
            style={
              destructive
                ? {
                    background:
                      "color-mix(in srgb, var(--danger) 16%, transparent)",
                    border:
                      "1px solid color-mix(in srgb, var(--danger) 35%, transparent)",
                    // --danger-ink y no --danger: el rótulo de un botón es
                    // texto, y --danger es el token de FONDO. Sobre este relleno
                    // al 16% en tema claro el rojo vivo se queda corto de
                    // contraste; --danger-ink es su pareja legible.
                    color: "var(--danger-ink)",
                  }
                : undefined
            }
          >
            {confirmLabel}
          </button>
          <button
            onClick={onClose}
            className="btn-ghost press rounded-2xl py-3.5 t-cuerpo font-medium"
          >
            {cancelLabel}
          </button>
        </div>
      </div>
    </Sheet>
  );
}
