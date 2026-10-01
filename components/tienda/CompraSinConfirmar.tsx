"use client";

import { IconoAviso } from "../icons";

/**
 * EL AVISO DE UNA COMPRA QUE SE QUEDÓ A MEDIAS.
 *
 * Sale en la portada y en la tienda mientras haya una compra anotada sin
 * terminar (components/tienda/memoria.ts, `CompraPendiente`). Hay dos casos y
 * se dicen distinto porque no prometen lo mismo:
 *
 *   · NO SE SABE SI LLEGÓ (la respuesta se perdió). Antes la pantalla decía "no
 *     se pudo completar la compra" aunque el servidor ya hubiera cobrado, y
 *     volver a pulsar cobraba otra vez con otra clave. Ahora se reintenta con
 *     LA MISMA clave: si ya se cobró devuelve ese mismo sobre, y si no llegó se
 *     compra ahora. El texto dice las dos cosas porque las dos pueden pasar.
 *   · LLEGÓ Y NO SE TERMINÓ DE VER (iOS mató la app con el sobre a medio abrir).
 *     Las cartas ya están en la colección; aquí sólo se ofrece verlas.
 *
 * "Descartar" no deshace nada en el servidor —no hay nada que deshacer desde
 * aquí—: sólo deja de preguntar.
 */
interface CompraSinConfirmarProps {
  /** true: el sobre llegó y se cobró, pero no se terminó de ver. */
  confirmada: boolean;
  /** "Premium · Rivales Predestinados", "×10 Estándar · …" */
  rotulo: string;
  /** Hay una petición en vuelo: los botones no se pueden volver a disparar. */
  ocupado: boolean;
  onReintentar: () => void;
  onDescartar: () => void;
}

export default function CompraSinConfirmar({
  confirmada,
  rotulo,
  ocupado,
  onReintentar,
  onDescartar,
}: CompraSinConfirmarProps) {
  return (
    <div
      role="status"
      className="surface flex w-full flex-col gap-3 rounded-2xl p-4 text-left"
      style={{ borderColor: "color-mix(in srgb, var(--warn) 40%, transparent)" }}
    >
      <div className="flex items-start gap-3">
        <IconoAviso tam={20} className="mt-0.5 [color:var(--warn)]" />
        <div className="min-w-0">
          <p className="t-cuerpo font-semibold">
            {confirmada ? "Tienes un sobre sin terminar de ver" : "Compra sin confirmar"}
          </p>
          <p className="ink-soft t-cuerpo-2 mt-1 leading-relaxed">
            {confirmada ? (
              <>
                {rotulo}. Ya está cobrado y sus cartas están en tu colección.
              </>
            ) : (
              <>
                {rotulo}. No sabemos si llegó al servidor. Reintentar no cobra dos veces: si ya
                se cobró verás ese mismo sobre, y si no llegó se compra ahora.
              </>
            )}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onReintentar}
          disabled={ocupado}
          aria-busy={ocupado}
          className="btn-accent press control-44 t-cuerpo flex-1 whitespace-nowrap rounded-xl px-5 font-semibold disabled:opacity-60"
        >
          {ocupado ? "Comprobando…" : confirmada ? "Ver sobre" : "Reintentar"}
        </button>
        <button
          type="button"
          onClick={onDescartar}
          disabled={ocupado}
          className="btn-ghost press control-44 t-cuerpo whitespace-nowrap rounded-xl px-5 font-medium disabled:opacity-50"
        >
          Descartar
        </button>
      </div>
    </div>
  );
}
