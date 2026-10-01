"use client";

import { IconoAvanzar } from "../icons";
import type { Expansion } from "../../utils/tipos";

/**
 * "SEGUIR ABRIENDO": UN TOQUE HASTA LA TIENDA DE TU EXPANSIÓN.
 *
 * Quien abre siempre la misma expansión hacía el mismo recorrido en cada visita
 * a Inicio: desplegar su serie si no era la recordada, buscar la tesela, esperar
 * al catálogo y deslizar el carrusel hasta su sobre. Esta fila es ese recorrido
 * ya hecho, encima de la lista.
 *
 * Es UNA fila y no una sección: la portada sigue siendo la lista de
 * expansiones, y esto no puede empujarla fuera de la primera pantalla.
 *
 * `onPrecalentar` va en `pointerdown` porque en táctil no hay hover: entre que
 * el dedo toca y que se levanta pasan ~100 ms que la descarga del catálogo
 * aprovecha.
 */
interface SeguirAbriendoProps {
  set: Expansion;
  /** Lo que se dice bajo el nombre: el sobre habitual, el progreso… */
  detalle?: string;
  onAbrir: () => void;
  onPrecalentar?: () => void;
}

export default function SeguirAbriendo({ set, detalle, onAbrir, onPrecalentar }: SeguirAbriendoProps) {
  return (
    <button
      type="button"
      onClick={onAbrir}
      onPointerDown={onPrecalentar}
      className="surface surface-hover press-flat flex w-full items-center gap-3 rounded-2xl px-4 py-3 text-left"
    >
      <span className="flex h-11 w-16 shrink-0 items-center justify-center">
        {set.images?.logo ? (
          // Un logo, no una carta: decorativo (el nombre va al lado) y sin
          // `loading="lazy"`, que está en la primera pantalla.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={set.images.logo} alt="" decoding="async" className="max-h-11 max-w-full object-contain" />
        ) : null}
      </span>
      <span className="min-w-0 flex-1">
        <span className="t-etiqueta ink-soft block">Seguir abriendo</span>
        <span className="t-cuerpo block truncate font-semibold">{set.name}</span>
        {detalle && <span className="t-meta ink-soft tnum block truncate">{detalle}</span>}
      </span>
      <IconoAvanzar tam={16} className="ink-soft" />
    </button>
  );
}
