"use client";

import { useEffect, useRef, type RefObject } from "react";

export type SwipeAxis = "x" | "y" | "both";

export interface SwipeOptions {
  onSwipeLeft?: () => void;
  onSwipeRight?: () => void;
  onSwipeUp?: () => void;
  onSwipeDown?: () => void;
  /** Eje permitido. El resto de direcciones se devuelven al scroll nativo. */
  axis?: SwipeAxis;
  /** Distancia mínima en px para que cuente como gesto. */
  threshold?: number;
  /** Velocidad mínima en px/s que dispara el gesto aunque no llegue al umbral. */
  velocity?: number;
  /** El elemento acompaña al dedo mientras se arrastra. */
  follow?: boolean;
  /**
   * Elemento que recibe el transform, si no es el que escucha el gesto.
   * Sirve para arrastrar un panel entero tirando sólo de su asa.
   */
  followTarget?: RefObject<HTMLElement | null>;
  /** Grados de giro por cada 100px de arrastre horizontal (tacto de carta). */
  rotate?: number;
  /** Resistencia al arrastrar en una dirección sin manejador (0-1). */
  resistance?: number;
  enabled?: boolean;
  onStart?: () => void;
  /** Recibe el desplazamiento en curso, por si hace falta pintar algo. */
  onMove?: (dx: number, dy: number) => void;
  onEnd?: () => void;
}

const DEFAULTS = {
  axis: "x" as SwipeAxis,
  threshold: 70,
  velocity: 420,
  follow: true,
  rotate: 0,
  resistance: 0.35,
  enabled: true,
};

// Píxeles antes de decidir si el gesto es horizontal o vertical.
const LOCK_DISTANCE = 8;
// Un toque no debería moverse más que esto.
const TAP_SLOP = 10;
// Desplazamiento mínimo para que la VELOCIDAD pueda disparar el gesto. Un toque
// rápido deriva unos pocos píxeles y su velocidad sale enorme (8px en 15ms son
// 533 px/s): sin esta distancia, ese roce contaba como deslizamiento y además
// se tragaba el click. El camino por umbral (threshold) no la necesita.
const FLICK_DISTANCE = 30;

/**
 * Gestos de deslizamiento con eventos de puntero puros.
 *
 * Se implementa a mano en lugar de con el `drag` de framer-motion por dos
 * razones: el arrastre se pinta escribiendo el transform directamente (sin
 * re-render de React en cada movimiento, así que va suave incluso en listas
 * grandes), y la detección no depende del bucle de animación, de modo que
 * responde igual aunque el navegador lo tenga frenado.
 *
 * Devuelve `didSwipeRef`: true justo después de un gesto, para que el `click`
 * sintético que el navegador emite a continuación no se procese como toque.
 */
export function useSwipe(
  ref: RefObject<HTMLElement | null>,
  options: SwipeOptions,
) {
  const optsRef = useRef(options);
  optsRef.current = options;
  const didSwipeRef = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const cfg = () => ({ ...DEFAULTS, ...optsRef.current });
    if (!cfg().enabled) return;

    let startX = 0;
    let startY = 0;
    let startT = 0;
    let lastX = 0;
    let lastY = 0;
    let lastT = 0;
    let locked: "x" | "y" | null = null;
    let active = false;
    let pointerId = -1;

    // El transform puede ir a otro elemento: así se arrastra un panel entero
    // tirando sólo de su asa.
    const moved = () => optsRef.current.followTarget?.current ?? el;

    const setTransform = (dx: number, dy: number) => {
      const { follow, rotate, axis } = cfg();
      if (!follow) return;
      const tx = axis === "y" ? 0 : dx;
      const ty = axis === "x" ? 0 : dy;
      const deg = rotate ? (tx / 100) * rotate : 0;
      moved().style.transform = `translate3d(${tx}px, ${ty}px, 0)${deg ? ` rotate(${deg}deg)` : ""}`;
    };

    const release = (animate: boolean) => {
      const target = moved();
      if (animate) {
        target.style.transition = "transform 0.32s cubic-bezier(0.32, 0.72, 0, 1)";
        target.style.transform = "";
        window.setTimeout(() => {
          target.style.transition = "";
          // Se libera la capa: un will-change permanente deja la textura
          // rasterizada a una escala fija y el contenido se ve borroso.
          target.style.willChange = "";
        }, 340);
      } else {
        target.style.transition = "";
        target.style.transform = "";
        target.style.willChange = "";
      }
    };

    const onPointerDown = (e: PointerEvent) => {
      if (!cfg().enabled) return;
      if (e.button !== 0) return;
      // Segundo dedo: es un pellizco, no un deslizamiento. Se abandona el
      // gesto; en CardZoom eso le cede el control a su zoom propio.
      if (active) {
        active = false;
        locked = null;
        release(true);
        return;
      }
      active = true;
      pointerId = e.pointerId;
      startX = lastX = e.clientX;
      startY = lastY = e.clientY;
      startT = lastT = e.timeStamp || performance.now();
      locked = null;
      el.style.transition = "";
      // Sólo mientras dura el gesto, nunca de forma permanente.
      moved().style.willChange = "transform";
      cfg().onStart?.();
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!active || e.pointerId !== pointerId) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      if (!locked) {
        const adx = Math.abs(dx);
        const ady = Math.abs(dy);
        if (Math.max(adx, ady) < LOCK_DISTANCE) return;
        locked = adx > ady ? "x" : "y";
        const { axis } = cfg();
        // Si el eje no es el nuestro, soltamos el gesto para no robarle el
        // scroll a la página.
        if (axis !== "both" && locked !== axis) {
          active = false;
          release(false);
          return;
        }
      }

      lastX = e.clientX;
      lastY = e.clientY;
      lastT = e.timeStamp || performance.now();

      const { resistance, onSwipeLeft, onSwipeRight, onSwipeUp, onSwipeDown } =
        cfg();
      // Sin manejador en esa dirección, el arrastre ofrece resistencia en vez
      // de moverse en balde.
      let ax = dx;
      let ay = dy;
      if (dx < 0 && !onSwipeLeft) ax = dx * resistance;
      if (dx > 0 && !onSwipeRight) ax = dx * resistance;
      if (dy < 0 && !onSwipeUp) ay = dy * resistance;
      if (dy > 0 && !onSwipeDown) ay = dy * resistance;

      setTransform(ax, ay);
      cfg().onMove?.(ax, ay);
    };

    const finish = (e: PointerEvent) => {
      if (!active || e.pointerId !== pointerId) return;
      active = false;

      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const dt = Math.max(1, (e.timeStamp || performance.now()) - startT);
      const vx = (dx / dt) * 1000;
      const vy = (dy / dt) * 1000;

      const {
        threshold,
        velocity,
        onSwipeLeft,
        onSwipeRight,
        onSwipeUp,
        onSwipeDown,
      } = cfg();

      let fired = false;
      if (locked === "x") {
        if (
          (dx <= -threshold || (vx <= -velocity && dx <= -FLICK_DISTANCE)) &&
          onSwipeLeft
        ) {
          onSwipeLeft();
          fired = true;
        } else if (
          (dx >= threshold || (vx >= velocity && dx >= FLICK_DISTANCE)) &&
          onSwipeRight
        ) {
          onSwipeRight();
          fired = true;
        }
      } else if (locked === "y") {
        if (
          (dy <= -threshold || (vy <= -velocity && dy <= -FLICK_DISTANCE)) &&
          onSwipeUp
        ) {
          onSwipeUp();
          fired = true;
        } else if (
          (dy >= threshold || (vy >= velocity && dy >= FLICK_DISTANCE)) &&
          onSwipeDown
        ) {
          onSwipeDown();
          fired = true;
        }
      }

      // Marcamos el gesto para que el click sintético posterior se ignore.
      didSwipeRef.current =
        fired || Math.abs(dx) > TAP_SLOP || Math.abs(dy) > TAP_SLOP;
      if (didSwipeRef.current) {
        window.setTimeout(() => {
          didSwipeRef.current = false;
        }, 120);
      }

      // Si el gesto se confirmó, el contenido ya ha cambiado: volver animando
      // haría que la carta nueva entrase deslizándose hacia atrás. Se recoloca
      // en seco y que la animación de entrada haga su trabajo.
      release(!fired);
      locked = null;
      cfg().onEnd?.();
    };

    el.addEventListener("pointerdown", onPointerDown);
    // En window para que el gesto sobreviva a salirse del elemento.
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);

    return () => {
      el.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      el.style.transform = "";
      el.style.transition = "";
    };
  }, [ref, options.enabled]);

  return didSwipeRef;
}

/**
 * `touch-action` correcto para cada eje. El zoom de página está apagado en
 * toda la app (meta viewport + touch-action del body): aquí sólo se decide
 * qué paneo se le cede al navegador para no robarle el scroll. El pellizco
 * sobre la carta lo implementa CardZoom por su cuenta.
 */
export function touchActionFor(axis: SwipeAxis): string {
  if (axis === "x") return "pan-y";
  if (axis === "y") return "pan-x";
  return "none";
}
