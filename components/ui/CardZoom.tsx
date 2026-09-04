"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { useHaptics } from "../../hooks/useHaptics";
import { useSwipe } from "../../hooks/useSwipe";
import DesperfectosCarta, { estiloDescentrado } from "../DesperfectosCarta";
import type { Desperfectos, MarcasDeCarta } from "../../utils/graduacion";

interface CardZoomProps {
  open: boolean;
  src?: string;
  alt?: string;
  onClose: () => void;
  /** Navegación opcional entre cartas, para no perderla al ampliar. */
  onPrev?: () => void;
  onNext?: () => void;
  caption?: string;
  /* ==================================================================== *
   * EL DESGASTE DE LA COPIA — OPCIONAL A PROPÓSITO
   * ====================================================================
   *
   * El visor nació recibiendo sólo una URL, y por eso la carta ampliada
   * salía siempre impecable aunque la rejilla la enseñara con piques:
   * ampliar una carta dañada la curaba. Ahora quien la abre CON UNA COPIA
   * del jugador (components/CardDetailModal.tsx) le pasa aquí el mismo
   * estado que pinta en pequeño.
   *
   * OPCIONALES Y NO OBLIGATORIAS porque el otro sitio que abre el visor,
   * app/album/[setId]/page.tsx, enseña el CATÁLOGO de una expansión: ahí no
   * hay copia, luego no hay desgaste que pintar, y no tiene que cambiar ni
   * enterarse de que estas props existen.
   *
   * Vienen YA CALCULADAS DEL SERVIDOR y no se derivan aquí de una semilla:
   * la semilla lleva dentro el secreto de las notas. El porqué entero está
   * en components/DesperfectosCarta.tsx. */
  desperfectos?: Desperfectos;
  marcas?: MarcasDeCarta;
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
  desperfectos,
  marcas,
}: CardZoomProps) {
  const haptic = useHaptics();
  const surfaceRef = useRef<HTMLDivElement>(null);
  /** Capa de escala + desplazamiento del pellizco (envuelve a la inclinación). */
  const zoomRef = useRef<HTMLDivElement>(null);
  const tiltRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [mounted, setMounted] = useState(false);
  /** true mientras la carta está ampliada: cambia gestos y rótulo. */
  const [zoomActive, setZoomActive] = useState(false);
  /**
   * El estado de la copia como un solo objeto, o nada.
   *
   * Se juntan aquí las dos props para no ir arrastrando la pareja por todo el
   * render: o están las dos o no hay estado, igual que en
   * `estadoDeCopia` (components/DesperfectosCarta.tsx). Un `const` además
   * conserva el estrechado de tipos dentro del closure de abajo, cosa que dos
   * props sueltas no harían.
   */
  const estado = desperfectos && marcas ? { desperfectos, marcas } : null;
  const hayDesgaste = estado !== null;
  /** Medida real del <img> pintado. El porqué, en el bloque de abajo. */
  const [caja, setCaja] = useState<{ w: number; h: number } | null>(null);

  /* ==================================================================== *
   * POR QUÉ SE MIDE LA IMAGEN EN VEZ DE DEJAR QUE EL CSS LO RESUELVA
   * ====================================================================
   *
   * DesperfectosCarta se coloca con `absolute inset-0`, así que necesita un
   * contenedor que mida EXACTAMENTE la caja del <img>. Y aquí el <img> no
   * ocupa el hueco que le dan: lleva `width:auto` con `max-w-[92vw]` y un
   * `max-height` calculado, y de esas dos restricciones manda una u otra
   * según la pantalla. En vertical de iPhone corta el ancho y la caja llena
   * el hueco; en escritorio y en móvil apaisado corta el ALTO, y entonces la
   * imagen pintada es MÁS ESTRECHA que el div que la contiene.
   *
   * Un marco de bloque normal se estiraría a ese hueco y las marcas
   * quedarían desplazadas hacia la izquierda: piques flotando fuera del
   * canto. `width: fit-content` lo arregla sólo si el motor traslada la
   * restricción de alto al eje del ancho a través de la proporción, que es
   * justo la parte del cálculo intrínseco donde los motores han ido cada uno
   * a su ritmo. Y el fallo saldría en escritorio, que es donde nadie lo
   * probaría.
   *
   * Medir el elemento quita la ambigüedad: el ResizeObserver da el ancho y
   * el alto pintados y se le clavan al marco. No hay bucle posible porque
   * las dos restricciones del <img> son de VIEWPORT (92vw y --app-height) y
   * ninguna depende del ancho del padre: cambiar el marco no cambia la
   * imagen. `w-fit` se queda como valor de partida para el primer pintado,
   * antes de que el observador haya medido nada.
   *
   * Sólo se monta con desgaste que pintar: la carta limpia —que es el caso
   * normal— no paga ni el observador ni los dos divs de más.
   */
  useEffect(() => {
    const img = imgRef.current;
    if (!open || !hayDesgaste || !img) return;
    const medir = () => {
      const w = img.clientWidth;
      const h = img.clientHeight;
      // La imagen aún sin cargar mide 0: sin medida no se toca el marco, y
      // el observador volverá a llamar en cuanto tenga tamaño.
      if (w <= 0 || h <= 0) return;
      setCaja((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }));
    };
    medir();
    const ro = new ResizeObserver(medir);
    ro.observe(img);
    return () => ro.disconnect();
    // `src` NO va aquí a propósito: pasar de carta cambia el atributo del
    // MISMO <img>, el observador sigue enganchado a ese elemento y vuelve a
    // medir solo cuando la nueva imagen cambia la caja. Mientras la nueva
    // carga, el navegador mantiene la caja anterior, que es justo la que se
    // está viendo. Volver a montar el observador no adelantaría nada.
  }, [open, hayDesgaste]);

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
    const { x, y } = offsetRef.current;
    const s = scaleRef.current;
    // A 1× sin desplazamiento se escribe la cadena VACÍA y no
    // `translate3d(0,0,0) scale(1)`: una escala 1 sigue siendo un transform
    // escrito, y un transform escrito en un ancestro de la carta la deja
    // promovida a una capa rasterizada a escala fija —borrosa en iPhone—
    // aunque ya no se esté ampliando nada.
    el.style.transform =
      s === 1 && x === 0 && y === 0
        ? ""
        : `translate3d(${x}px, ${y}px, 0) scale(${s})`;
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
  // `caja` NO se borra aquí a propósito: es una medida de la caja que se está
  // viendo, no estado del gesto, y ponerla a null dejaría el marco de las
  // marcas estirado al hueco durante el pintado que va desde el cambio de
  // carta hasta que el observador vuelve a medir. Se corrige sola.
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

  /* ==================================================================== *
   * EL BALANCEO ES 2D: TRANSLATE + ROTATE, LO MISMO QUE EN EL ÁLBUM Y EN LA
   * FICHA (components/CardDetailModal.tsx).
   * ====================================================================
   *
   * Aquí había un balanceo 3D escrito a mano en cada movimiento —
   * `perspective(1000px) rotateY() rotateX()` sobre tiltRef, el PADRE de la
   * carta—, y este visor es justo el sitio donde la carta tiene que verse
   * nítida: un `perspective` en un ancestro la manda a una capa rasterizada a
   * escala fija y en iPhone salía borrosa (PokemonCard.tsx:140-163). Además
   * el retorno fijaba una transición de 0,6 s y un setTimeout(620) sin
   * guardar el id: dos arrastres seguidos hacían que el primer temporizador
   * borrara la transición a mitad del rebote del segundo y la carta saltaba.
   *
   * Ahora el movimiento lo pinta el hook con `follow` sobre tiltRef (translate
   * y 4° por cada 100 px), y el hook guarda y cancela su propio temporizador
   * de retorno, así que el salto se va solo. El segundo dedo del pellizco
   * aborta el gesto dentro del hook, y ese abort devuelve tiltRef a su sitio
   * (release) antes de que el zoom tome el control: la carta no se queda
   * torcida durante la ampliación.
   */
  // Inclinar, pasar de carta y cerrar deslizando sólo tienen sentido con la
  // carta a tamaño natural: ampliada, el dedo es para desplazarse por ella.
  useSwipe(surfaceRef, {
    axis: "both",
    threshold: 80,
    velocity: 460,
    follow: true,
    followTarget: tiltRef,
    rotate: 4,
    enabled: open && !zoomActive,
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
      // El segundo dedo aborta el gesto de useSwipe, y como el balanceo lo
      // pinta el propio hook (`follow` sobre tiltRef), ese abort ya devuelve
      // la carta a su sitio: no hay que enderezarla desde aquí.
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
          className="fixed inset-0 z-[140] flex flex-col items-center justify-center"
          style={{ paddingTop: "var(--sat)", paddingBottom: "var(--sab)" }}
          onClick={onClose}
        >
          {/* El telón oscuro con el desenfoque es un HERMANO absoluto detrás
              de la carta, no la raíz: un backdrop-filter en un ancestro de la
              carta la rasteriza a escala fija y aquí, donde se amplía hasta
              3×, es donde más se notaba el borrón. Más oscuro que el --scrim
              común a propósito: esto es un visor de la ilustración y el fondo
              tiene que desaparecer. */}
          <div
            aria-hidden="true"
            className="absolute inset-0 bg-black/92 backdrop-blur-xl"
          />
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
            // `relative`: con el telón absoluto delante en el árbol, esta
            // superficie tiene que estar posicionada para pintarse encima.
            className="relative flex flex-1 items-center justify-center overflow-hidden px-5"
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
                {src && (() => {
                  const imagen = (
                    <img
                      ref={imgRef}
                      src={src}
                      alt={alt ?? ""}
                      draggable={false}
                      // Sombra con box-shadow y no con drop-shadow: un filter
                      // rasteriza la imagen y aquí es justo la que debe verse
                      // nítida. Con marcas la sombra sube al marco: aquí
                      // dentro quedaría comida por su overflow-hidden.
                      // Contra el viewport medido, no contra vh: se descuentan
                      // las safe areas y el hueco del pie con la ayuda del gesto.
                      style={{
                        boxShadow: hayDesgaste
                          ? undefined
                          : "0 30px 60px rgba(0,0,0,0.8)",
                        maxHeight:
                          "calc(var(--app-height) - var(--sat) - var(--sab) - 132px)",
                      }}
                      // `block` SÓLO en la rama con marcas: un <img> en línea
                      // arrastra el hueco del descendente bajo la línea base y
                      // el marco mediría unos píxeles más que la imagen, que es
                      // exactamente el descuadre que se está evitando. En la
                      // rama limpia el elemento se queda como estaba.
                      className={`w-auto max-w-[92vw] rounded-2xl object-contain${
                        hayDesgaste ? " block" : ""
                      }`}
                    />
                  );
                  // Copia limpia —el caso normal—: el árbol se queda EXACTAMENTE
                  // como estaba. La rama de abajo mete dos divs entre el
                  // balanceo y la imagen y no hay razón para que los pague
                  // quien no tiene nada que enseñar.
                  if (!estado) return imagen;
                  return (
                    /* Marco + tira, el mismo montaje que
                       components/CardDetailModal.tsx y
                       components/graduacion/CartaConDesperfectos.tsx: el
                       descentrado de una carta mal cortada no se pinta, se
                       MUEVE la ilustración dentro del marco y el marco
                       recorta; por el lado del que se retira asoma el cartón,
                       que es el fondo. El marco es además el `relative` +
                       `overflow-hidden` que DesperfectosCarta exige.

                       `estiloDescentrado` es un `translate` y va en su PROPIO
                       div: encima ya hay dos transforms escritos a mano —el
                       scale del pellizco en zoomRef y el translate+rotate del
                       balanceo en tiltRef— y un tercero en el mismo elemento
                       pisaría a uno de ellos. Nunca `scale` aquí: ver la
                       cabecera de components/DesperfectosCarta.tsx.

                       El radio es `rounded-2xl`, el mismo del <img>, para que
                       el recorte del descentrado muerda la misma esquina que
                       la imagen y no una ligeramente distinta.

                       Ancho y alto son la MEDIDA REAL del <img> (ver el bloque
                       del ResizeObserver); `w-fit` es sólo el valor de partida
                       del primer pintado. */
                    <div
                      className="relative w-fit overflow-hidden rounded-2xl"
                      style={{
                        background: "var(--surface-2)",
                        boxShadow: "0 30px 60px rgba(0,0,0,0.8)",
                        width: caja?.w,
                        height: caja?.h,
                      }}
                    >
                      <div style={estiloDescentrado(estado.desperfectos)}>
                        {imagen}
                      </div>
                      <DesperfectosCarta
                        desperfectos={estado.desperfectos}
                        marcas={estado.marcas}
                      />
                    </div>
                  );
                })()}
              </div>
            </div>
          </div>

          <p className="pointer-events-none relative pb-4 text-center text-[11px] text-white/45">
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
