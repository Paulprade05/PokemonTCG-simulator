"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { useHaptics } from "../../hooks/useHaptics";
import { useSwipe, touchActionFor } from "../../hooks/useSwipe";

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

/**
 * Sólo la carta, a pantalla completa. Se balancea al arrastrarla y se cierra
 * deslizando hacia abajo.
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
  const tiltRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") onNext?.();
      else if (e.key === "ArrowLeft") onPrev?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, onPrev, onNext]);

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

  useSwipe(surfaceRef, {
    axis: "both",
    threshold: 80,
    velocity: 460,
    follow: false,
    enabled: open,
    onMove: applyTilt,
    onEnd: resetTilt,
    onSwipeLeft: onNext,
    onSwipeRight: onPrev,
    onSwipeDown: () => {
      haptic("tap");
      onClose();
    },
  });

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
            className="flex flex-1 items-center justify-center px-5"
            style={{ touchAction: touchActionFor("both") }}
            onClick={(e) => e.stopPropagation()}
          >
            <div ref={tiltRef}>
              {src && (
                <img
                  src={src}
                  alt={alt ?? ""}
                  draggable={false}
                  // Sombra con box-shadow y no con drop-shadow: un filter
                  // rasteriza la imagen y aquí es justo la que debe verse
                  // nítida.
                  // Contra el viewport medido, no contra vh: se descuentan las
                  // safe areas y el hueco del pie con la ayuda del gesto.
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

          <p className="pointer-events-none pb-4 text-center text-[11px] text-white/45">
            {caption ? `${caption} · ` : ""}Arrastra para inclinarla · Desliza
            abajo para cerrar
          </p>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
