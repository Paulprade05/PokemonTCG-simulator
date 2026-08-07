"use client";

import { AnimatePresence, motion, type PanInfo } from "framer-motion";
import { useEffect, type ReactNode } from "react";
import { useHaptics } from "../../hooks/useHaptics";

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

  const handleDragEnd = (_: unknown, info: PanInfo) => {
    if (info.offset.y > CLOSE_OFFSET || info.velocity.y > CLOSE_VELOCITY) {
      haptic("tap");
      onClose();
    }
  };

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
            drag="y"
            dragDirectionLock
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.55 }}
            onDragEnd={handleDragEnd}
          >
            {!hideHandle && (
              <div className="flex shrink-0 justify-center pt-3 pb-1">
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
