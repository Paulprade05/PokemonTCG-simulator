// components/social/fichaEntrenadorGlobal.ts
//
// ABRIR LA FICHA DE UN ENTRENADOR DESDE CUALQUIER SITIO, CON UNA SOLA HOJA.
//
// El escaparate del bazar pinta hasta 40 anuncios y cada uno tiene su «de
// {vendedor}». Si cada tarjeta montara su propia hoja serían 40 portales, 40
// trampas de foco y 40 gestos de arrastre esperando a uno que se abre de uvas
// a peras. Aquí hay UNA hoja, montada en la cáscara (components/AppShell.tsx,
// `FichaEntrenadorGlobal`), y quien quiera abrirla llama a
// `abrirFichaEntrenador`.
//
// Es un módulo y no un contexto de React para que quien lo usa —la tarjeta de
// un anuncio— no tenga que importar la hoja ni sus acciones de servidor: sólo
// esta función. No guarda nada entre llamadas: si no hay hoja montada (una
// prueba, una página de error) la llamada se pierde y no pasa nada.

import type { Destino } from "../../utils/tiposSocial";

type Oyente = (destino: Destino) => void;

const oyentes = new Set<Oyente>();

/** Abre la ficha del entrenador al que se refiere `destino`. */
export function abrirFichaEntrenador(destino: Destino): void {
  for (const oyente of oyentes) oyente(destino);
}

/** Para la hoja de la cáscara. Devuelve la función que deja de escuchar. */
export function escucharFichaEntrenador(oyente: Oyente): () => void {
  oyentes.add(oyente);
  return () => {
    oyentes.delete(oyente);
  };
}
