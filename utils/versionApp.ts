// utils/versionApp.ts
//
// LA VERSIÓN DE LA APP: saber cuál corre, saber que ha caducado y recargar.
//
// EL PROBLEMA QUE CIERRA. Una PWA instalada vive días en memoria: iOS la
// suspende y la reanuda sin recargarla. Si entre medias hay un despliegue, el
// JavaScript que sigue en pantalla llama a server actions cuyos identificadores
// ya no existen en el servidor, TODAS fallan, y cada pantalla lo contaba como
// "Revisa tu conexión" con cobertura perfecta. Quien no cambiara de pestaña se
// quedaba así hasta matar la app. Y el único aviso de versión nueva que había
// dependía de que cambiara un byte de public/sw.js, que en un despliegue normal
// no cambia.
//
// Aquí vive lo que hace falta para detectarlo y salir de ahí; quien lo enseña
// en pantalla es components/pwa/ServiceWorkerRegister.tsx.

import { unstable_isUnrecognizedActionError } from "next/navigation";

/**
 * Identificador del despliegue con el que se compiló ESTE JavaScript.
 *
 * Lo inyecta next.config.ts (`env.NEXT_PUBLIC_BUILD_ID`). Vacío significa "no
 * se sabe" —desarrollo, o un despliegue fuera de Vercel— y entonces la
 * comparación de versiones sencillamente no se hace: un identificador
 * inventado que no coincidiera entre el cliente y el servidor enseñaría el
 * aviso de versión nueva para siempre.
 */
export const BUILD_ID: string = process.env.NEXT_PUBLIC_BUILD_ID ?? "";

/** Se despacha en `window` cuando el servidor ya no reconoce a este cliente. */
export const EVENTO_VERSION_CADUCADA = "tcg:version-caducada";

/** Anuncia que esta versión ha caducado. Quien escucha es ServiceWorkerRegister. */
export function avisarVersionCaducada(): void {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new Event(EVENTO_VERSION_CADUCADA));
  } catch {
    /* sin eventos no hay aviso, pero tampoco se rompe quien llamaba */
  }
}

/**
 * ¿Este error es "el servidor no conoce esta server action"?
 *
 * Es para los `catch` de las pantallas: si devuelve true, el fallo NO es de
 * conexión y no hay que decirle al jugador que la revise; el aviso de versión
 * caducada ya está en pantalla (lo pone el vigilante de abajo).
 */
export function esAccionCaducada(error: unknown): boolean {
  return unstable_isUnrecognizedActionError(error);
}

/** La cabecera con la que Next marca la respuesta a una acción que no conoce
 *  (next/dist/client/components/app-router-headers.js). */
const CABECERA_ACCION_DESCONOCIDA = "x-nextjs-action-not-found";

let vigilantes = 0;
let fetchOriginal: typeof window.fetch | null = null;
let fetchVigilado: typeof window.fetch | null = null;

/**
 * Mira las respuestas que pasan por `fetch` y avisa si alguna es "acción
 * desconocida". Devuelve la función que deja de mirar.
 *
 * POR QUÉ SE MIRA `fetch` Y NO CADA `catch`. La forma limpia sería que cada
 * pantalla preguntara `esAccionCaducada(err)` en su catch, pero son más de una
 * docena de llamadas repartidas por toda la app, y basta con que una pantalla
 * nueva se olvide para volver al "Revisa tu conexión" de antes. Las server
 * actions salen todas por `fetch` (el router de Next lo llama por su nombre
 * global en cada envío), así que mirando aquí no se escapa ninguna.
 *
 * QUÉ NO HACE, y es lo que lo vuelve inofensivo: no toca la petición ni la
 * respuesta. Devuelve LA MISMA promesa que el `fetch` de verdad y sólo lee una
 * cabecera de la respuesta por una rama aparte; si esa lectura fallara, quien
 * hizo la petición no se entera.
 */
export function vigilarAccionesCaducadas(): () => void {
  if (typeof window === "undefined" || typeof window.fetch !== "function") {
    return () => {};
  }
  vigilantes++;
  if (!fetchVigilado) {
    const original = window.fetch;
    const vigilado: typeof window.fetch = (...args) => {
      const promesa = original.apply(window, args);
      promesa.then(
        (res) => {
          try {
            if (res.headers.get(CABECERA_ACCION_DESCONOCIDA) === "1") {
              avisarVersionCaducada();
            }
          } catch {
            /* una respuesta que no deja leer cabeceras no es la que se busca */
          }
        },
        () => {
          /* sin red: ése sí es un fallo de conexión, y no es asunto de aquí */
        },
      );
      return promesa;
    };
    fetchOriginal = original;
    fetchVigilado = vigilado;
    window.fetch = vigilado;
  }
  return () => {
    vigilantes = Math.max(0, vigilantes - 1);
    if (vigilantes > 0) return;
    // Sólo se deshace si nadie ha envuelto `fetch` por encima después; si lo
    // han hecho, quitar el nuestro rompería su cadena, así que se queda (es
    // transparente) y no se vuelve a envolver.
    if (fetchOriginal && window.fetch === fetchVigilado) {
      window.fetch = fetchOriginal;
      fetchOriginal = null;
      fetchVigilado = null;
    }
  };
}

/**
 * El identificador del despliegue que está sirviendo AHORA el servidor, o null
 * si no se puede saber (sin red, sin la ruta, sin identificador propio con el
 * que compararlo).
 *
 * Contrato de la ruta: `GET /api/version` responde `{ "build": "<id>" }` con
 * `Cache-Control: no-store`. El service worker no toca /api.
 */
export async function buildDelServidor(): Promise<string | null> {
  if (!BUILD_ID) return null;
  try {
    const res = await fetch("/api/version", { cache: "no-store" });
    if (!res.ok) return null;
    const datos: unknown = await res.json();
    const build =
      datos && typeof datos === "object"
        ? (datos as { build?: unknown }).build
        : null;
    return typeof build === "string" && build ? build : null;
  } catch {
    return null;
  }
}

const tieneServiceWorker = (): boolean =>
  typeof navigator !== "undefined" && "serviceWorker" in navigator;

/**
 * Recarga la app PIDIENDO LA VERSIÓN NUEVA.
 *
 * Un `location.reload()` a secas pasa por el service worker, que con mala
 * cobertura sirve la copia guardada a los cuatro segundos (public/sw.js): justo
 * la versión que se quería dejar atrás. El mensaje "SIN_PLAZO" le pide que,
 * para esta recarga, espere a la red.
 */
export function recargarApp(): void {
  if (typeof window === "undefined") return;
  try {
    if (tieneServiceWorker()) {
      navigator.serviceWorker.controller?.postMessage("SIN_PLAZO");
    }
  } catch {
    /* sin service worker la recarga ya va directa a la red */
  }
  window.location.reload();
}

/**
 * "Buscar actualización y recargar" de Ajustes: primero le pide al navegador
 * que compruebe si hay service worker nuevo y luego recarga. La comprobación
 * tiene plazo: sin red no puede dejar el botón colgado.
 */
export async function buscarActualizacionYRecargar(): Promise<void> {
  try {
    if (tieneServiceWorker()) {
      const registro = await navigator.serviceWorker.getRegistration();
      if (registro) {
        await Promise.race([
          registro.update(),
          new Promise((resolve) => window.setTimeout(resolve, 4000)),
        ]);
      }
    }
  } catch {
    /* sin red o sin registro: se recarga igual, que es lo que se ha pedido */
  }
  recargarApp();
}

/**
 * La versión del service worker que controla la página ("v10"), o null si no
 * hay ninguno o no contesta. Es la otra mitad de "qué versión corre": el
 * identificador de build dice qué JavaScript, y esto dice qué caché.
 */
export function versionDelServiceWorker(plazoMs = 1500): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      if (!tieneServiceWorker() || typeof MessageChannel === "undefined") {
        resolve(null);
        return;
      }
      const sw = navigator.serviceWorker.controller;
      if (!sw) {
        resolve(null);
        return;
      }
      const canal = new MessageChannel();
      const plazo = window.setTimeout(() => resolve(null), plazoMs);
      canal.port1.onmessage = (e: MessageEvent) => {
        window.clearTimeout(plazo);
        resolve(typeof e.data === "string" ? e.data : null);
      };
      sw.postMessage("VERSION", [canal.port2]);
    } catch {
      resolve(null);
    }
  });
}
