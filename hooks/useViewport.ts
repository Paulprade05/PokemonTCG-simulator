"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { isIOS, isSafari, isStandaloneDisplay } from "../utils/platform";

/**
 * Mantiene sincronizadas con el viewport real las variables CSS que usa el
 * layout. En iOS la barra de Safari y el teclado cambian el alto visible sin
 * que `100vh` se entere, así que medimos con visualViewport y lo escribimos en
 * `--app-height` / `--keyboard`.
 *
 * Además marca `data-keyboard="open"` en <html> para que el CSS pueda esconder
 * la barra de pestañas y dejar el input pegado justo encima del teclado.
 */

// Por debajo de esto lo que se mueve es la barra del navegador, no el teclado.
const KEYBOARD_THRESHOLD = 90;

export interface ViewportState {
  height: number;
  keyboardHeight: number;
  isKeyboardOpen: boolean;
}

export function useViewport(): ViewportState {
  const [state, setState] = useState<ViewportState>({
    height: 0,
    keyboardHeight: 0,
    isKeyboardOpen: false,
  });

  useEffect(() => {
    const root = document.documentElement;
    const vv = window.visualViewport;

    const update = () => {
      // Con un pellizco para ampliar, vv.height viene dividido por la escala:
      // la diferencia con innerHeight es enorme y se confundiría con el
      // teclado, encogiendo --app-height a media pantalla y escondiendo la
      // barra de pestañas. Mientras dura el zoom no se toca nada; al volver a
      // escala 1 llega otro evento y se recalcula.
      if (vv && vv.scale > 1.01) return;

      const height = vv ? vv.height : window.innerHeight;
      const rawKeyboard = vv
        ? window.innerHeight - vv.height - vv.offsetTop
        : 0;
      const keyboardHeight = rawKeyboard > KEYBOARD_THRESHOLD ? rawKeyboard : 0;
      const isKeyboardOpen = keyboardHeight > 0;

      root.style.setProperty("--app-height", `${Math.round(height)}px`);
      root.style.setProperty("--keyboard", `${Math.round(keyboardHeight)}px`);
      if (isKeyboardOpen) root.setAttribute("data-keyboard", "open");
      else root.removeAttribute("data-keyboard");

      setState((prev) =>
        prev.height === height && prev.keyboardHeight === keyboardHeight
          ? prev
          : { height, keyboardHeight, isKeyboardOpen },
      );
    };

    update();

    if (vv) {
      vv.addEventListener("resize", update);
      vv.addEventListener("scroll", update);
    }
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);

    return () => {
      if (vv) {
        vv.removeEventListener("resize", update);
        vv.removeEventListener("scroll", update);
      }
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
  }, []);

  return state;
}

export type InstallMode = "installed" | "ios" | "other";

function subscribeDisplayMode(onChange: () => void) {
  const mq = window.matchMedia("(display-mode: standalone)");
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

function getInstallMode(): InstallMode {
  if (isStandaloneDisplay()) return "installed";
  // Sólo Safari en iOS necesita las instrucciones manuales de "Añadir a inicio".
  if (isIOS() && isSafari()) return "ios";
  return "other";
}

/**
 * Cómo está corriendo la app: ya instalada, en Safari iOS (donde hay que
 * explicar el gesto) o en cualquier otro navegador. Se lee con
 * useSyncExternalStore para que el servidor renderice siempre "other" y no
 * haya desajuste de hidratación.
 */
export function useInstallMode(): InstallMode {
  return useSyncExternalStore(
    subscribeDisplayMode,
    getInstallMode,
    () => "other" as const,
  );
}
