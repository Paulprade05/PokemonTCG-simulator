"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, type ReactNode } from "react";
import { useFondoQuieto } from "../../hooks/useBloqueoScroll";
import { useHaptics } from "../../hooks/useHaptics";
import { useSwipe, touchActionFor } from "../../hooks/useSwipe";
import { useTrampaDeFoco } from "../../hooks/useTrampaDeFoco";
import { D, EASE_IOS, MUELLE_PANEL } from "../../utils/motion";
import { IconoCerrar } from "../icons";
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
/* Lo que se espera a que la hoja se vaya después de un gesto de cierre antes
   de devolverle al fondo su opacidad. Es el mismo margen que useSwipe le da al
   panel (RETENCION_MAX): si el dueño de la hoja ignora el `onClose` —una
   escritura en vuelo que no deja cerrar—, panel y fondo vuelven a la vez. */
const ESPERA_CIERRE = 450;

/* La escala de movimiento (--d-base, --ease-ios y el muelle del panel) llega
   importada de utils/motion.ts: framer-motion no lee variables CSS, pero eso no
   obliga a que cada componente se copie los números a mano — que es como se
   llegó a tener veintitrés copias de la misma curva. */

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

  // El porqué de no escribir `body.style.overflow` a mano, y de que esto no
  // sea todavía el bloqueo del body fijo, está en hooks/useBloqueoScroll.ts.
  useFondoQuieto(open);

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
  const esperaCierreRef = useRef(0);
  useEffect(() => () => window.clearTimeout(esperaCierreRef.current), []);
  /** `open` al día para el temporizador de abajo, que corre fuera del render. */
  const abiertaRef = useRef(open);
  useEffect(() => {
    abiertaRef.current = open;
  }, [open]);

  // El foco entra en la hoja al abrirse, no sale con Tab y vuelve a lo que la
  // abrió al cerrarse. Sin esto VoiceOver se quedaba en el botón de detrás.
  const trampaDeFoco = useTrampaDeFoco(panelRef, open);

  useSwipe(handleRef, {
    axis: "y",
    threshold: CLOSE_OFFSET,
    velocity: CLOSE_VELOCITY,
    // Se tira del asa pero se mueve el panel entero, para que acompañe al dedo.
    follow: true,
    followTarget: panelRef,
    enabled: open,
    // Al confirmarse el cierre el panel se queda donde lo deja el dedo y la
    // salida continúa desde ahí. Antes volvía en seco a su sitio y la
    // animación de salida arrancaba desde arriba: un salto justo al soltar.
    mantenerAlDisparar: true,
    onStart: () => {
      cerrandoRef.current = false;
      window.clearTimeout(esperaCierreRef.current);
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
      // Si la hoja se ha cerrado, no hay nada que devolver (y con el navegador
      // frenado puede que el fondo siga montado a media salida: no se toca).
      // Si quien la abrió ha decidido no cerrarla, el panel vuelve solo
      // (useSwipe) y el fondo no puede quedarse aclarado para siempre.
      window.clearTimeout(esperaCierreRef.current);
      esperaCierreRef.current = window.setTimeout(() => {
        cerrandoRef.current = false;
        const fondo = fondoRef.current;
        if (!fondo || !abiertaRef.current) return;
        fondo.style.transition = "opacity var(--d-base) var(--ease-out)";
        fondo.style.opacity = "1";
      }, ESPERA_CIERRE);
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
          transition={{ duration: D.base, ease: "linear" }}
        >
          {/* El desenfoque vive AQUÍ, en el telón, y sólo aquí. El telón es
              HERMANO del panel, nunca su ancestro, así que las cartas que se
              pintan dentro de la hoja no lo heredan. --scrim es el mismo telón
              que usan el detalle de carta, el buscador y el intercambio.
              `touch-action: none`: un arrastre que empieza en el telón no
              tiene nada que desplazar aquí, y sin esto iOS se lo daba a la
              página de detrás. `aria-hidden`: cierra al tocarlo, pero no es un
              control que un lector de pantalla deba anunciar; para eso está el
              botón "Cerrar" de dentro del diálogo. */}
          <div
            ref={fondoRef}
            aria-hidden="true"
            className="absolute inset-0 backdrop-blur-md"
            style={{ background: "var(--scrim)", touchAction: "none" }}
            onClick={onClose}
          />

          {/* EL PANEL ES OPACO, Y NO ES UNA ELECCIÓN DE ESTILO.
              Llevaba `.glass` (backdrop-filter: blur 8px), y dentro de esta
              hoja se pintan cartas: el selector de la vitrina (36 a la vez),
              las acciones de una funda, el paso 1 y 2 de publicar en el bazar
              y la ficha del álbum. Un backdrop-filter en un ANCESTRO de la
              carta la manda a una capa rasterizada a escala fija y en iPhone
              sale borrosa (la trampa documentada en PokemonCard.tsx, en la nota de `settled`).
              El esmerilado se queda en el telón de arriba, que es hermano. */}
          {/* DOS CAJAS, UNA PARA CADA MOVIMIENTO. La de fuera la mueve
              framer-motion (entrar y salir); la de dentro, que es el panel de
              verdad, la mueve el dedo (useSwipe escribe ahí su translate). Eran
              la misma, y las dos escrituras se pisaban: al soltar para cerrar,
              el hook tenía que borrar su transform para que la salida de
              framer no arrancara encima, y ese borrado era el salto hacia
              arriba. Separadas se SUMAN: el panel se queda donde lo dejó el
              dedo y la caja de fuera se lo lleva desde ahí. La de fuera no
              pinta nada (ni fondo, ni borde, ni recorte), así que el panel
              puede bajar dentro de ella sin que nada lo corte. */}
          <motion.div
            className="relative w-full max-w-2xl sm:mb-4"
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
            exit={{ y: "100%", transition: { duration: D.base, ease: EASE_IOS } }}
            transition={MUELLE_PANEL}
          >
          <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label={label}
            // Enfocable por programa (useTrampaDeFoco), fuera del orden de Tab.
            tabIndex={-1}
            onKeyDown={trampaDeFoco}
            /* `flex flex-col` + `min-h-0` en el área de scroll, y no
               `max-h-[inherit]`: POR ESTO NO SE LLEGABA AL FINAL DE LAS HOJAS.
               El panel lleva `max-height` con box-sizing border-box, así que
               ese tope INCLUYE el borde y el relleno inferior de la barra de
               gestos (--sab, 34 px en iPhone). El área de scroll heredaba el
               mismo tope entero, sin descontar ni eso ni el asa (26 px), y el
               overflow-hidden del panel se comía sus últimos ~62 px (~28 en
               escritorio): el botón "Cerrar" de la ficha del álbum y el pie de
               cualquier hoja larga quedaban fuera aunque se hiciera scroll
               hasta el final. Medido en 375×812 con insets 47/34. Como columna
               flex, el área recibe lo que sobra tras el asa y el relleno, y
               el `min-h-0` le permite encoger y desplazar su contenido. */
            className="ink relative flex w-full flex-col overflow-hidden rounded-t-3xl border border-[var(--border)] sm:rounded-3xl"
            style={{
              maxHeight,
              background: "var(--grain), var(--surface)",
              boxShadow: "var(--shadow-lg)",
              // Con el teclado desplegado ya no hay barra de gestos que esquivar.
              paddingBottom: "max(0px, calc(var(--sab) - var(--keyboard)))",
              // El foco que recibe el panel al abrirse no se dibuja: un anillo
              // alrededor de la hoja entera no señala nada. En línea porque la
              // regla global de :focus-visible va sin capa y gana a cualquier
              // utilidad de Tailwind.
              outline: "none",
            }}
          >
            {/* EL CIERRE PARA QUIEN NO PUEDE ARRASTRAR NI VER EL TELÓN.
                El asa decía ser un botón ("Arrastra hacia abajo para cerrar,
                botón") y al activarla con VoiceOver no pasaba nada: no tenía
                `onClick`. En Ajustes era además el ÚNICO control de cierre que
                el lector encontraba, y sin teclado no hay Escape: no se podía
                salir. Ahora el asa es lo que es —un tirador, invisible para el
                lector— y el cierre es un botón de verdad, el primero del
                diálogo.

                No se ve porque para quien ve ya hay tres formas de cerrar (el
                asa, el telón, Escape) y una cuarta a un toque del borde se
                pulsaría sin querer. Se recorta con la receta de siempre (1 px
                y clip-path) en vez de con `sr-only`, para poder DESHACER el
                recorte al recibir el foco por teclado sin depender del orden
                en que Tailwind emite `not-sr-only` y `absolute`: un control
                enfocado que no se ve es peor que uno que sobra. */}
            <button
              type="button"
              onClick={onClose}
              aria-label="Cerrar"
              className="btn-ghost absolute right-2 top-2 z-10 flex h-px w-px items-center justify-center overflow-hidden rounded-full [clip-path:inset(50%)] focus-visible:h-11 focus-visible:w-11 focus-visible:overflow-visible focus-visible:[clip-path:none]"
            >
              <IconoCerrar tam={16} />
            </button>
            {!hideHandle && (
              <div
                ref={handleRef}
                aria-hidden="true"
                // `group` para que la barrita reaccione al tocar CUALQUIER punto
                // de la franja, que es ancha (todo el panel) pero baja: la
                // barrita visible mide 44×6 y sin acuse de recibo no hay forma
                // de saber si se ha agarrado el asa o se ha fallado.
                // `pt-4 pb-3`: la franja medía 26 px de alto (`pt-3 pb-2`) y
                // es lo único que cierra la hoja arrastrando; ahora son 34. No
                // se llega a los 44 a propósito: cada píxel de aquí baja el
                // contenido de TODAS las hojas, y la franja ocupa el ancho
                // entero del panel, así que el dedo sólo tiene que acertar en
                // vertical.
                className="group flex shrink-0 cursor-grab justify-center pt-4 pb-3 active:cursor-grabbing"
                style={{ touchAction: touchActionFor("y") }}
              >
                <div className="h-1.5 w-11 rounded-full bg-[var(--border-strong)] transition-[width,background-color] duration-[var(--d-fast)] group-active:w-14 group-active:bg-[var(--ink-faint)]" />
              </div>
            )}
            {/* data-lenis-prevent evita que el scroll suave global se coma el
                scroll interno de la hoja. */}
            <div
              data-lenis-prevent
              className="scroll-area custom-scrollbar min-h-0"
            >
              {children}
            </div>
          </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
    </Portal>
  );
}
