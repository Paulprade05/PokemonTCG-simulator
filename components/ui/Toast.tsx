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
import { IconoCerrar, IconoCheck } from "../icons";

type ToastTone = "success" | "error" | "info";

/**
 * Lo que puede acompañar a un aviso. Todo opcional: `toast("ID copiado")` y
 * `toast("…", "error")` siguen siendo las dos formas normales de llamarlo.
 */
export interface ToastOpciones {
  /**
   * Un botón dentro del aviso ("Ver álbum", "Reintentar", "Ir a Colección").
   * Al pulsarlo se ejecuta `onClick` y el aviso se cierra. Es el ÚNICO caso en
   * que el aviso recibe toques: los demás siguen siendo transparentes al dedo,
   * para no tapar la barra superior que tienen debajo.
   */
  accion?: { rotulo: string; onClick: () => void };
  /** Milisegundos en pantalla, si la duración calculada no sirve. */
  duracion?: number;
}

interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
  accion?: ToastOpciones["accion"];
}

const ToastContext = createContext<{
  toast: (message: string, tone?: ToastTone, opciones?: ToastOpciones) => void;
}>({ toast: () => {} });

export const useToast = () => useContext(ToastContext).toast;

/* CUÁNTO DURA UN AVISO: LO QUE SE TARDA EN LEERLO.
 *
 * Todos duraban 2,8 s, lo mismo "ID copiado" que "Vendidas 12 cartas por 340
 * monedas · 3 cambiaron y siguen en el álbum". El segundo son setenta
 * caracteres con dos cifras que importan y desaparecía a media lectura, sin
 * forma de recuperarlo.
 *
 * 1,2 s de base (verlo aparecer y llevar el ojo arriba) más 55 ms por carácter,
 * que es un ritmo de lectura tranquilo. El suelo son los 2,8 s de siempre, así
 * que ningún aviso corto cambia; el techo son 7 s, porque un aviso que se queda
 * más tiempo tapando el saldo ya no es un aviso. Con botón se le dan 1,5 s más:
 * además de leerlo hay que decidir y llegar con el dedo. */
const DURACION_MIN = 2800;
const DURACION_MAX = 7000;
function duracionDe(message: string, conAccion: boolean): number {
  const lectura = 1200 + 55 * message.length + (conAccion ? 1500 : 0);
  return Math.min(DURACION_MAX, Math.max(DURACION_MIN, lectura));
}

const ICONS: Record<ToastTone, ReactNode> = {
  // El check y el aspa salen del vocabulario común (components/icons.tsx): el
  // "sí" y el "no" de la aplicación no pueden estar dibujados con dos criterios
  // distintos, y aquí iban con trazo 2,2 mientras el resto de la casa usa 2.
  success: <IconoCheck tam={16} className="accent" />,
  error: <IconoCerrar tam={16} className="[color:var(--danger)]" />,
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

  const descartar = useCallback(
    (id: number) => setItems((prev) => prev.filter((t) => t.id !== id)),
    [],
  );

  const toast = useCallback(
    (message: string, tone: ToastTone = "info", opciones?: ToastOpciones) => {
      const id = nextId.current++;
      const accion = opciones?.accion;
      haptic(tone === "error" ? "warning" : "success");
      setItems((prev) => [...prev.slice(-2), { id, message, tone, accion }]);
      setTimeout(
        () => descartar(id),
        opciones?.duracion ?? duracionDe(message, accion !== undefined),
      );
    },
    [haptic, descartar],
  );

  const value = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {/* Región viva: el aviso se descarta solo a los pocos segundos y el
          contenedor no recibe eventos, así que sin esto un lector de pantalla
          no tendría ninguna forma de enterarse de un error. */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="pointer-events-none fixed inset-x-0 z-[200] flex flex-col items-center gap-2 px-4"
        style={{ top: "calc(var(--sat) + 10px)" }}
      >
        <AnimatePresence initial={false}>
          {items.map(({ id, message, tone, accion }) => (
            <motion.div
              key={id}
              layout
              /* SIN `scale`, Y ES IMPORTANTE.
               *
               * Antes entraba y salía escalando (0,94 → 1). El aviso lleva la
               * clase `glass`, que trae backdrop-filter: es justo la
               * combinación que WebKit promociona a capa propia y rasteriza a
               * una escala fija (la trampa documentada en
               * PokemonCard.tsx, en la nota de `settled`). El resultado en iPhone es un rótulo
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
              /* `rounded-3xl` y no `rounded-full`: en una línea da la misma
                 píldora (24px ya es más que media altura y el navegador lo
                 recorta), pero un aviso de dos o tres líneas —que ahora dura
                 lo bastante para leerse— con `rounded-full` curvaba tanto las
                 esquinas que la primera y la última línea se salían del fondo.
                 Sólo el aviso con botón recibe toques (ver ToastOpciones). */
              className={`glass flex max-w-sm items-center gap-2.5 rounded-3xl py-2.5 pr-4 pl-3.5${
                accion ? " pointer-events-auto" : ""
              }`}
              style={{ boxShadow: "var(--shadow-md)" }}
            >
              {ICONS[tone]}
              <span className="ink t-cuerpo leading-snug font-medium">
                {message}
              </span>
              {accion && (
                <button
                  type="button"
                  onClick={() => {
                    accion.onClick();
                    descartar(id);
                  }}
                  // 44px de dedo sin engordar la píldora: los márgenes
                  // negativos se comen el relleno vertical y el derecho del
                  // aviso, así que el botón llega hasta sus bordes.
                  // --ok y no --accent: es texto, y el acento de marca sobre
                  // el papel claro se queda en 2,2:1.
                  className="press control-44 -my-2.5 -mr-3 shrink-0 rounded-full px-3 t-cuerpo font-semibold [color:var(--ok)]"
                >
                  {accion.rotulo}
                </button>
              )}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}
