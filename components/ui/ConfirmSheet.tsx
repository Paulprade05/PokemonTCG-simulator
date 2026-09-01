"use client";

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

/** Alternativa a `confirm()` que no rompe el aspecto de app instalada. */
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
        <h2 className="ink text-center text-[17px] font-semibold">{title}</h2>
        {description && (
          <p className="ink-soft mt-2 text-center text-[13px] leading-relaxed">
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
            className={`press rounded-2xl py-3.5 text-sm font-semibold ${
              destructive ? "" : "btn-accent"
            }`}
            style={
              destructive
                ? {
                    background:
                      "color-mix(in srgb, var(--danger) 16%, transparent)",
                    border:
                      "1px solid color-mix(in srgb, var(--danger) 35%, transparent)",
                    color: "var(--danger)",
                  }
                : undefined
            }
          >
            {confirmLabel}
          </button>
          <button
            onClick={onClose}
            className="btn-ghost press rounded-2xl py-3.5 text-sm font-medium"
          >
            {cancelLabel}
          </button>
        </div>
      </div>
    </Sheet>
  );
}
