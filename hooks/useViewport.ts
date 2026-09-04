"use client";

import { useSyncExternalStore } from "react";
import { isIOS, isSafari, isStandaloneDisplay } from "../utils/platform";

/**
 * Mantiene sincronizadas con el viewport real las variables CSS que usa el
 * layout. En iOS la barra de Safari y el teclado cambian el alto visible sin
 * que `100vh` se entere, así que medimos con visualViewport y lo escribimos en
 * `--app-height` / `--keyboard`.
 *
 * Además marca `data-keyboard="open"` en <html> para que el CSS pueda esconder
 * la barra de pestañas y dejar el input pegado justo encima del teclado.
 *
 * ---------------------------------------------------------------------------
 * POR QUÉ ES UN ALMACÉN DE MÓDULO Y NO UN useState POR COMPONENTE
 *
 * Antes cada `useViewport()` instalaba sus propios oyentes y guardaba su propio
 * estado, y AppShell lo llamaba para leer un solo booleano (`isKeyboardOpen`).
 * El problema es que visualViewport dispara `scroll` en CADA desplazamiento
 * del dedo en iOS (la barra de Safari se encoge píxel a píxel), y aunque el
 * setState comparaba antes de escribir, comparaba el alto SIN redondear: entre
 * 812,3 y 812,31 hay un cambio "real" para JavaScript y ninguno para el CSS,
 * que sólo ve el valor redondeado que se escribe en `--app-height`. Cada uno
 * de esos re-renders arrastraba a Sidebar, TopBar y BottomNav —todo el cromo—
 * mientras se hacía scroll, que es justo cuando menos sobra el tiempo.
 *
 * Ahora la medida vive UNA vez a nivel de módulo:
 *  · sólo cambia (y sólo avisa) cuando cambia lo que se escribe en el DOM,
 *    o sea el alto y el teclado ya REDONDEADOS: si `--app-height` no cambia,
 *    nadie se entera;
 *  · `useViewport()` sigue devolviendo lo mismo de siempre, para quien
 *    necesite las medidas;
 *  · `useKeyboardOpen()` devuelve sólo el booleano, y con useSyncExternalStore
 *    React descarta el render mientras el booleano no cambie de valor. Es lo
 *    que consume AppShell: el cromo ya no se repinta por un scroll.
 */

// Por debajo de esto lo que se mueve es la barra del navegador, no el teclado.
const KEYBOARD_THRESHOLD = 90;

export interface ViewportState {
  height: number;
  keyboardHeight: number;
  isKeyboardOpen: boolean;
}

/** Lo que ve el servidor (y el primer render de hidratación): nada medido. */
const SIN_MEDIR: ViewportState = { height: 0, keyboardHeight: 0, isKeyboardOpen: false };

let estado: ViewportState = SIN_MEDIR;
const oyentes = new Set<() => void>();
let instalado = false;

function medir() {
  const root = document.documentElement;
  const vv = window.visualViewport;

  // Con un pellizco para ampliar, vv.height viene dividido por la escala:
  // la diferencia con innerHeight es enorme y se confundiría con el
  // teclado, encogiendo --app-height a media pantalla y escondiendo la
  // barra de pestañas. Mientras dura el zoom no se toca nada; al volver a
  // escala 1 llega otro evento y se recalcula.
  if (vv && vv.scale > 1.01) return;

  const bruto = vv ? vv.height : window.innerHeight;
  // --app-height es la unidad de la que cuelga TODO el layout: los paneles,
  // los topes de las hojas y CARD_WIDTH. Una lectura transitoria de 0 (o
  // absurda) del visualViewport la propagaba tal cual y colapsaba la
  // interfaz entera a tamaño cero, sin forma de recuperarse hasta el
  // siguiente evento. Ante una medida imposible se conserva la anterior.
  if (!Number.isFinite(bruto) || bruto < 120) return;

  const rawKeyboard = vv ? window.innerHeight - vv.height - vv.offsetTop : 0;
  // REDONDEADOS ANTES DE COMPARAR: es lo que se escribe en el CSS y por tanto
  // lo único que puede cambiar algo en pantalla. Ver la cabecera.
  const height = Math.round(bruto);
  const keyboardHeight = rawKeyboard > KEYBOARD_THRESHOLD ? Math.round(rawKeyboard) : 0;
  if (height === estado.height && keyboardHeight === estado.keyboardHeight) return;

  const isKeyboardOpen = keyboardHeight > 0;
  root.style.setProperty("--app-height", `${height}px`);
  root.style.setProperty("--keyboard", `${keyboardHeight}px`);
  if (isKeyboardOpen) root.setAttribute("data-keyboard", "open");
  else root.removeAttribute("data-keyboard");

  estado = { height, keyboardHeight, isKeyboardOpen };
  oyentes.forEach((cb) => cb());
}

function instalar() {
  if (instalado) return;
  instalado = true;
  const vv = window.visualViewport;
  if (vv) {
    vv.addEventListener("resize", medir);
    vv.addEventListener("scroll", medir);
  }
  window.addEventListener("resize", medir);
  window.addEventListener("orientationchange", medir);
  medir();
}

function desinstalar() {
  if (!instalado) return;
  instalado = false;
  const vv = window.visualViewport;
  if (vv) {
    vv.removeEventListener("resize", medir);
    vv.removeEventListener("scroll", medir);
  }
  window.removeEventListener("resize", medir);
  window.removeEventListener("orientationchange", medir);
}

/** Suscripción para useSyncExternalStore. Los oyentes del DOM se instalan con
 *  el primer suscriptor y se retiran con el último. */
function suscribir(cb: () => void) {
  oyentes.add(cb);
  instalar();
  return () => {
    oyentes.delete(cb);
    if (oyentes.size === 0) desinstalar();
  };
}

const leerEstado = () => estado;
const leerEstadoServidor = () => SIN_MEDIR;
const leerTeclado = () => estado.isKeyboardOpen;
const leerTecladoServidor = () => false;

/** Alto visible y teclado. Re-renderiza sólo cuando cambia la medida REDONDEADA. */
export function useViewport(): ViewportState {
  return useSyncExternalStore(suscribir, leerEstado, leerEstadoServidor);
}

/**
 * Sólo "¿hay teclado?". Es lo que necesita AppShell para retirar la barra de
 * pestañas, y con esto el cromo no se repinta con cada scroll del visualViewport:
 * useSyncExternalStore descarta el render mientras el booleano no cambie.
 */
export function useKeyboardOpen(): boolean {
  return useSyncExternalStore(suscribir, leerTeclado, leerTecladoServidor);
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
