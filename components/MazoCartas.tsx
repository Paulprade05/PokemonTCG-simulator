"use client";

import { motion } from "framer-motion";
import { useCallback, useEffect, useLayoutEffect, useRef, type MutableRefObject, type RefObject } from "react";
import PokemonCard from "./PokemonCard";
import { useHaptics } from "../hooks/useHaptics";
import { useSwipe } from "../hooks/useSwipe";

/**
 * MAZO DE LA APERTURA (app/page.tsx, VIEW 3).
 *
 * Las diez ranuras se montan UNA vez y se quedan montadas: pasar de carta sólo
 * mueve transforms. Antes cada avance montaba y desmontaba un <motion.div>
 * (con su <img> grande recién pedida), y ese relevo es lo que se sentía tosco.
 *
 * Arrastrar abre el mazo en abanico bajo el dedo: se ven los cantos de las diez
 * y al soltar el mazo se cierra sobre la que estabas mirando.
 *
 * ---------------------------------------------------------------------------
 * INVARIANTE DE ESPACIO — el único número que no se puede rebasar.
 *
 * CARD_WIDTH = min(82vw, 360px, …). En el caso peor W = 0.82·vw, así que a cada
 * lado del borde de la carta frontal sólo sobran (vw − W)/2 = 0.1098·W hasta el
 * borde del viewport. El diálogo lleva overflow-hidden: lo que se pase sale
 * cortado en recto. NADA puede rebasar el borde de la carta frontal en más de
 * 0.1098·W (es decir, nada puede llegar más allá de 0.61·W del centro).
 *
 * Como el término (W/2)(1−s) de abajo deja el borde de cada ranura girada a
 * ras del de la frontal, lo que sobresale es el apartado MÁS lo que el giro
 * añade a la caja envolvente:
 *   sobresale = asoma + s·(cos g − 1 + 1.4·sin g)/2     (1.4 = 3.5/2.5)
 * Y en el abanico, donde no hay reanclaje: |x| + s·(cos g + 1.4·sin g)/2.
 * Medido en el navegador con W = 307,5 (getBoundingClientRect de las diez):
 *   · reposo p=0 (peor pendiente):            0.5981·W  ✔
 *   · reposo p=9 (peor vista):                0.6098·W  ✔ justo en el límite
 *   · abanico p=3 (selección al centro):      0.5562·W  ✔
 *   · abanico p=0 y p=9 (selección al borde): 0.5992·W  ✔
 *
 * ---------------------------------------------------------------------------
 * NITIDEZ — tres reglas, se rompen las tres a la vez o ninguna.
 *
 * 1. `will-change: transform` en las ranuras SÓLO con el dedo abajo. Se pone en
 *    onStart, cuando la frontal está a escala 1 (se rasteriza a su tamaño
 *    máximo) y durante el arrastre las escalas sólo BAJAN: encoger una capa ya
 *    rasterizada no emborrona nunca.
 * 2. Ninguna transición corre sobre una ranura que CREZCA: la destino cierra de
 *    0.529 a 1.0 (+89%), así que se le quita el will-change ANTES de escribirle
 *    la transición y repinta cada fotograma a tamaño real.
 * 3. Ni filter, ni drop-shadow, ni backdrop-filter, ni mix-blend-mode, ni
 *    perspective, ni preserve-3d aquí ni en ningún ancestro. El grosor del taco
 *    va en box-shadow.
 *
 * Regla de bolsillo: promociona sólo lo que va a encoger; lo que crezca más de
 * un 8% que crezca despromocionado.
 */

/* ------------------------------------------------------------------ */
/* GEOMETRÍA — todo en fracciones de W (el ancho de la carta frontal). */
/* ------------------------------------------------------------------ */

/**
 * PENDIENTES (d = j − p ≥ 0, saturado a 4). x = (W/2)(1−s) + W·D_ASOMA[d].
 * El término (W/2)(1−s) reancla el borde derecho tras la escala, así que
 * D_ASOMA es LITERALMENTE la tira visible de cada carta.
 */
const D_ESCALA = [1, 0.955, 0.913, 0.874, 0.838];
const D_ASOMA = [0, 0.024, 0.043, 0.057, 0.068];
const D_BAJA = [0, 0.013, 0.026, 0.038, 0.05];
const D_GIRO = [0, 0.8, 1.6, 2.4, 3.0]; // grados
const D_OPACIDAD = [1, 0.92, 0.82, 0.7, 0.55];

/**
 * VISTAS (k = p − j > 0). Se apartan al otro lado; escala y caída reutilizan
 * las tablas D_ por k, porque una carta ya vista pesa lo mismo que una por ver.
 *
 * La cola va MUY comprimida (0.076 → 0.086 → 0.092 → 0.094) y no repartida:
 * el presupuesto de 0.1098·W tiene que cubrir el apartado MÁS lo que el giro
 * añade a la caja envolvente, y esa penalización crece con k. Medido: con el
 * reparto ancho de la primera versión, la vista k=3 se salía a 0.117·W y el
 * overflow-hidden del diálogo la cortaba en recto.
 */
const V_APARTA = [0, 0.074, 0.083, 0.088, 0.09];
const V_GIRO = [0, -0.7, -1.1, -1.3, -1.4];
const V_OPACIDAD = [1, 0.5, 0.2, 0.06, 0];

/** ABANICO: el mazo abierto bajo el dedo. `sep` es la tira visible de cada
 *  carta (0.060·W = 18,5px con W=307,5: borde entero y un dedo de arte —
 *  insinúa el botín, no lo revela). */
const ABANICO = {
  escala: 0.46,
  sep: 0.06,
  arco: 0.045,
  giro: 2.4, // grados por carta de separación al centro del mazo
  realce: 1.15,
  alza: 0.05,
};

/* ---------------------------- GESTO ------------------------------- */
/** Un roce no mueve la selección. */
const F_ZONA_MUERTA = 0.075;
/** Arrastre que vale una carta. */
const F_PASO = 0.3;
/** Arrastre con el que el abanico llega al 100%. */
const F_ABRE = 0.18;
/* El cruce de decisión cae en ZONA_MUERTA + PASO/2 = 0.225·W = 69px con
   W=307,5, contra los 70px del threshold de siempre: la memoria muscular
   del deslizamiento de toda la vida da exactamente el mismo resultado. */

/** Cierre del mazo tras soltar, y relevo entre cartas por toque o teclado. */
const T_CIERRE = 260;
/** La pila apilada se abre en abanico de reposo: más lento, es un respiro. */
const T_DESPLIEGUE = 380;

const interp = (tabla: number[], d: number) => {
  const ultimo = tabla.length - 1;
  if (d <= 0) return tabla[0];
  if (d >= ultimo) return tabla[ultimo];
  const i = Math.floor(d);
  return tabla[i] + (tabla[i + 1] - tabla[i]) * (d - i);
};

type Pose = { x: number; y: number; g: number; s: number; o: number };

/** Mazo cerrado: la carta actual de frente, el resto asomando el canto. */
function reposo(j: number, p: number, W: number, apilado: boolean): Pose {
  const d = j - p;
  // Sin desplegar, el mazo es un bloque macizo: todas las ranuras exactamente
  // detrás de la frontal (así el sobre emerge como un objeto sólido).
  if (!apilado) {
    return Math.abs(d) < 0.5
      ? { x: 0, y: 0, g: 0, s: 1, o: 1 }
      : { x: 0, y: 0, g: 0, s: 1, o: 0 };
  }
  if (d >= 0) {
    const dd = Math.min(d, 4);
    const s = interp(D_ESCALA, dd);
    return {
      x: (W / 2) * (1 - s) + W * interp(D_ASOMA, dd),
      y: W * interp(D_BAJA, dd),
      g: interp(D_GIRO, dd),
      s,
      o: interp(D_OPACIDAD, dd),
    };
  }
  const k = Math.min(-d, 4);
  const s = interp(D_ESCALA, k);
  return {
    x: -((W / 2) * (1 - s) + W * interp(V_APARTA, k)),
    y: W * interp(D_BAJA, k),
    g: interp(V_GIRO, k),
    s,
    o: interp(V_OPACIDAD, k),
  };
}

/** Mazo abierto: las diez repartidas en arco, centradas en el MAZO (no en la
 *  selección) para que el abanico no se descuelgue a un lado al pasar cartas. */
function abanico(j: number, p: number, W: number, n: number): Pose {
  const uMax = (n - 1) / 2 || 1;
  const u = j - (n - 1) / 2;
  // 1 en la seleccionada y 0 a una carta de distancia: sólo ella se realza.
  const foco = Math.max(0, 1 - Math.abs(j - p));
  return {
    x: W * ABANICO.sep * u,
    y: W * (ABANICO.arco * (u / uMax) ** 2 - ABANICO.alza * foco),
    g: ABANICO.giro * u,
    s: ABANICO.escala * (1 + (ABANICO.realce - 1) * foco),
    o: 1,
  };
}


interface MazoCartasProps {
  cartas: any[];
  indice: number;
  /** Cartas ya destapadas: la selección nunca puede pasar de aquí. */
  maxRevealed: number;
  /** La primera carta del sobre: el MARCO hace la coreografía de emergencia. */
  emerge: boolean;
  /** La pila ya puede abrirse en abanico de reposo (a partir de T_FANFARRIA). */
  desplegado: boolean;
  efectosApagados: boolean;
  /** Gestos activos: sólo en fase "cartas". */
  habilitado: boolean;
  /** Zona que escucha el gesto: es la misma que lleva el rol de botón, el foco
   *  y el onClick, y sigue viviendo en la página. */
  zonaRef: RefObject<HTMLDivElement | null>;
  /**
   * Buzón para el ref "acabo de arrastrar" del hook de gestos: el hook vive
   * aquí pero el onClick que tiene que ignorar el click sintético posterior
   * está en la página, sobre la zona.
   */
  gestoRef: MutableRefObject<RefObject<boolean> | null>;
  onSeleccionar: (destino: number) => void;
}

export default function MazoCartas({
  cartas,
  indice,
  maxRevealed,
  emerge,
  desplegado,
  efectosApagados,
  habilitado,
  zonaRef,
  gestoRef,
  onSeleccionar,
}: MazoCartasProps) {
  const haptic = useHaptics();
  const marcoRef = useRef<HTMLDivElement>(null);
  const ranurasRef = useRef<(HTMLDivElement | null)[]>([]);
  /** Ancho de la carta frontal: se lee una vez por gesto, nunca por fotograma. */
  const anchoRef = useRef(0);
  /** Selección continua bajo el dedo (fraccional durante el arrastre). */
  const pRef = useRef(indice);
  /** Último Math.round(p) al que se le puso el z-index y el detente háptico. */
  const focoRef = useRef(-1);
  /** Deslizamiento confirmado por el hook: -1 izquierda, +1 derecha, 0 nada. */
  const flingRef = useRef(0);
  /** Hay un arrastre en curso al que aún no le ha llegado su onEnd. */
  const gestoVivoRef = useRef(false);
  const limpiezaRef = useRef(0);
  const montadoRef = useRef(false);
  const desplegadoPrevRef = useRef(desplegado);

  const n = cartas.length;
  /** Tope de selección: sólo se avanza UNA carta por gesto, porque maxRevealed
   *  no sube hasta que la carta llega. Hacia atrás no hay tope. */
  const tope = Math.max(0, Math.min(maxRevealed, n - 1));

  const medir = useCallback(() => {
    const w = marcoRef.current?.offsetWidth || zonaRef.current?.offsetWidth || 0;
    if (w > 0) anchoRef.current = w;
    return anchoRef.current;
  }, [zonaRef]);

  /** z-index: sólo se escribe cuando cambia la carta enfocada, jamás por
   *  fotograma (tocarlo en cada movimiento fuerza recomposición del árbol). */
  const escribirZ = useCallback((foco: number) => {
    for (let j = 0; j < ranurasRef.current.length; j++) {
      const el = ranurasRef.current[j];
      if (el) el.style.zIndex = String(j === foco ? 40 : 30 - Math.abs(foco - j));
    }
  }, []);

  /**
   * ÚNICO punto de todo el proyecto que escribe el transform de una ranura.
   * React no toca nunca `transform` ni `opacity` aquí, así que sus re-renders
   * (cambio de índice, de variante de imagen…) no pisan el gesto en curso.
   * Es idempotente: escribir dos veces el mismo destino no reinicia nada,
   * porque una transición CSS sólo arranca si el valor calculado cambia.
   */
  const escribirMazo = useCallback(
    (p: number, f: number, opts?: { transicion?: number; apilado?: boolean }) => {
      // Sin guarda de W a propósito: si midiera 0 (layout aún sin resolver),
      // x e y salen 0 pero las opacidades NO dependen de W, así que el mazo
      // degrada a una pila perfecta con la carta buena delante — nunca a diez
      // cartas superpuestas con la última encima.
      const W = anchoRef.current || medir();
      const apilado = opts?.apilado ?? (desplegadoPrevRef.current || efectosApagados);
      const ms = efectosApagados ? 0 : (opts?.transicion ?? 0);
      // smoothstep: el abanico arranca y frena suave aunque el dedo vaya lineal.
      const v = f * f * (3 - 2 * f);
      const foco = Math.round(p);
      if (foco !== focoRef.current) {
        focoRef.current = foco;
        escribirZ(foco);
      }
      for (let j = 0; j < n; j++) {
        const el = ranurasRef.current[j];
        if (!el) continue;
        const r = reposo(j, p, W, apilado);
        let { x, y, g, s, o } = r;
        if (v > 0) {
          const a = abanico(j, p, W, n);
          x = r.x + (a.x - r.x) * v;
          y = r.y + (a.y - r.y) * v;
          g = r.g + (a.g - r.g) * v;
          s = r.s + (a.s - r.s) * v;
          // La opacidad sólo sube: el abanico enseña TODAS las ranuras.
          o = r.o + (1 - r.o) * v;
        }
        el.style.transition = ms
          ? `transform ${ms}ms cubic-bezier(.16,1,.3,1), opacity ${ms}ms linear`
          : "none";
        // La frontal en reposo se queda SIN transform: sin capa, sin escala y
        // sin contexto de apilado propio, que es la condición exacta que
        // PokemonCard necesita para pintarse a la densidad de la pantalla.
        el.style.transform =
          j === foco && v === 0 && x === 0 && y === 0 && g === 0 && s === 1
            ? ""
            : `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0) rotate(${g.toFixed(2)}deg) scale(${s.toFixed(4)})`;
        el.style.opacity = String(o);
      }
    },
    [efectosApagados, escribirZ, medir, n],
  );

  /**
   * Reposición: cambio de carta (toque, teclado, botón), despliegue de la pila
   * y llegada de cartas nuevas (sube maxRevealed y con él el fondo del mazo).
   * Va en layout effect para que el destino esté escrito antes de pintar.
   */
  useLayoutEffect(() => {
    medir();
    const abriendo = desplegado && !desplegadoPrevRef.current;
    desplegadoPrevRef.current = desplegado;
    pRef.current = indice;
    flingRef.current = 0;
    const transicion = !montadoRef.current
      ? 0 // primer pintado: nada que animar, el mazo nace donde le toca
      : abriendo
        ? T_DESPLIEGUE
        : T_CIERRE;
    montadoRef.current = true;
    escribirMazo(indice, 0, { transicion });
  }, [indice, maxRevealed, desplegado, escribirMazo, medir]);

  /**
   * La barra dinámica de Safari mueve --app-height y con ella CARD_WIDTH: sin
   * releer W el mazo se queda descuadrado hasta el siguiente gesto.
   */
  useEffect(() => {
    const recolocar = () => {
      anchoRef.current = 0;
      medir();
      escribirMazo(pRef.current, 0, { transicion: 0 });
    };
    window.addEventListener("resize", recolocar);
    window.addEventListener("orientationchange", recolocar);
    return () => {
      window.removeEventListener("resize", recolocar);
      window.removeEventListener("orientationchange", recolocar);
      window.clearTimeout(limpiezaRef.current);
    };
  }, [escribirMazo, medir]);

  const promocionar = (activo: boolean) => {
    for (const el of ranurasRef.current) {
      if (el) el.style.willChange = activo ? "transform" : "";
    }
  };

  const didSwipe = useSwipe(zonaRef, {
    axis: "both",
    follow: false,
    threshold: 70,
    velocity: 420,
    enabled: habilitado,
    onStart: () => {
      const W = medir();
      gestoVivoRef.current = true;
      flingRef.current = 0;
      pRef.current = indice;
      window.clearTimeout(limpiezaRef.current);
      // useSwipe promociona la ZONA aunque follow sea false, y la zona es
      // ancestro de las diez ranuras: dejarlo rasterizaría el subárbol entero
      // a una escala y saldrían borrosas las diez a la vez.
      if (zonaRef.current) zonaRef.current.style.willChange = "";
      // Las ranuras sí se promocionan, y justo ahora: la frontal está a escala
      // 1 y durante todo el arrastre las escalas sólo bajan.
      if (W) promocionar(true);
    },
    onMove: (dx) => {
      const W = anchoRef.current;
      if (!W) return;
      const adx = Math.abs(dx);
      const f = Math.min(1, adx / (F_ABRE * W));
      const avance = Math.max(0, adx - F_ZONA_MUERTA * W) / (F_PASO * W);
      let p = indice - Math.sign(dx) * avance;
      // Goma en los dos topes, y sólo aquí: la resistencia interna del hook no
      // entra nunca porque siempre le damos manejador en ambas direcciones.
      //
      // El exceso se satura en 0,45 de carta —menos de medio paso— y no sólo se
      // divide por cuatro: con la goma suelta, un arrastre largo (207px hacia
      // atrás en la carta 0, 299px hacia delante) llevaba round(p) a una ranura
      // FUERA del rango seleccionable, así que el mazo la realzaba, le daba el
      // z-index y disparaba su detente háptico... para luego soltar en otra.
      // Saturando por debajo de medio paso, round(p) siempre cae en [0, tope]:
      // lo que se resalta y lo que vibra es siempre donde se va a aterrizar.
      if (p > tope) p = tope + Math.min(0.45, (p - tope) * 0.25);
      else if (p < 0) p = Math.max(-0.45, p * 0.25);
      pRef.current = p;
      const foco = Math.round(p);
      const cambio = foco !== focoRef.current;
      escribirMazo(p, f);
      // Detente: el mismo idioma que las muescas del rasgado.
      if (cambio && !efectosApagados) haptic("tap");
    },
    // Sólo anotan el deslizamiento: la navegación la decide dónde SUELTAS.
    onSwipeLeft: () => {
      flingRef.current = -1;
    },
    onSwipeRight: () => {
      flingRef.current = 1;
    },
    onEnd: () => {
      gestoVivoRef.current = false;
      let destino = Math.round(pRef.current);
      // Deslizamiento corto y decidido que no llegó a cruzar medio paso: manda
      // el fling (izquierda avanza, derecha retrocede), como siempre.
      if (flingRef.current !== 0 && destino === indice) {
        destino = indice + (flingRef.current === -1 ? 1 : -1);
      }
      destino = Math.max(0, Math.min(destino, tope));
      flingRef.current = 0;
      pRef.current = destino;
      // La ranura destino CRECE (hasta +89%): se despromociona antes de que le
      // corra la transición encima, para que repinte a tamaño real.
      const elDestino = ranurasRef.current[destino];
      if (elDestino) elDestino.style.willChange = "";
      escribirMazo(destino, 0, { transicion: T_CIERRE });
      if (destino !== indice) onSeleccionar(destino);
      // Las otras nueve sólo encogen: conservan la capa hasta que acaba el
      // cierre. NUNCA se cierra el sobre desde aquí (ver §3 del plan): el
      // arrastre es el gesto exploratorio y el cierre vive en el toque, el
      // botón "Guardar sobre", Enter y Espacio.
      window.clearTimeout(limpiezaRef.current);
      limpiezaRef.current = window.setTimeout(
        () => promocionar(false),
        efectosApagados ? 0 : T_CIERRE + 80,
      );
    },
  });

  /**
   * CIERRE DE SEGURIDAD. useSwipe abandona el gesto EN SECO cuando baja un
   * segundo dedo (lo trata como pellizco, hooks/useSwipe.ts:145-149) y por ese
   * camino NO llama a onEnd: el mazo se quedaría congelado a medio abanico, con
   * las diez ranuras promocionadas, hasta el siguiente toque. Se comprueba en
   * un temporizador a 0 para que el onEnd normal —que es síncrono— gane
   * siempre, sea cual sea el orden en que se registraron los escuchas (useSwipe
   * vuelve a suscribirse cada vez que cambia `enabled`).
   */
  useEffect(() => {
    const revisar = () => {
      window.setTimeout(() => {
        if (!gestoVivoRef.current) return;
        gestoVivoRef.current = false;
        flingRef.current = 0;
        pRef.current = indice;
        escribirMazo(indice, 0, { transicion: T_CIERRE });
        window.clearTimeout(limpiezaRef.current);
        limpiezaRef.current = window.setTimeout(() => {
          for (const el of ranurasRef.current) {
            if (el) el.style.willChange = "";
          }
        }, efectosApagados ? 0 : T_CIERRE + 80);
      }, 0);
    };
    window.addEventListener("pointerup", revisar);
    window.addEventListener("pointercancel", revisar);
    return () => {
      window.removeEventListener("pointerup", revisar);
      window.removeEventListener("pointercancel", revisar);
    };
  }, [indice, efectosApagados, escribirMazo]);

  // El onClick de la zona vive en la página y necesita este ref para ignorar el
  // click sintético que el navegador emite tras un arrastre.
  useEffect(() => {
    gestoRef.current = didSwipe;
    return () => {
      gestoRef.current = null;
    };
  }, [didSwipe, gestoRef]);

  return (
    <motion.div
      ref={marcoRef}
      // MARCO: aquí vive la coreografía de emergencia que antes llevaba la
      // carta suelta. Mismos fotogramas, misma duración y mismos `times`: sube
      // 90px por la boca del sobre (única salida visible, el sobre tapa el
      // resto) y se asienta mientras el cuerpo cae por detrás. Sin
      // perspective y sin rotateY: existían para disimular un relevo que ya no
      // hay, y un contexto 3D con diez cartas montadas es el mayor riesgo de
      // rasterizado del proyecto.
      initial={emerge && !efectosApagados ? { y: 0, scale: 0.97 } : false}
      animate={
        emerge && !efectosApagados
          ? { y: [0, -90, 0], scale: [0.97, 0.99, 1] }
          : { y: 0, scale: 1 }
      }
      transition={
        emerge && !efectosApagados
          ? { duration: 0.7, times: [0, 0.55, 1], ease: ["easeOut", "easeInOut"] }
          : { duration: 0 }
      }
      className="relative w-full aspect-[2.5/3.5]"
    >
      {cartas.map((carta, j) => (
        <div
          key={j}
          ref={(el) => {
            ranurasRef.current[j] = el;
          }}
          // El lector de pantalla ya recita la carta buena por el aria-live de
          // la vista y por la etiqueta de la zona: sin esto recitaría diez.
          aria-hidden={j === indice ? undefined : "true"}
          className="absolute inset-0"
          style={{
            // Grosor del taco. box-shadow y NUNCA drop-shadow: un filter aquí
            // rasteriza el subárbol y las diez cartas salen blandas.
            boxShadow:
              "6px 0 10px -6px rgba(0,0,0,.45), 0 6px 14px -10px rgba(0,0,0,.5)",
            borderRadius: "4.5%",
          }}
        >
          {/* TODAS las cartas van de cara, también las que aún no has pasado:
              es lo que se pidió — abrir el abanico y ver el canto de todas
              "para ver si me ha tocado algo bueno". Con dorsos, el abanico sólo
              servía al final del sobre, cuando ya no hace falta.
              No destripa nada de más: en reposo las de detrás asoman ~10px y en
              abanico ~18px, una tira de arte que deja intuir un foil o un dorado
              pero no identificar la carta. Y durante la emergencia el mazo va
              apilado con las nueve a opacidad 0, así que la sorpresa de la
              primera carta sigue intacta.
              Grande sólo la frontal y sus dos vecinas: al resto la variante
              pequeña le sobra por 4,5x para la tira que se ve. */}
          <PokemonCard
            card={carta}
            reveal
            interactive={false}
            useHighRes={Math.abs(j - indice) <= 1}
          />
        </div>
      ))}
    </motion.div>
  );
}
