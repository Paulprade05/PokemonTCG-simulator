"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { useHaptics } from "../../hooks/useHaptics";
import { useSwipe } from "../../hooks/useSwipe";

interface CardZoomProps {
  open: boolean;
  src?: string;
  alt?: string;
  onClose: () => void;
  /** Navegación opcional entre cartas, para no perderla al ampliar. */
  onPrev?: () => void;
  onNext?: () => void;
  caption?: string;
}

/** Ampliación máxima del pellizco. */
const MAX_SCALE = 3;
/** Por debajo de esto, al soltar, la carta vuelve sola a tamaño natural. */
const SNAP_SCALE = 1.06;
/** Escala del doble toque. */
const DOUBLE_TAP_SCALE = 2.2;

/**
 * Sólo la carta, a pantalla completa. Se balancea al arrastrarla, se cierra
 * deslizando hacia abajo y —siendo el único sitio de la app donde el zoom
 * tiene sentido— se amplía con un pellizco o un doble toque. El zoom de
 * página está apagado en toda la PWA (meta viewport + touch-action), así que
 * el pellizco se implementa aquí a mano con eventos de puntero: escala y
 * desplazamiento se escriben directamente al estilo (sin re-render por
 * movimiento) y el estado de React sólo guarda el booleano "está ampliada",
 * que apaga el gesto de inclinar/cerrar mientras se navega por la carta.
 *
 * Va en un portal a <body> porque las transiciones de ruta envuelven la página
 * en un elemento con transform, y un ancestro transformado crea bloque
 * contenedor para los position:fixed: sin el portal no cubriría la pantalla.
 */
export default function CardZoom({
  open,
  src,
  alt,
  onClose,
  onPrev,
  onNext,
  caption,
}: CardZoomProps) {
  const haptic = useHaptics();
  const surfaceRef = useRef<HTMLDivElement>(null);
  /** Capa de escala + desplazamiento del pellizco (envuelve a la inclinación). */
  const zoomRef = useRef<HTMLDivElement>(null);
  const tiltRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);
  /** true mientras la carta está ampliada: cambia gestos y rótulo. */
  const [zoomActive, setZoomActive] = useState(false);

  // Estado del pellizco fuera de React: se escribe en cada movimiento.
  const scaleRef = useRef(1);
  const offsetRef = useRef({ x: 0, y: 0 });
  const pointersRef = useRef(
    new Map<
      number,
      {
        x: number;
        y: number;
        downX: number;
        downY: number;
        t: number;
        /** Participó en un pellizco: su pointerup nunca cuenta como toque. */
        pinched: boolean;
      }
    >(),
  );
  const pinchRef = useRef<null | {
    dist: number;
    scale: number;
    midX: number;
    midY: number;
    offX: number;
    offY: number;
  }>(null);
  const panRef = useRef<null | { x: number; y: number; offX: number; offY: number }>(null);
  const lastTapRef = useRef({ t: 0, x: 0, y: 0 });

  useEffect(() => setMounted(true), []);

  const applyZoom = useCallback((animate = false) => {
    const el = zoomRef.current;
    if (!el) return;
    el.style.transition = animate
      ? "transform 0.25s cubic-bezier(0.22, 1, 0.36, 1)"
      : "";
    el.style.transform = `translate3d(${offsetRef.current.x}px, ${offsetRef.current.y}px, 0) scale(${scaleRef.current})`;
  }, []);

  /**
   * La carta no puede perderse fuera de pantalla. El límite sale del CONTENIDO,
   * no de la superficie: el borde de la carta ampliada puede llegar justo al
   * borde visible y no más allá (con la superficie como límite, en pantallas
   * anchas —móvil girado, escritorio— la carta podía salirse entera). Si en un
   * eje la carta ampliada aún cabe, en ese eje se queda centrada.
   * offsetWidth/offsetHeight son medidas de layout, ajenas al transform.
   */
  const clampOffset = useCallback(() => {
    const surf = surfaceRef.current;
    const card = zoomRef.current;
    if (!surf || !card) return;
    const maxX = Math.max(
      0,
      (card.offsetWidth * scaleRef.current - surf.clientWidth) / 2,
    );
    const maxY = Math.max(
      0,
      (card.offsetHeight * scaleRef.current - surf.clientHeight) / 2,
    );
    offsetRef.current.x = Math.max(-maxX, Math.min(maxX, offsetRef.current.x));
    offsetRef.current.y = Math.max(-maxY, Math.min(maxY, offsetRef.current.y));
  }, []);

  /**
   * Cambia la escala manteniendo fijo el punto (cx, cy) en coordenadas de
   * cliente: es lo que hace que ampliar "vaya hacia" el sitio que se toca.
   */
  const setScaleTo = useCallback(
    (target: number, cx?: number, cy?: number) => {
      const next = Math.max(1, Math.min(MAX_SCALE, target));
      const surf = surfaceRef.current?.getBoundingClientRect();
      if (surf && cx !== undefined && cy !== undefined && next > 1) {
        const relX = cx - (surf.left + surf.width / 2);
        const relY = cy - (surf.top + surf.height / 2);
        const factor = next / scaleRef.current;
        offsetRef.current.x = relX - factor * (relX - offsetRef.current.x);
        offsetRef.current.y = relY - factor * (relY - offsetRef.current.y);
      }
      scaleRef.current = next;
      if (next === 1) offsetRef.current = { x: 0, y: 0 };
      clampOffset();
      applyZoom(true);
      setZoomActive(next > 1);
    },
    [applyZoom, clampOffset],
  );

  // Cerrar o cambiar de carta devuelve el visor a su estado natural.
  useEffect(() => {
    scaleRef.current = 1;
    offsetRef.current = { x: 0, y: 0 };
    pinchRef.current = null;
    panRef.current = null;
    pointersRef.current.clear();
    setZoomActive(false);
    const el = zoomRef.current;
    if (el) {
      el.style.transition = "";
      el.style.transform = "";
    }
  }, [open, src]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" && e.key !== "ArrowRight" && e.key !== "ArrowLeft")
        return;
      // El visor es modal: estas teclas son suyas y no deben llegar a la hoja
      // o modal de debajo (que también escuchan Escape/flechas en window y
      // cerrarían la ficha o navegarían por duplicado). En fase de captura,
      // stopPropagation las corta antes de que bajen al resto de listeners.
      e.stopPropagation();
      if (e.key === "Escape") {
        // Con la carta ampliada, Escape primero la encoge; el segundo cierra.
        if (scaleRef.current > 1) setScaleTo(1);
        else onClose();
      } else if (e.key === "ArrowRight") onNext?.();
      else onPrev?.();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose, onPrev, onNext, setScaleTo]);

  const applyTilt = useCallback((dx: number, dy: number) => {
    const el = tiltRef.current;
    if (!el) return;
    const clamp = (v: number, max: number) => Math.max(-max, Math.min(max, v));
    el.style.transition = "";
    el.style.transform =
      `perspective(1000px) rotateY(${clamp(dx * 0.22, 30)}deg) ` +
      `rotateX(${clamp(-dy * 0.14, 18)}deg) translate3d(${dx * 0.25}px, ${dy * 0.25}px, 0)`;
  }, []);

  const resetTilt = useCallback(() => {
    const el = tiltRef.current;
    if (!el) return;
    el.style.transition = "transform 0.6s cubic-bezier(0.22, 1.4, 0.36, 1)";
    el.style.transform = "";
    window.setTimeout(() => {
      if (el) el.style.transition = "";
    }, 620);
  }, []);

  // Inclinar, pasar de carta y cerrar deslizando sólo tienen sentido con la
  // carta a tamaño natural: ampliada, el dedo es para desplazarse por ella.
  useSwipe(surfaceRef, {
    axis: "both",
    threshold: 80,
    velocity: 460,
    follow: false,
    enabled: open && !zoomActive,
    onMove: applyTilt,
    onEnd: resetTilt,
    onSwipeLeft: onNext,
    onSwipeRight: onPrev,
    onSwipeDown: () => {
      haptic("tap");
      onClose();
    },
  });

  // ── Pellizco, desplazamiento y doble toque ────────────────────────────────
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    try {
      // Puede lanzar si el dedo ya se levantó (toque relámpago): sin captura
      // el gesto funciona igual mientras el puntero no salga de la superficie.
      surfaceRef.current?.setPointerCapture(e.pointerId);
    } catch {}
    pointersRef.current.set(e.pointerId, {
      x: e.clientX,
      y: e.clientY,
      downX: e.clientX,
      downY: e.clientY,
      t: performance.now(),
      pinched: false,
    });
    const pts = [...pointersRef.current.values()];
    if (pts.length === 2) {
      // El segundo dedo aborta el gesto de useSwipe sin pasar por su onEnd:
      // si la carta venía inclinándose, sin esto se quedaría torcida durante
      // todo el zoom (el swipe, que es quien la endereza, queda apagado).
      resetTilt();
      pts[0].pinched = true;
      pts[1].pinched = true;
      // Empieza el pellizco: la base congela escala y desplazamiento actuales.
      pinchRef.current = {
        dist: Math.max(1, Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)),
        scale: scaleRef.current,
        midX: (pts[0].x + pts[1].x) / 2,
        midY: (pts[0].y + pts[1].y) / 2,
        offX: offsetRef.current.x,
        offY: offsetRef.current.y,
      };
      panRef.current = null;
    } else if (pts.length === 1 && scaleRef.current > 1) {
      panRef.current = {
        x: e.clientX,
        y: e.clientY,
        offX: offsetRef.current.x,
        offY: offsetRef.current.y,
      };
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const p = pointersRef.current.get(e.pointerId);
    if (!p) return;
    p.x = e.clientX;
    p.y = e.clientY;
    const pts = [...pointersRef.current.values()];
    const base = pinchRef.current;
    if (base && pts.length >= 2) {
      const dist = Math.max(1, Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y));
      const midX = (pts[0].x + pts[1].x) / 2;
      const midY = (pts[0].y + pts[1].y) / 2;
      const next = Math.max(1, Math.min(MAX_SCALE, base.scale * (dist / base.dist)));
      const surf = surfaceRef.current?.getBoundingClientRect();
      if (surf) {
        // El punto entre los dedos se queda quieto mientras la escala cambia,
        // y el arrastre conjunto de los dos dedos desplaza la carta.
        const relX = base.midX - (surf.left + surf.width / 2);
        const relY = base.midY - (surf.top + surf.height / 2);
        const factor = next / base.scale;
        offsetRef.current.x = relX - factor * (relX - base.offX) + (midX - base.midX);
        offsetRef.current.y = relY - factor * (relY - base.offY) + (midY - base.midY);
      }
      scaleRef.current = next;
      clampOffset();
      applyZoom(false);
    } else if (panRef.current && pts.length === 1 && scaleRef.current > 1) {
      offsetRef.current.x = panRef.current.offX + (e.clientX - panRef.current.x);
      offsetRef.current.y = panRef.current.offY + (e.clientY - panRef.current.y);
      clampOffset();
      applyZoom(false);
    }
  };

  const onPointerEnd = (e: React.PointerEvent) => {
    const p = pointersRef.current.get(e.pointerId);
    pointersRef.current.delete(e.pointerId);
    const restantes = [...pointersRef.current.values()];

    if (pinchRef.current && restantes.length >= 2) {
      // Con tres dedos, soltar uno de la pareja activa cambiaría de pareja
      // contra la base vieja y la escala daría un salto: se recongela la base
      // con los dos dedos que quedan (continuo: en este instante dist = base).
      const [a, b] = restantes;
      a.pinched = true;
      b.pinched = true;
      pinchRef.current = {
        dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
        scale: scaleRef.current,
        midX: (a.x + b.x) / 2,
        midY: (a.y + b.y) / 2,
        offX: offsetRef.current.x,
        offY: offsetRef.current.y,
      };
    } else if (pinchRef.current) {
      pinchRef.current = null;
      if (scaleRef.current < SNAP_SCALE) {
        setScaleTo(1);
      } else {
        setZoomActive(true);
        // Si queda un dedo apoyado, sigue como desplazamiento sin salto.
        if (restantes.length === 1) {
          panRef.current = {
            x: restantes[0].x,
            y: restantes[0].y,
            offX: offsetRef.current.x,
            offY: offsetRef.current.y,
          };
        }
      }
    }
    if (restantes.length === 0) panRef.current = null;

    // Doble toque: dos toques limpios y seguidos alternan ampliar/alejar.
    if (p && e.type === "pointerup") {
      const ahora = performance.now();
      // `p.pinched` y no `pinchRef`: al soltar el segundo dedo del pellizco
      // pinchRef ya se anuló arriba, así que no delata al dedo que pellizcó.
      const limpio =
        Math.hypot(e.clientX - p.downX, e.clientY - p.downY) < 8 &&
        ahora - p.t < 250 &&
        pointersRef.current.size === 0 &&
        !p.pinched &&
        !pinchRef.current;
      if (limpio) {
        const previo = lastTapRef.current;
        if (
          ahora - previo.t < 320 &&
          Math.hypot(e.clientX - previo.x, e.clientY - previo.y) < 40
        ) {
          haptic("tap");
          setScaleTo(scaleRef.current > 1 ? 1 : DOUBLE_TAP_SCALE, e.clientX, e.clientY);
          lastTapRef.current = { t: 0, x: 0, y: 0 };
        } else {
          lastTapRef.current = { t: ahora, x: e.clientX, y: e.clientY };
        }
      }
    }
  };

  if (!mounted) return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          role="dialog"
          aria-modal="true"
          aria-label={alt ? `${alt} ampliada` : "Carta ampliada"}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="fixed inset-0 z-[140] flex flex-col items-center justify-center bg-black/92 backdrop-blur-xl"
          style={{ paddingTop: "var(--sat)", paddingBottom: "var(--sab)" }}
          onClick={onClose}
        >
          <button
            onClick={onClose}
            aria-label="Cerrar"
            className="glass absolute right-4 z-10 flex h-11 w-11 items-center justify-center rounded-full"
            style={{ top: "calc(var(--sat) + 12px)" }}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              className="ink h-5 w-5"
            >
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>

          <div
            ref={surfaceRef}
            className="flex flex-1 items-center justify-center overflow-hidden px-5"
            // "none" a propósito: aquí no hay scroll que ceder y el pellizco
            // lo gestiona el propio visor con sus eventos de puntero.
            style={{ touchAction: "none" }}
            onClick={(e) => e.stopPropagation()}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerEnd}
            onPointerCancel={onPointerEnd}
          >
            <div ref={zoomRef}>
              <div ref={tiltRef}>
                {src && (
                  <img
                    src={src}
                    alt={alt ?? ""}
                    draggable={false}
                    // Sombra con box-shadow y no con drop-shadow: un filter
                    // rasteriza la imagen y aquí es justo la que debe verse
                    // nítida.
                    // Contra el viewport medido, no contra vh: se descuentan
                    // las safe areas y el hueco del pie con la ayuda del gesto.
                    style={{
                      boxShadow: "0 30px 60px rgba(0,0,0,0.8)",
                      maxHeight:
                        "calc(var(--app-height) - var(--sat) - var(--sab) - 132px)",
                    }}
                    className="w-auto max-w-[92vw] rounded-2xl object-contain"
                  />
                )}
              </div>
            </div>
          </div>

          <p className="pointer-events-none pb-4 text-center text-[11px] text-white/45">
            {caption ? `${caption} · ` : ""}
            {zoomActive
              ? "Arrastra para moverte · Doble toque para alejar"
              : "Pellizca o doble toque para ampliar · Desliza abajo para cerrar"}
          </p>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
