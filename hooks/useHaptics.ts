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

/**
 * Vibración de refuerzo para los gestos. Safari en iOS todavía no implementa
 * la Vibration API, así que allí degrada a no-op sin romper nada; en Android y
 * en escritorio con soporte sí se nota.
 */
export function useHaptics() {
  return useCallback((pattern: Pattern = "tap") => {
    if (typeof navigator === "undefined" || !("vibrate" in navigator)) return;
    // El ajuste se consulta en cada disparo, no al montar: así apagarlo desde
    // la hoja de ajustes silencia al instante a los componentes ya montados
    // sin necesidad de suscripciones.
    if (!leerAjustes().hapticos) return;
    try {
      navigator.vibrate(PATTERNS[pattern]);
    } catch {
      /* algunos navegadores lo bloquean sin interacción previa */
    }
  }, []);
}
