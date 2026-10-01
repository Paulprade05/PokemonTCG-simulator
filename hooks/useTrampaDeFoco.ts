"use client";

import { useCallback, useEffect, type KeyboardEvent, type RefObject } from "react";

/**
 * EL FOCO DE UN DIÁLOGO: ENTRA AL ABRIR, NO SE ESCAPA, Y VUELVE AL CERRAR.
 *
 * Nació dentro de components/CardDetailModal.tsx y se ha sacado aquí porque las
 * hojas inferiores (components/ui/Sheet.tsx) no hacían NADA de esto, y son
 * muchas más: ajustes, añadir amigo, publicar en el bazar, las confirmaciones.
 * Lo que pasaba sin ello, en un iPhone con VoiceOver: se abría Ajustes y el
 * cursor se quedaba en el botón de detrás, que el `aria-modal` acababa de
 * esconder; el lector no entraba en la hoja. Y con teclado, Tab seguía
 * recorriendo la página tapada.
 *
 * Tres cosas, y las tres son la misma promesa ("mientras esté abierto, estás
 * dentro"):
 *
 *  1. AL ABRIR, el foco pasa al panel (que lleva `tabIndex={-1}`: enfocable por
 *     programa, fuera del orden de tabulación). SALVO que el foco ya esté
 *     dentro: una hoja con un campo `autoFocus` —añadir amigo— ya lo ha puesto
 *     donde tiene que estar, y robárselo le quitaría el teclado.
 *  2. MIENTRAS DURA, Tab y Mayús+Tab dan la vuelta dentro del panel.
 *  3. AL CERRAR, el foco vuelve a lo que abrió el diálogo.
 *
 * Se ancla a `abierto` (la PRESENCIA del diálogo) y no a su contenido: la ficha
 * de carta cambia de carta sin cerrarse y no debe re-enfocar en cada una.
 *
 * Devuelve el manejador de teclado, que va en `onKeyDown` del panel.
 */
export function useTrampaDeFoco(
  panelRef: RefObject<HTMLElement | null>,
  abierto: boolean,
): (e: KeyboardEvent) => void {
  useEffect(() => {
    if (!abierto) return;
    const anterior =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    if (panel && !panel.contains(document.activeElement)) {
      panel.focus({ preventScroll: true });
    }
    return () => {
      if (!anterior || !anterior.isConnected) return;
      /* Devolver el foco a un CAMPO DE TEXTO en un móvil vuelve a subir el
         teclado, que nadie ha pedido: pasa al abrir una carta con el buscador
         de la colección todavía enfocado (en iOS tocar una carta no le quita el
         foco al campo). Ahí se deja el foco donde caiga; con ratón o teclado
         físico sí se devuelve, que es donde hace falta para seguir escribiendo. */
      const esCampo = anterior.matches('input, textarea, [contenteditable="true"]');
      if (esCampo && window.matchMedia("(pointer: coarse)").matches) return;
      // preventScroll: la página no se ha movido mientras el diálogo estaba
      // abierto, así que lo que lo abrió sigue donde estaba; sin esto, un foco
      // devuelto a algo medio tapado por la barra superior daba un salto.
      anterior.focus({ preventScroll: true });
    };
  }, [abierto, panelRef]);

  return useCallback(
    (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const enfocables = panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (enfocables.length === 0) {
        e.preventDefault();
        panel.focus({ preventScroll: true });
        return;
      }
      const primero = enfocables[0];
      const ultimo = enfocables[enfocables.length - 1];
      const activo = document.activeElement;
      if (e.shiftKey) {
        if (activo === primero || activo === panel) {
          e.preventDefault();
          ultimo.focus();
        }
      } else if (activo === ultimo) {
        e.preventDefault();
        primero.focus();
      }
    },
    [panelRef],
  );
}
