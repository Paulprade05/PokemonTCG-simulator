"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useHaptics } from "../../hooks/useHaptics";

type ToastTone = "success" | "error" | "info";

interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
}

const ToastContext = createContext<{
  toast: (message: string, tone?: ToastTone) => void;
}>({ toast: () => {} });

export const useToast = () => useContext(ToastContext).toast;

const DURATION = 2800;

const ICONS: Record<ToastTone, ReactNode> = {
  success: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 accent" aria-hidden="true">
      <path d="m4.5 12.5 5 5 10-11" />
    </svg>
  ),
  error: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" className="w-4 h-4" style={{ color: "var(--danger)" }} aria-hidden="true">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  ),
  info: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4" style={{ color: "var(--warn)" }} aria-hidden="true">
      <path d="m12 3 1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3L12 3Z" />
    </svg>
  ),
};

/**
 * Avisos flotantes bajo la barra de estado. Sustituyen a `alert()`, que en una
 * PWA instalada muestra el nombre del dominio y corta la interacción.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(0);
  const haptic = useHaptics();

  const toast = useCallback(
    (message: string, tone: ToastTone = "info") => {
      const id = nextId.current++;
      haptic(tone === "error" ? "warning" : "success");
      setItems((prev) => [...prev.slice(-2), { id, message, tone }]);
      setTimeout(
        () => setItems((prev) => prev.filter((t) => t.id !== id)),
        DURATION,
      );
    },
    [haptic],
  );

  const value = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {/* Región viva: el aviso se descarta solo a los 2800ms y el contenedor no
          recibe eventos, así que sin esto un lector de pantalla no tendría
          ninguna forma de enterarse de un error. */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="pointer-events-none fixed inset-x-0 z-[200] flex flex-col items-center gap-2 px-4"
        style={{ top: "calc(var(--sat) + 10px)" }}
      >
        <AnimatePresence initial={false}>
          {items.map(({ id, message, tone }) => (
            <motion.div
              key={id}
              layout
              /* SIN `scale`, Y ES IMPORTANTE.
               *
               * Antes entraba y salía escalando (0,94 → 1). El aviso lleva la
               * clase `glass`, que trae backdrop-filter: es justo la
               * combinación que WebKit promociona a capa propia y rasteriza a
               * una escala fija (la trampa documentada en
               * PokemonCard.tsx:140-163). El resultado en iPhone es un rótulo
               * con el texto ligeramente sucio, y como la capa del
               * backdrop-filter no se libera, no se recupera del todo al
               * terminar la animación. Con desplazamiento y opacidad el aviso
               * entra igual de vivo y el texto se queda nítido.
               *
               * El muelle sí conserva un rebote pequeño (amortiguación ~0,79):
               * el aviso cae desde el borde de arriba y frenar en seco lo haría
               * parecer un cartel pegado en vez de algo que llega. */
              initial={{ y: -28, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: -16, opacity: 0, transition: { duration: 0.16, ease: "easeIn" } }}
              transition={{ type: "spring", stiffness: 460, damping: 34 }}
              className="glass flex max-w-sm items-center gap-2.5 rounded-full py-2.5 pr-4 pl-3.5"
              style={{ boxShadow: "var(--shadow-md)" }}
            >
              {ICONS[tone]}
              <span className="ink text-[13px] leading-snug font-medium">
                {message}
              </span>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}
