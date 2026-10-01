"use client";

import { useEffect } from "react";

/**
 * EL FONDO QUIETO MIENTRAS HAY UNA CAPA ABIERTA. DOS MECANISMOS, UNO CONECTADO.
 *
 * ESTE FICHERO TIENE DOS PAREJAS Y CONVIENE SABER CUÁL SE USA:
 *
 *  · `useFondoQuieto` (al final del fichero) es LA QUE ESTÁ CONECTADA en
 *    components/ui/Sheet.tsx, components/GlobalSearch.tsx y
 *    components/CardDetailModal.tsx. Es la variante conservadora: no mueve ni
 *    fija nada, sólo impide que un arrastre que no tiene dónde desplazarse
 *    dentro de la capa acabe moviendo la página de detrás.
 *  · `useBloqueoScroll` (justo debajo) es la variante fuerte, la del body
 *    fijo. SIGUE SIN CONECTAR A PROPÓSITO; el motivo está en "POR QUÉ NO SE HA
 *    CONECTADO", más abajo. No es código muerto que haya que borrar: es el
 *    siguiente paso el día que se pueda probar en un iPhone.
 *
 * POR QUÉ NO BASTA `body.style.overflow = "hidden"`, que es lo que hacían las
 * capas a mano: en Safari de iOS no es fiable. Durante años no bloqueó nada
 * (WebKit sólo lo respetaba cuando el elemento que se desplaza es el propio
 * body con altura acotada, y el nuestro no lo es), y aun donde ya lo respeta,
 * con el teclado abierto la página entera se sigue pudiendo arrastrar. El
 * resultado es el clásico: abres una hoja, arrastras dentro de ella y la página
 * de detrás se va hacia arriba; al cerrar, ya no estás donde estabas.
 *
 * EL MECANISMO QUE SÍ FUNCIONA: convertir el body en `position: fixed` a la
 * altura exacta a la que estaba (`top: -scrollY`). Así el documento no tiene
 * nada que desplazar, la página de detrás se ve exactamente igual (está pintada
 * en el mismo sitio, sólo que clavada) y, al soltar, se devuelve el scroll al
 * valor guardado en el mismo fotograma en que el body vuelve a ser estático.
 * `left/right: 0` y `width: 100%` conservan el ancho; sin ellos un body fijo
 * encoge al ancho de su contenido.
 *
 * SE CUENTA, NO SE MARCA. Dos capas pueden bloquear a la vez (el detalle de una
 * carta abierto desde una hoja) y la que se cierra primero no puede devolver el
 * scroll mientras la otra sigue abierta. Por eso hay un contador de módulo: se
 * fija con el primero y se libera con el último, como los oyentes de
 * hooks/useViewport.ts.
 *
 * LENIS: components/SmoothScroll.tsx lo monta sólo con ratón y sin "reducir
 * movimiento". Con el body fijo, Lenis no tiene recorrido que suavizar y se
 * queda quieto solo; al liberar, el `scrollTo` es instantáneo (`behavior:
 * "instant"`) para que ni Lenis ni `scroll-behavior: smooth` del <html> lo
 * conviertan en un viaje animado de vuelta.
 *
 * POR QUÉ NO SE HA CONECTADO (el body fijo): la barra superior es
 * `sticky top-0` (components/TopBar.tsx) y lo que la mantiene arriba es el
 * scroll del documento. Con el body fijo en `top: -scrollY` el documento deja
 * de tener scroll (queda en 0) y la barra vuelve a su sitio natural, que es el
 * principio del body: se va hacia arriba con la página y desaparece detrás del
 * telón mientras dure la capa. El telón es translúcido y desenfoca, así que el
 * hueco se ve. Arreglarlo exige tocar la barra (que este hook publique el
 * desplazamiento en una variable CSS y la barra se compense con `top`, no con
 * un transform) y comprobarlo en un iPhone real, que es justo lo que no se
 * puede hacer desde un emulador: en Chromium `overflow: hidden` ya bloquea el
 * fondo, así que ahí no se ve ni el fallo ni si el arreglo lo cura.
 *
 * CÓMO SE CONECTARÍA, cuando se pueda probar: cambiar `useFondoQuieto(x)` por
 * `useBloqueoScroll(x)` en las tres capas de arriba (y en
 * components/social/TradeBuilder.tsx y la apertura de sobre de app/page.tsx,
 * que hoy escriben el overflow a mano) y resolver antes lo de la barra. Quien
 * no pueda usar un hook (código fuera de React) tiene `bloquearScroll()` y
 * `liberarScroll()`, que son la misma pareja sin envoltorio.
 */

let capas = 0;
let scrollGuardado = 0;
/** Lo que llevaba el body antes de fijarlo, para devolverlo tal cual. */
let estilosPrevios: {
  position: string;
  top: string;
  left: string;
  right: string;
  width: string;
  overflow: string;
} | null = null;

export function bloquearScroll(): void {
  if (typeof document === "undefined") return;
  capas += 1;
  if (capas > 1) return;

  const body = document.body;
  scrollGuardado = window.scrollY;
  estilosPrevios = {
    position: body.style.position,
    top: body.style.top,
    left: body.style.left,
    right: body.style.right,
    width: body.style.width,
    overflow: body.style.overflow,
  };
  body.style.position = "fixed";
  body.style.top = `-${scrollGuardado}px`;
  body.style.left = "0";
  body.style.right = "0";
  body.style.width = "100%";
  // También overflow hidden: en escritorio basta con esto y evita que la
  // rueda del ratón desplace un body fijo más alto que la ventana.
  body.style.overflow = "hidden";
}

export function liberarScroll(): void {
  if (typeof document === "undefined") return;
  if (capas === 0) return;
  capas -= 1;
  if (capas > 0) return;

  const body = document.body;
  if (estilosPrevios) {
    body.style.position = estilosPrevios.position;
    body.style.top = estilosPrevios.top;
    body.style.left = estilosPrevios.left;
    body.style.right = estilosPrevios.right;
    body.style.width = estilosPrevios.width;
    body.style.overflow = estilosPrevios.overflow;
    estilosPrevios = null;
  }
  // Instantáneo: el body acaba de volver a ser estático y el documento está en
  // 0; hay que devolverlo a donde estaba en este mismo fotograma, sin animación.
  window.scrollTo({ top: scrollGuardado, left: 0, behavior: "instant" });
}

/** Bloquea el scroll de fondo mientras `activo` sea true. (Variante del body
 *  fijo: sin conectar, ver la cabecera.) */
export function useBloqueoScroll(activo: boolean): void {
  useEffect(() => {
    if (!activo) return;
    bloquearScroll();
    return liberarScroll;
  }, [activo]);
}

/* ==================================================================== *
 * LA VARIANTE CONSERVADORA: useFondoQuieto
 * ====================================================================
 *
 * No fija el body ni cambia su posición, así que no puede mover la barra
 * superior ni perder el sitio de la página. Hace dos cosas:
 *
 *  1. `overflow: hidden` en el body, como antes, pero CONTADO. Cada capa
 *     guardaba el valor que veía al abrirse y lo devolvía al cerrarse; con dos
 *     capas a la vez (la ficha de una carta abierta desde el buscador), la que
 *     se cerraba en segundo lugar devolvía el "hidden" que había visto y la
 *     página se quedaba sin scroll. Con un contador de módulo se pone con la
 *     primera y se quita con la última.
 *
 *  2. Corta el `touchmove` que no tiene dónde desplazarse. Es lo que de verdad
 *     arregla el iPhone: el fondo sólo se mueve si el navegador decide que ese
 *     arrastre le toca al documento, y se lo decide cuando el dedo cae en el
 *     telón, en una hoja corta que no desborda (una confirmación) o, en los
 *     iOS que no conocen `overscroll-behavior`, en una lista que ya está en su
 *     tope. En esos casos se cancela el gesto nativo antes de que empiece. Si
 *     el dedo está dentro de algo que SÍ puede desplazarse, no se toca nada y
 *     el scroll es el de siempre, con su inercia y su rebote.
 *
 * LO QUE NO SE CANCELA NUNCA, y cada excepción es un fallo que este patrón ha
 * causado en otras aplicaciones:
 *  · un toque sobre un campo de texto, un <select> o un deslizador (`input`):
 *    mover el cursor, arrastrar el tirador de selección y mover un `range`
 *    son gestos nativos que también llegan como touchmove;
 *  · dos dedos: es el pellizco de CardZoom, que ya gestiona lo suyo;
 *  · un evento que ya no es cancelable: el navegador ha empezado a desplazar
 *    y llamar a preventDefault ahí sólo escribe un aviso en la consola.
 *
 * Los gestos propios (useSwipe, el pellizco) van por eventos de puntero y no
 * se enteran: cancelar el touchmove sólo le quita el gesto al navegador.
 *
 * El oyente tiene que ser `passive: false` para poder cancelar, y por eso sólo
 * vive mientras hay alguna capa abierta: un touchmove no pasivo en el
 * documento obliga al navegador a esperar a JavaScript antes de empezar cada
 * desplazamiento, y eso no se le hace a la página entera todo el rato.
 */

let capasQuietas = 0;
let overflowPrevio = "";
/** Dónde empezó el toque en curso: de ahí sale hacia dónde va el dedo. */
let toqueX = 0;
let toqueY = 0;

const CAMPOS = 'input, textarea, select, [contenteditable="true"]';

/**
 * ¿Puede `el` quedarse con este arrastre, en el eje que sea?
 *
 * NO SE CLASIFICA EL GESTO EN "VERTICAL" U "HORIZONTAL" PARA DECIDIR, y es a
 * propósito. En iOS, cancelar UN touchmove antes de que empiece el scroll
 * cancela el gesto nativo para todo el toque. El primer movimiento que llega
 * mide un par de píxeles y es casi ruido: un dedo que va a desplazar una lista
 * hacia abajo arranca a menudo con más deriva lateral que vertical. Si aquí se
 * dijera "esto es horizontal y esta lista sólo va en vertical, se cancela", esa
 * lista dejaría de desplazarse uno de cada tantos intentos. Así que basta con
 * que el elemento desborde en CUALQUIERA de los dos ejes para dejarle el gesto.
 */
function puedeAbsorber(el: HTMLElement, dx: number, dy: number): boolean {
  const recorridoY = el.scrollHeight - el.clientHeight;
  const recorridoX = el.scrollWidth - el.clientWidth;
  // Primero la medida, que es barata: casi ningún ancestro desborda y así no
  // se paga un getComputedStyle por cada uno en cada movimiento.
  if (recorridoY <= 1 && recorridoX <= 1) return false;
  const estilo = getComputedStyle(el);
  return (
    absorbeEnEje(
      recorridoY,
      estilo.overflowY,
      estilo.overscrollBehaviorY,
      el.scrollTop,
      dy,
    ) ||
    absorbeEnEje(
      recorridoX,
      estilo.overflowX,
      estilo.overscrollBehaviorX,
      el.scrollLeft,
      dx,
    )
  );
}

function absorbeEnEje(
  recorrido: number,
  overflow: string,
  contencion: string | undefined,
  posicion: number,
  delta: number,
): boolean {
  if (recorrido <= 1) return false;
  if (overflow !== "auto" && overflow !== "scroll") return false;
  // Con `overscroll-behavior: contain` (lo lleva .scroll-area) el propio
  // navegador impide que el rebote del tope se le pase al documento: se le
  // deja el gesto entero y conserva su rebote nativo. En iOS anterior a 16 la
  // propiedad no existe (sale undefined) y se cae a la comprobación de abajo.
  if (contencion === "contain" || contencion === "none") return true;
  // Sin contención, sólo es suyo si le queda recorrido hacia ese lado: en el
  // tope, el navegador le pasaría el arrastre al documento. Dedo hacia abajo
  // (delta > 0) = el contenido baja = hace falta scroll por encima; dedo hacia
  // arriba = hace falta scroll por debajo. Sin movimiento en este eje todavía
  // (delta 0) no hay nada que decidir: se le deja.
  if (delta === 0) return true;
  return delta > 0 ? posicion > 0 : posicion < recorrido - 1;
}

function alEmpezarToque(e: TouchEvent): void {
  if (e.touches.length !== 1) return;
  toqueX = e.touches[0].clientX;
  toqueY = e.touches[0].clientY;
}

function alMoverToque(e: TouchEvent): void {
  if (!e.cancelable || e.touches.length !== 1) return;
  const destino = e.target instanceof Element ? e.target : null;
  if (!destino || destino.closest(CAMPOS)) return;

  const dx = e.touches[0].clientX - toqueX;
  const dy = e.touches[0].clientY - toqueY;

  // Se sube desde lo tocado: si alguien por el camino puede desplazarse, el
  // gesto es suyo. Se para ANTES del body: lo que se quiere impedir es
  // precisamente que el arrastre llegue al documento.
  for (
    let el: Element | null = destino;
    el && el !== document.body && el !== document.documentElement;
    el = el.parentElement
  ) {
    if (el instanceof HTMLElement && puedeAbsorber(el, dx, dy)) return;
  }
  e.preventDefault();
}

export function aquietarFondo(): void {
  if (typeof document === "undefined") return;
  capasQuietas += 1;
  if (capasQuietas > 1) return;
  overflowPrevio = document.body.style.overflow;
  document.body.style.overflow = "hidden";
  document.addEventListener("touchstart", alEmpezarToque, { passive: true });
  document.addEventListener("touchmove", alMoverToque, { passive: false });
}

export function soltarFondo(): void {
  if (typeof document === "undefined") return;
  if (capasQuietas === 0) return;
  capasQuietas -= 1;
  if (capasQuietas > 0) return;
  document.body.style.overflow = overflowPrevio;
  document.removeEventListener("touchstart", alEmpezarToque);
  document.removeEventListener("touchmove", alMoverToque);
}

/** Deja quieta la página de detrás mientras `activo` sea true. */
export function useFondoQuieto(activo: boolean): void {
  useEffect(() => {
    if (!activo) return;
    aquietarFondo();
    return soltarFondo;
  }, [activo]);
}
