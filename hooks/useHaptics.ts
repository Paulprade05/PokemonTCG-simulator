"use client";

import { useCallback } from "react";
import { leerAjustes } from "../utils/settings";

type Pattern = "tap" | "select" | "success" | "warning" | "heavy";

const PATTERNS: Record<Pattern, number | number[]> = {
  tap: 8,
  select: 12,
  success: [14, 40, 22],
  warning: [26, 60, 26],
  heavy: 32,
};

/** Lo que dura cada patrón, pausas incluidas. */
const duracion = (p: number | number[]) =>
  typeof p === "number" ? p : p.reduce((suma, tramo) => suma + tramo, 0);

/**
 * ¿Puede vibrar este dispositivo? Safari en iOS no implementa la Vibration
 * API, así que en un iPhone es `false`. Lo usa Ajustes para no ofrecer un
 * interruptor que ahí no cambia nada. En el servidor no hay `navigator` y
 * devuelve `false`: quien pinte según esto tiene que leerlo de forma que la
 * hidratación no se desajuste (useSyncExternalStore, o dentro de un efecto).
 */
export const hayVibracion = (): boolean =>
  typeof navigator !== "undefined" && "vibrate" in navigator;

/**
 * EL REBOTE. `toast()` ya vibra por su cuenta, y muchas pantallas llaman a
 * `haptic("warning")` una línea antes de avisar: dos patrones seguidos, y como
 * un `vibrate()` nuevo corta al que está sonando, en Android se notaba como un
 * rebote. En vez de tocar cada una de esas llamadas se pone el freno aquí: una
 * vibración que llega mientras la anterior sigue sonando (más un respiro) se
 * ignora. Es estado de módulo porque el motor de vibración es uno para toda la
 * página, no uno por componente.
 */
const RESPIRO_MS = 40;
let ocupadoHasta = 0;

/**
 * Vibración de refuerzo para los gestos. Safari en iOS todavía no implementa
 * la Vibration API, así que allí degrada a no-op sin romper nada; en Android y
 * en escritorio con soporte sí se nota.
 */
export function useHaptics() {
  return useCallback((pattern: Pattern = "tap") => {
    if (!hayVibracion()) return;
    // El ajuste se consulta en cada disparo, no al montar: así apagarlo desde
    // la hoja de ajustes silencia al instante a los componentes ya montados
    // sin necesidad de suscripciones.
    if (!leerAjustes().hapticos) return;
    const ahora = Date.now();
    if (ahora < ocupadoHasta) return;
    try {
      navigator.vibrate(PATTERNS[pattern]);
      ocupadoHasta = ahora + duracion(PATTERNS[pattern]) + RESPIRO_MS;
    } catch {
      /* algunos navegadores lo bloquean sin interacción previa */
    }
  }, []);
}
