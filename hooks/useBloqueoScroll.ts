"use client";

import { useEffect } from "react";

/**
 * BLOQUEO DEL SCROLL DE FONDO QUE FUNCIONA EN iOS.
 *
 * POR QUÉ NO VALE `body.style.overflow = "hidden"`: es lo que hacen hoy
 * components/ui/Sheet.tsx y components/GlobalSearch.tsx, y en Safari de iOS no
 * bloquea nada. Ahí el documento sigue desplazándose con el dedo aunque el body
 * lleve overflow hidden (WebKit sólo lo respeta cuando el elemento que se
 * desplaza es el propio body con altura acotada, y el nuestro no lo es). El
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
 * CÓMO SE CONECTA (para el bloque de coherencia): sustituir en Sheet.tsx y en
 * GlobalSearch.tsx el efecto que escribe `document.body.style.overflow` por
 *
 *     useBloqueoScroll(open);
 *
 * y nada más: el hook ya limpia al desmontar y al cambiar `open` a false.
 * Quien no pueda usar un hook (código fuera de React) tiene `bloquearScroll()`
 * y `liberarScroll()`, que son la misma pareja sin envoltorio.
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

/** Bloquea el scroll de fondo mientras `activo` sea true. */
export function useBloqueoScroll(activo: boolean): void {
  useEffect(() => {
    if (!activo) return;
    bloquearScroll();
    return liberarScroll;
  }, [activo]);
}
