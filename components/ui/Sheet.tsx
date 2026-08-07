"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, type ReactNode } from "react";
import { useHaptics } from "../../hooks/useHaptics";
import { useSwipe, touchActionFor } from "../../hooks/useSwipe";

interface SheetProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  /** Alto máximo del panel respecto al viewport visible. */
  maxHeight?: string;
  hideHandle?: boolean;
  label?: string;
}

// Umbrales para decidir si el gesto cierra la hoja.
const CLOSE_OFFSET = 110;
const CLOSE_VELOCITY = 520;

/**
 * Hoja inferior al estilo iOS: entra con muelle, se arrastra hacia abajo para
 * cerrar y respeta la safe area. Con el teclado abierto se ancla encima de él,
 * porque en iOS el viewport de layout no encoge y un `inset-0` la dejaría
 * debajo.
 */
export default function Sheet({
  open,
  onClose,
  children,
  maxHeight = "calc(var(--app-height) - var(--sat) - 24px)",
  hideHandle = false,
  label,
}: SheetProps) {
  const haptic = useHaptics();

  useEffect(() => {
    if (!open) return;
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = overflow;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // El arrastre sale del asa, no del panel entero: si escuchara en todo el
  // panel se comería el scroll vertical del contenido.
  const handleRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  useSwipe(handleRef, {
    axis: "y",
    threshold: CLOSE_OFFSET,
    velocity: CLOSE_VELOCITY,
    // Se tira del asa pero se mueve el panel entero, para que acompañe al dedo.
    follow: true,
    followTarget: panelRef,
    enabled: open,
    onSwipeDown: () => {
      haptic("tap");
      onClose();
    },
  });

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-x-0 top-0 z-[120] flex items-end justify-center"
          style={{ bottom: "var(--keyboard)" }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.22 }}
        >
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-md"
            onClick={onClose}
          />

          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label={label}
            className="glass relative w-full max-w-2xl overflow-hidden rounded-t-[28px] sm:mb-4 sm:rounded-[28px]"
            style={{
              maxHeight,
              boxShadow: "var(--shadow-lg)",
              // Con el teclado desplegado ya no hay barra de gestos que esquivar.
              paddingBottom: "max(0px, calc(var(--sab) - var(--keyboard)))",
            }}
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ type: "spring", stiffness: 380, damping: 38, mass: 0.9 }}
          >
            {!hideHandle && (
              <div
                ref={handleRef}
                role="button"
                aria-label="Arrastra hacia abajo para cerrar"
                className="flex shrink-0 cursor-grab justify-center pt-3 pb-2 active:cursor-grabbing"
                style={{ touchAction: touchActionFor("y") }}
              >
                <div
                  className="h-1.5 w-11 rounded-full"
                  style={{ background: "var(--border-strong)" }}
                />
              </div>
            )}
            {/* data-lenis-prevent evita que el scroll suave global se coma el
                scroll interno de la hoja. */}
            <div
              data-lenis-prevent
              className="scroll-area custom-scrollbar max-h-[inherit]"
            >
              {children}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
