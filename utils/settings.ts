/**
 * Ajustes de la aplicación, persistidos en localStorage.
 *
 * Es un almacén plano sin React a propósito: lo leen hooks que viven fuera del
 * árbol (useSound crea el AudioContext en el primer gesto) y componentes
 * normales. Los cambios se anuncian con un CustomEvent en window, y también se
 * escucha "storage" para que dos pestañas no se desincronicen.
 */

/* ------------------------------------------------------------------ *
 * IDIOMA DE LAS CARTAS
 * ------------------------------------------------------------------ *
 *
 * Vive FUERA del objeto `Ajustes` y con clave propia, calcado del tema: lo lee
 * el script antiparpadeo de app/layout.tsx, que corre antes del bundle y no
 * puede permitirse parsear un JSON con cuatro campos más.
 *
 * Tres escrituras, tres lectores distintos:
 *   - `localStorage` es la preferencia del DISPOSITIVO, la que recupera el
 *     script de arranque en la siguiente carga.
 *   - la COOKIE es la que lee el servidor: la traducción ocurre allí (ver
 *     services/idiomaServidor.ts), así que sin cookie las cartas llegarían en
 *     inglés por muy en español que estuviera el interruptor.
 *   - el atributo `data-idioma` del <html> es el espejo: las DOS hojas de
 *     ajustes montadas a la vez lo observan para reflejar el estado sin
 *     mantener cada una su copia.
 *
 * El tipo se importa SÓLO como tipo: `import type` se borra al compilar, así
 * que services/idioma.ts —y con él indice.json— no entra en el bundle del
 * navegador por esta puerta.
 */
import type { Idioma } from "../services/idioma";

export type { Idioma };

/** Clave del dispositivo en localStorage. */
export const CLAVE_IDIOMA = "lang";
/** Nombre de la cookie. Debe coincidir con services/idiomaServidor.ts. */
export const COOKIE_IDIOMA = "tcg-idioma";
/** Inglés: es el idioma en el que están los datos y lo que había hasta hoy. */
export const IDIOMA_PREDETERMINADO: Idioma = "en";

/** Cualquier cosa que no sea "es" es inglés. */
export const saneaIdioma = (v: unknown): Idioma => (v === "es" ? "es" : "en");

/**
 * ¿Ha elegido idioma ALGUIEN en este dispositivo, o es el valor por defecto?
 *
 * `leerIdioma()` no sirve para esto: siempre devuelve "en" o "es", así que no
 * distingue "el usuario eligió inglés" de "nadie ha elegido nada". Y esa
 * diferencia decide quién manda cuando la cuenta dice una cosa y el dispositivo
 * otra (ver el efecto de sincronización de SettingsSheet).
 */
export function hayIdiomaDeDispositivo(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const v = window.localStorage.getItem(CLAVE_IDIOMA);
    return v === "es" || v === "en";
  } catch {
    return false;
  }
}

/** Idioma aplicado ahora mismo. En el servidor, el predeterminado. */
export function leerIdioma(): Idioma {
  if (typeof document === "undefined") return IDIOMA_PREDETERMINADO;
  const enElHtml = document.documentElement.getAttribute("data-idioma");
  if (enElHtml === "es" || enElHtml === "en") return enElHtml;
  try {
    return saneaIdioma(window.localStorage.getItem(CLAVE_IDIOMA));
  } catch {
    return IDIOMA_PREDETERMINADO;
  }
}

/**
 * Escribe el idioma en las tres fuentes que lo leen. No recarga ni avisa a
 * nadie de que hay que recargar: de eso decide quien llama (SettingsSheet).
 */
export function aplicarIdioma(idioma: Idioma): void {
  const i = saneaIdioma(idioma);
  document.documentElement.setAttribute("data-idioma", i);
  try {
    window.localStorage.setItem(CLAVE_IDIOMA, i);
  } catch {
    // Sin almacenamiento: la cookie sola ya hace que el servidor traduzca.
  }
  // `Lax` y un año: la cookie no viaja en peticiones de terceros y sobrevive a
  // cerrar la app instalada. No lleva nada personal, sólo "en" o "es".
  document.cookie = `${COOKIE_IDIOMA}=${i};path=/;max-age=31536000;samesite=lax`;
  // No hace falta anunciar el cambio: quien lo refleja (las dos hojas de
  // ajustes) observa `data-idioma`, que se acaba de escribir arriba.
}

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
