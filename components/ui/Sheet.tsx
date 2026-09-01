"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, type ReactNode } from "react";
import { useHaptics } from "../../hooks/useHaptics";
import { useSwipe, touchActionFor } from "../../hooks/useSwipe";
import Portal from "./Portal";

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

/* Recorrido de arrastre con el que el fondo llega a su transparencia máxima.
   Es mayor que CLOSE_OFFSET a propósito: al llegar al umbral de cierre el fondo
   se ha aclarado a poco más de la mitad, así que todavía queda margen visible
   para seguir tirando. Si se agotara justo en el umbral, el gesto parecería
   terminado antes de estarlo. */
const RECORRIDO_FONDO = 260;
/* Cuánto se puede aclarar el fondo como mucho. No llega a cero nunca: el fondo
   también es lo que impide leer el contenido de detrás, y una hoja que se
   arrastra sobre una pantalla plenamente legible pierde el sentido de capa. */
const FONDO_MINIMO = 0.42;

/* Espejo en JavaScript de la escala de app/globals.css (--d-base y --ease-ios):
   framer-motion no lee variables CSS. Si se tocan allí, hay que tocarlos aquí. */
const D_BASE = 0.22;
const EASE_IOS: [number, number, number, number] = [0.32, 0.72, 0, 1];

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
  const fondoRef = useRef<HTMLDivElement>(null);
  // Distingue "he soltado a medias" de "el gesto ha cerrado la hoja": en el
  // segundo caso el fondo NO debe volver a su opacidad, porque ya se está yendo.
  const cerrandoRef = useRef(false);

  useSwipe(handleRef, {
    axis: "y",
    threshold: CLOSE_OFFSET,
    velocity: CLOSE_VELOCITY,
    // Se tira del asa pero se mueve el panel entero, para que acompañe al dedo.
    follow: true,
    followTarget: panelRef,
    enabled: open,
    onStart: () => {
      cerrandoRef.current = false;
      // Si venía de un retorno a medio animar, se corta: durante el arrastre el
      // fondo tiene que ir pegado al dedo, no con 0,22 s de retraso.
      if (fondoRef.current) fondoRef.current.style.transition = "";
    },
    /* EL FONDO SE ACLARA MIENTRAS SE TIRA.
     *
     * Es la diferencia entre una hoja que se puede arrastrar y una que sólo se
     * mueve. Al bajar, el fondo oscuro se retira y asoma la pantalla de detrás:
     * el gesto se explica solo a mitad de camino ("esto va a cerrarse y voy a
     * volver ahí"), y se puede abortar con conocimiento de causa. Sin esto, el
     * panel baja sobre un telón negro inmóvil y el gesto no informa de nada
     * hasta que ya ha ocurrido.
     *
     * Se escribe en el DOM a mano, sin estado de React: esto corre en cada
     * evento de puntero y un re-render por fotograma se notaría en el arrastre.
     */
    onMove: (_dx, dy) => {
      const fondo = fondoRef.current;
      // dy negativo es tirar hacia arriba: ahí useSwipe ya aplica resistencia y
      // el fondo no tiene nada que contar.
      if (!fondo || dy <= 0) return;
      fondo.style.opacity = String(
        Math.max(FONDO_MINIMO, 1 - (dy / RECORRIDO_FONDO) * (1 - FONDO_MINIMO)),
      );
    },
    onSwipeDown: () => {
      cerrandoRef.current = true;
      haptic("tap");
      onClose();
    },
    onEnd: () => {
      const fondo = fondoRef.current;
      if (!fondo || cerrandoRef.current) return;
      // Vuelve acompañando al panel, que useSwipe devuelve con su propia
      // animación de 0,32 s.
      fondo.style.transition = "opacity var(--d-base) var(--ease-out)";
      fondo.style.opacity = "1";
    },
  });

  return (
    <Portal>
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-x-0 top-0 z-[120] flex items-end justify-center"
          style={{ bottom: "var(--keyboard)" }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: D_BASE, ease: "linear" }}
        >
          <div
            ref={fondoRef}
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
            /* LA SALIDA NO ES UN MUELLE, ES UNA CURVA.
             * Con el mismo muelle para ir y volver, la hoja salía frenando
             * mucho al final: los últimos píxeles se arrastraban y la hoja
             * parecía costarle irse. Al cerrar no hay nada que "asentar" —el
             * destino está fuera de la pantalla y no se ve—, así que lo que
             * toca es acelerar y desaparecer. La entrada sí se queda con
             * muelle: ahí hay una llegada que sentir.
             *
             * Y la entrada NO rebota (amortiguación ~1,03, por encima de 1) a
             * propósito: un rebote en una hoja anclada abajo la levantaría unos
             * píxeles por encima de su sitio y dejaría ver una franja de fondo
             * por debajo. Ese es el motivo de que aquí el rebote esté
             * descartado, y no que quede feo. */
            exit={{ y: "100%", transition: { duration: 0.24, ease: EASE_IOS } }}
            transition={{ type: "spring", stiffness: 380, damping: 38, mass: 0.9 }}
          >
            {!hideHandle && (
              <div
                ref={handleRef}
                role="button"
                aria-label="Arrastra hacia abajo para cerrar"
                // `group` para que la barrita reaccione al tocar CUALQUIER punto
                // de la franja, que es ancha (todo el panel) pero de sólo 26px
                // de alto: la barrita visible mide 44×6 y sin acuse de recibo no
                // hay forma de saber si se ha agarrado el asa o se ha fallado.
                className="group flex shrink-0 cursor-grab justify-center pt-3 pb-2 active:cursor-grabbing"
                style={{ touchAction: touchActionFor("y") }}
              >
                <div className="h-1.5 w-11 rounded-full bg-[var(--border-strong)] transition-[width,background-color] duration-[var(--d-fast)] group-active:w-14 group-active:bg-[var(--ink-faint)]" />
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
    </Portal>
  );
}
