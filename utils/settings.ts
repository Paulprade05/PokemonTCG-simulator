/**
 * Ajustes de la aplicación, persistidos en localStorage.
 *
 * Es un almacén plano sin React a propósito: lo leen hooks que viven fuera del
 * árbol (useSound crea el AudioContext en el primer gesto) y componentes
 * normales. Los cambios se anuncian con un CustomEvent en window, y también se
 * escucha "storage" para que dos pestañas no se desincronicen.
 */

export interface Ajustes {
  /** Efectos de sonido de la apertura de sobres y la interfaz. */
  sonido: boolean;
  /** Volumen maestro, 0 a 1. */
  volumen: number;
  /** Vibración en dispositivos que la soportan. */
  hapticos: boolean;
  /** Apaga auras, confeti y demás adornos pesados (independiente del ajuste
   *  de sistema prefers-reduced-motion, que se respeta siempre). */
  reducirEfectos: boolean;
}

const CLAVE = "tcg-ajustes";
export const EVENTO_AJUSTES = "tcg-ajustes-cambiados";

const PREDETERMINADOS: Ajustes = {
  sonido: true,
  volumen: 0.7,
  hapticos: true,
  reducirEfectos: false,
};

const sanea = (v: unknown): Ajustes => {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const vol = typeof o.volumen === "number" && isFinite(o.volumen) ? o.volumen : PREDETERMINADOS.volumen;
  return {
    sonido: typeof o.sonido === "boolean" ? o.sonido : PREDETERMINADOS.sonido,
    volumen: Math.min(1, Math.max(0, vol)),
    hapticos: typeof o.hapticos === "boolean" ? o.hapticos : PREDETERMINADOS.hapticos,
    reducirEfectos:
      typeof o.reducirEfectos === "boolean" ? o.reducirEfectos : PREDETERMINADOS.reducirEfectos,
  };
};

export function leerAjustes(): Ajustes {
  if (typeof window === "undefined") return { ...PREDETERMINADOS };
  try {
    const crudo = window.localStorage.getItem(CLAVE);
    return crudo ? sanea(JSON.parse(crudo)) : { ...PREDETERMINADOS };
  } catch {
    return { ...PREDETERMINADOS };
  }
}

export function guardarAjustes(parcial: Partial<Ajustes>): Ajustes {
  const siguiente = sanea({ ...leerAjustes(), ...parcial });
  try {
    window.localStorage.setItem(CLAVE, JSON.stringify(siguiente));
  } catch {
    // Sin almacenamiento (modo privado agotado): el ajuste vive esta sesión.
  }
  window.dispatchEvent(new CustomEvent<Ajustes>(EVENTO_AJUSTES, { detail: siguiente }));
  return siguiente;
}

/** Llama a cb con cada cambio (de esta pestaña o de otra). Devuelve la baja. */
export function suscribirseAjustes(cb: (a: Ajustes) => void): () => void {
  const porEvento = (e: Event) => cb((e as CustomEvent<Ajustes>).detail ?? leerAjustes());
  const porStorage = (e: StorageEvent) => {
    if (e.key === CLAVE) cb(leerAjustes());
  };
  window.addEventListener(EVENTO_AJUSTES, porEvento);
  window.addEventListener("storage", porStorage);
  return () => {
    window.removeEventListener(EVENTO_AJUSTES, porEvento);
    window.removeEventListener("storage", porStorage);
  };
}
