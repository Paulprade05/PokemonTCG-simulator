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
 *
 * ---------------------------------------------------------------------------
 * FÍSICA DEL GESTO — por qué el mazo se mueve como papel y no como una lista.
 *
 * 1. MIENTRAS ARRASTRAS. El transform se escribe desde el propio pointermove:
 *    sin setState, sin rAF y sin transition (todas las ranuras a "none"), así
 *    que el mazo va pegado al dedo sin un fotograma de deuda. En los topes hay
 *    goma: p se recorta al rango y la resistencia se pinta como un tirón del
 *    mazo entero por su diagonal, con una ley asintótica que nunca llega a
 *    pararse del todo.
 * 2. AL SOLTAR. Se mide la velocidad (media móvil de VENTANA_VEL_MS) y se
 *    proyecta con deceleración exponencial: un lanzamiento arrastra varias
 *    cartas y frena, un empujón corto engancha a la de al lado. El destino se
 *    redondea SIEMPRE a una ranura del rango, nunca se queda a medias.
 * 3. LA LLEGADA. Duración proporcional al recorrido (T_CIERRE_MIN..MAX) con
 *    muelle suave, y escalonada: la carta que sueltas aterriza primero y el
 *    resto la sigue con RETARDO_CARTA_MS por cada carta de distancia. Un mazo
 *    real no se cierra en bloque, y ese desfase es todo lo que hace falta.
 *
 * Las tres comparten el mismo reloj: el will-change vive exactamente lo que
 * dura la coreografía (duración + retardo del último + margen) y se limpia.
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

/**
 * Escalón de la escalera, en PÍXELES y no en fracción del ancho: lo que se
 * pide es ver "literalmente unos 10 píxeles del borde", y eso no debe encoger
 * ni crecer con el tamaño de la carta.
 *
 * 10px es el canto puro: el filo del marco y, en un full art o una dorada, el
 * arte o el metalizado sangrando hasta el borde. Suficiente para saber que ahí
 * hay algo especial; imposible para saber qué carta es.
 */
const PASO_PX = 10;
/** Componente vertical del escalón: da la diagonal del mazo en la mano. */
const PASO_ALTO_PX = 7;

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

/* --------------------------- INERCIA ------------------------------ */
/**
 * Ventana de la media móvil de velocidad, en ms. A 60-120Hz caben entre 5 y 10
 * muestras: bastantes para que el temblor de una sola no dispare un
 * lanzamiento, y pocas para que lo que se mida sea el ACELERÓN final y no el
 * arrastre lento que venía antes. Por debajo de ~50ms manda el ruido de una
 * muestra suelta; por encima de ~120ms aparece el defecto clásico de "lo paré
 * antes de levantar el dedo y el mazo siguió andando".
 */
const VENTANA_VEL_MS = 80;
/**
 * Velocidad que se come el rozamiento, en px/ms. 0,45 px/ms son 450px/s, justo
 * por encima de los 420px/s con los que useSwipe declara un flick: por debajo,
 * el gesto es COLOCAR y manda dónde sueltas, no la inercia.
 *
 * Se DESCUENTA de la velocidad en vez de compararse contra ella. Comparando,
 * pasar de 0,44 a 0,46 px/ms daba un salto de media carta de golpe —el mismo
 * gesto, dos resultados— y ese escalón se nota muchísimo. Descontando, la
 * inercia entra desde cero y crece con el impulso.
 */
const V_MIN_INERCIA = 0.45;
/**
 * Constante de tiempo de la deceleración, en ms. Con v(t) = v₀·e^(−t/τ) lo que
 * queda por recorrer es exactamente v₀·τ, así que proyectar es multiplicar: ni
 * bucle de integración ni rAF (que en el panel de vista previa ni siquiera
 * corre).
 * 90ms, con el paso de 0,3·W ≈ 92px: un empujón de 1 px/ms añade media carta,
 * un lanzamiento normal de pulgar (1,5-2,5 px/ms) añade 1-2, y a partir de
 * 3,5 px/ms satura en el tope. Con 40ms no se notaría que hubo lanzamiento;
 * con 200ms el mazo se va de las manos.
 */
const TAU_INERCIA_MS = 90;
/** Tope de la proyección: más de tres cartas de más y ya no puedes apuntar. */
const TOPE_INERCIA = 3;

/* ------------------------ CIERRE DEL MAZO ------------------------- */
/**
 * DURACIÓN PROPORCIONAL AL RECORRIDO. Un ajuste de nada llega enseguida y un
 * lanzamiento de tres cartas tiene peso. Los extremos son los de un gesto de
 * interfaz: por debajo de 180ms el ojo no sigue el movimiento (lo lee como
 * salto) y por encima de 420ms se siente lento.
 *
 * Calibrado para no romper nada: con recorrido = 1 carta la fórmula devuelve
 * 180 + 240/3 = 260ms EXACTOS, que es el T_CIERRE fijo de siempre. El relevo
 * por toque, teclado y botón conserva su tempo al milisegundo; lo único que
 * cambia es que un ajuste corto llega antes y un salto largo llega después.
 */
const T_CIERRE_MIN = 180;
const T_CIERRE_MAX = 420;
/** Recorrido, en cartas, que satura la duración. */
const D_REF_CIERRE = 3;
/**
 * Cerrar el abanico también es recorrido aunque no cambies de carta: las del
 * fondo se traen 90px. Vale 0,6 cartas para que soltar sin moverse cierre en
 * ~230ms y no en el mínimo seco.
 */
const F_PESO_ABANICO = 0.6;
/**
 * MUELLE de papel. Medido: sobrepasa el 4,1% del recorrido a la mitad del
 * tiempo y dedica la otra mitad a asentarse. En la carta que más viaja (90px de
 * escalera) son 3,7px de rebote; en un ajuste de 15px, 0,6px. Es el "clac" del
 * taco al cuadrarse, no una goma: un muelle de verdad (overshoot del 15-20%)
 * en diez cartas a la vez parece gelatina.
 *
 * Sólo va en el transform. En la opacidad, un sobrepaso se saldría de [0,1], y
 * el recorte se ve como un parpadeo: allí sigue mandando una rampa lineal.
 * Y no toca la nitidez: en la escalera todas las escalas son 1, así que el
 * sobrepaso mueve traslaciones, nunca agranda una capa ya rasterizada.
 */
const CURVA_MUELLE = "cubic-bezier(.2,1.35,.3,1)";
/** La de siempre, sin sobrepaso: la usa el despliegue de la pila. */
const CURVA_SALIDA = "cubic-bezier(.16,1,.3,1)";
/**
 * ESCALONADO DE LA LLEGADA. La carta que sueltas aterriza primero y las demás
 * la siguen: un mazo real no se cierra en bloque. 11ms por carta de distancia a
 * la seleccionada está en el centro de la banda que se lee como "flujo": por
 * debajo de 8 no se distingue de un cierre simultáneo y por encima de 14 se ven
 * diez cartas cayendo por separado.
 */
const RETARDO_CARTA_MS = 11;
/**
 * Tope del escalonado: sin él, la carta 0 vista desde la 9 saldría 99ms tarde y
 * el cierre pasaría de medio segundo. 70ms (≈6,4 cartas) deja la cola bien
 * marcada y mantiene el peor caso en 420+70 = 490ms, por debajo de los 550ms de
 * GUARDA_CIERRE (app/page.tsx): el mazo SIEMPRE termina de asentarse antes de
 * que se acepte el toque que guarda el sobre.
 */
const RETARDO_TOPE_MS = 70;
/** Margen tras el último fotograma antes de despromocionar las capas. */
const T_LIMPIEZA_MS = 80;
/** La pila apilada se abre en abanico de reposo: más lento, es un respiro. */
const T_DESPLIEGUE = 380;

/* ------------------------------ GOMA ------------------------------ */
/**
 * Tirón máximo del mazo ENTERO en los extremos, en píxeles a lo largo de su
 * diagonal. 18px es visible de sobra (casi dos escalones de 10px) y sigue por
 * debajo de los 35px que hay entre el borde de la carta frontal y el del
 * viewport en el caso peor (W = 0,82·vw), así que la carta que estás mirando
 * nunca llega a tocar el recorte del diálogo.
 */
const GOMA_MAX_PX = 18;
/**
 * Pendiente inicial del tirón: el mazo arranca siguiendo al dedo a algo menos
 * de un tercio y se va frenando. La mitad del recorrido se alcanza a los 64px
 * de sobrearrastre, que es más o menos lo que se pasa uno al lanzar.
 */
const GOMA_K = 0.28;

/**
 * Resistencia asintótica: g(e) = MAX·e/(e + MAX/K), con g'(0) = K.
 *
 * Antes el exceso se dividía por cuatro y se recortaba EN SECO a 0,45 de carta:
 * pasado ese punto el dedo seguía moviéndose y el mazo no, que es literalmente
 * la sensación de tope duro que se quería quitar. Ahora nunca llega al máximo,
 * así que el mazo siempre responde algo, y como el tirón ya no viaja dentro de
 * `p` (viaja aparte, en píxeles), round(p) no puede salirse de [0, tope] ni
 * por asomo: se acabó realzar y vibrar en una ranura donde luego no se aterriza.
 */
const goma = (excesoPx: number) =>
  (GOMA_MAX_PX * excesoPx) / (excesoPx + GOMA_MAX_PX / GOMA_K);

/** Duración del cierre para un recorrido dado, en cartas. */
const duracionCierre = (recorrido: number) =>
  Math.round(
    T_CIERRE_MIN +
      (T_CIERRE_MAX - T_CIERRE_MIN) * Math.min(1, Math.abs(recorrido) / D_REF_CIERRE),
  );

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
/**
 * ESCALERA. Las cartas se escalonan en diagonal desde la seleccionada, como un
 * mazo abierto en la mano: cada una asoma exactamente PASO_PX del canto de la
 * de delante, y nada más.
 *
 * No hay giro ni cambio de escala: con las cartas en paralelo el escalón es
 * constante y el ojo lee los cantos de un vistazo. En abanico, la rotación
 * hacía que el trozo visible cambiara de grosor según la posición, que es
 * justo lo que estorba para comparar.
 *
 * El solape hace todo el trabajo: la carta j queda tapada por la j-1 salvo su
 * escalón, así que el canto visible es literalmente PASO_PX. Sólo la
 * seleccionada se ve entera, que es la que estás mirando.
 */
function escalera(j: number, p: number): Pose {
  const d = j - p;
  return {
    // A la derecha las que faltan, a la izquierda las ya vistas: la escalera
    // atraviesa la seleccionada y da sensación de posición en el mazo.
    x: PASO_PX * d,
    // Sube al alejarse hacia delante y baja hacia atrás: la diagonal de un
    // mazo apoyado en la mano.
    y: -PASO_ALTO_PX * d,
    g: 0,
    s: 1,
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
  /** Muestras (t, dx) del arrastre para medir la velocidad al soltar. */
  const muestrasRef = useRef<{ t: number; dx: number }[]>([]);
  /** Último desplazamiento visto: onEnd no recibe ninguno. */
  const dxRef = useRef(0);
  /** Apertura del abanico (0-1) en el último fotograma del arrastre. */
  const fRef = useRef(0);
  /**
   * Destino cuyo cierre ya escribió el gesto. El re-render que provoca
   * onSeleccionar dispara el layout effect, y sin esta marca volvería a escribir
   * el mismo destino con la duración por defecto y sin escalonado, aplanando la
   * coreografía que el gesto acababa de calcular.
   */
  const cierreRef = useRef(-1);
  /**
   * Última cadena de `transition` escrita en cada ranura. Durante el arrastre el
   * valor es siempre "none": comparar evita que el motor de estilo reparsee diez
   * declaraciones en cada pointermove (a 120Hz son 1.200 por segundo tiradas).
   */
  const transRef = useRef<string[]>([]);
  /** Índice anterior: da el recorrido del relevo por toque, tecla o botón. */
  const indicePrevRef = useRef(indice);

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
    (
      p: number,
      f: number,
      opts?: {
        transicion?: number;
        apilado?: boolean;
        /** Tirón de goma del mazo entero, en px a lo largo de la escalera. */
        goma?: number;
        /** Reparte la llegada: cuanto más lejos de la seleccionada, más tarde. */
        escalonado?: boolean;
        curva?: string;
      },
    ) => {
      // Sin guarda de W a propósito: si midiera 0 (layout aún sin resolver),
      // x e y salen 0 pero las opacidades NO dependen de W, así que el mazo
      // degrada a una pila perfecta con la carta buena delante — nunca a diez
      // cartas superpuestas con la última encima.
      const W = anchoRef.current || medir();
      const apilado = opts?.apilado ?? (desplegadoPrevRef.current || efectosApagados);
      const ms = efectosApagados ? 0 : (opts?.transicion ?? 0);
      const curva = opts?.curva ?? CURVA_MUELLE;
      const escalonado = ms > 0 && !!opts?.escalonado;
      // El tirón llega en píxeles pero se aplica como un corrimiento de p sobre
      // la ESCALERA: mover el mazo entero PASO_PX es, por construcción, lo mismo
      // que correrlo una carta, así que la goma viaja por la diagonal 10/7 del
      // mazo sin una sola línea de trigonometría. Va dentro del término de
      // escalera, así que se desvanece con el abanico y vuelve solo al soltar.
      const gp = (opts?.goma ?? 0) / PASO_PX;
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
          const a = escalera(j, p + gp);
          x = r.x + (a.x - r.x) * v;
          y = r.y + (a.y - r.y) * v;
          g = r.g + (a.g - r.g) * v;
          s = r.s + (a.s - r.s) * v;
          // La opacidad sólo sube: la escalera enseña TODAS las ranuras.
          o = r.o + (1 - r.o) * v;
        }
        // ESCALONADO. El retardo se mide contra la carta enfocada, no contra el
        // índice: lo que tiene que llegar primero es la que sueltas.
        const retardo = escalonado
          ? Math.min(RETARDO_TOPE_MS, RETARDO_CARTA_MS * Math.abs(j - foco))
          : 0;
        const trans = ms
          ? `transform ${ms}ms ${curva} ${retardo}ms, opacity ${ms}ms linear ${retardo}ms`
          : "none";
        if (trans !== transRef.current[j]) {
          transRef.current[j] = trans;
          el.style.transition = trans;
        }
        // Sin recorte: en escalera el solape ya deja a la vista exactamente el
        // escalón (PASO_PX) de cada carta, y sólo la seleccionada —la que estás
        // mirando— se ve entera. El clip-path que hacía falta con el abanico
        // sobra aquí, y de paso se ahorra un contexto de apilado por ranura.
        //
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
    const salto = Math.abs(indice - indicePrevRef.current);
    indicePrevRef.current = indice;
    pRef.current = indice;
    flingRef.current = 0;
    const primera = !montadoRef.current;
    montadoRef.current = true;
    // El gesto ya escribió EXACTAMENTE este cierre, con su duración y sus
    // retardos: repisarlo aquí lo aplanaría a mitad de vuelo.
    if (cierreRef.current === indice) return;
    if (primera) {
      // Primer pintado: nada que animar, el mazo nace donde le toca.
      escribirMazo(indice, 0, { transicion: 0 });
      return;
    }
    if (abriendo) {
      // Despliegue de la pila: la coreografía de la apertura del sobre no se
      // toca — misma duración, misma curva sin muelle y las diez a la vez.
      escribirMazo(indice, 0, { transicion: T_DESPLIEGUE, curva: CURVA_SALIDA });
      return;
    }
    // Sólo ha subido maxRevealed (el fondo del mazo): las poses no dependen de
    // él, así que no hay nada que reescribir y sí un cierre en curso que
    // molestar.
    if (salto === 0) return;
    // Relevo por toque, tecla o botón: la misma ley que el gesto. Con salto = 1
    // devuelve los 260ms de siempre.
    escribirMazo(indice, 0, { transicion: duracionCierre(salto), escalonado: true });
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

  /**
   * Velocidad del dedo al soltar, en px/ms, como media móvil de la ventana.
   *
   * La muestra virtual del final es la pieza clave: si el dedo se paró y lo
   * levantaste medio segundo después, esos milisegundos quietos entran en la
   * media y la velocidad se apaga sola. Sin ella, la última muestra "viva"
   * seguiría marcando el lanzamiento que ya habías cancelado — el defecto más
   * habitual de las inercias hechas a ojo.
   */
  const medirVelocidad = () => {
    const m = muestrasRef.current;
    const ahora = performance.now();
    while (m.length && ahora - m[0].t > VENTANA_VEL_MS) m.shift();
    m.push({ t: ahora, dx: dxRef.current });
    const a = m[0];
    const b = m[m.length - 1];
    const dt = b.t - a.t;
    return dt > 0 ? (b.dx - a.dx) / dt : 0;
  };

  /**
   * Cartas que la inercia le suma al destino.
   *
   * El signo se invierte porque arrastrar a la derecha (dx > 0) BAJA el índice,
   * igual que en onMove.
   */
  const proyectarInercia = (vpx: number, W: number) => {
    const paso = F_PASO * W;
    if (!paso) return 0;
    // Lo que sobra del rozamiento es lo único que sigue empujando.
    const util = Math.max(0, Math.abs(vpx) - V_MIN_INERCIA);
    if (!util) return 0;
    const cartas = Math.min(TOPE_INERCIA, (util * TAU_INERCIA_MS) / paso);
    return -Math.sign(vpx) * cartas;
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
      muestrasRef.current.length = 0;
      dxRef.current = 0;
      fRef.current = 0;
      cierreRef.current = -1;
      window.clearTimeout(limpiezaRef.current);
      // useSwipe promociona la ZONA aunque follow sea false, y la zona es
      // ancestro de las diez ranuras: dejarlo rasterizaría el subárbol entero
      // a una escala y saldrían borrosas las diez a la vez.
      if (zonaRef.current) zonaRef.current.style.willChange = "";
      // Las ranuras sí se promocionan, y justo ahora: la frontal está a escala
      // 1 y durante todo el arrastre las escalas sólo bajan.
      if (W) promocionar(true);
    },
    // Nada de setState aquí: el arrastre se pinta escribiendo transforms desde
    // el propio pointermove. Ni React, ni rAF, ni un fotograma de retraso.
    onMove: (dx) => {
      const W = anchoRef.current;
      if (!W) return;
      // Ventana deslizante de velocidad. Se poda ANTES de meter la nueva
      // muestra para que la ventana sea siempre la de los últimos ms reales.
      const ahora = performance.now();
      const m = muestrasRef.current;
      while (m.length && ahora - m[0].t > VENTANA_VEL_MS) m.shift();
      m.push({ t: ahora, dx });
      dxRef.current = dx;

      const adx = Math.abs(dx);
      const f = Math.min(1, adx / (F_ABRE * W));
      fRef.current = f;
      const avance = Math.max(0, adx - F_ZONA_MUERTA * W) / (F_PASO * W);
      let p = indice - Math.sign(dx) * avance;
      // GOMA en los dos topes, y sólo aquí: la resistencia interna del hook no
      // entra nunca porque siempre le damos manejador en ambas direcciones.
      //
      // El exceso ya NO se cuela dentro de p. p se recorta al rango exacto —así
      // round(p) es siempre una ranura seleccionable, que es lo que impide
      // realzar, dar z-index y vibrar en una carta donde luego no se aterriza—
      // y la resistencia se pinta aparte, como un tirón del mazo ENTERO por su
      // diagonal, que además es lo único que se ve.
      let gomaPx = 0;
      if (p > tope) {
        gomaPx = goma((p - tope) * F_PASO * W);
        p = tope;
      } else if (p < 0) {
        gomaPx = -goma(-p * F_PASO * W);
        p = 0;
      }
      pRef.current = p;
      const foco = Math.round(p);
      const cambio = foco !== focoRef.current;
      escribirMazo(p, f, { goma: gomaPx });
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
      const W = anchoRef.current || medir();
      const pSoltado = pRef.current;
      // INERCIA: dónde habría acabado el mazo si siguiera rodando y frenando.
      let destino = Math.round(pSoltado + proyectarInercia(medirVelocidad(), W));
      // Deslizamiento corto y decidido que no llegó a cruzar medio paso ni a
      // marcar velocidad de lanzamiento: manda el fling (izquierda avanza,
      // derecha retrocede), como siempre. Los dos caminos no se pisan: por
      // debajo de V_MIN_INERCIA la proyección es exactamente 0.
      if (flingRef.current !== 0 && destino === indice) {
        destino = indice + (flingRef.current === -1 ? 1 : -1);
      }
      destino = Math.max(0, Math.min(destino, tope));
      flingRef.current = 0;
      pRef.current = destino;
      // Lo que de verdad recorre el mazo: el trecho hasta la ranura destino más
      // el abanico cerrándose. Un ajuste de nada sale en ~190ms; un lanzamiento
      // de tres cartas, en 420.
      const ms = duracionCierre(
        Math.abs(pSoltado - destino) + F_PESO_ABANICO * fRef.current,
      );
      // La ranura destino es la única que puede CRECER: se despromociona antes
      // de que le corra la transición encima, para que repinte a tamaño real.
      const elDestino = ranurasRef.current[destino];
      if (elDestino) elDestino.style.willChange = "";
      cierreRef.current = destino;
      escribirMazo(destino, 0, { transicion: ms, escalonado: true });
      if (destino !== indice) onSeleccionar(destino);
      fRef.current = 0;
      muestrasRef.current.length = 0;
      // Las otras nueve sólo encogen: conservan la capa hasta que acaba el
      // cierre, retardos incluidos. Un will-change que sobreviva al gesto deja
      // la textura rasterizada a una escala fija y desenfoca las diez cartas.
      // NUNCA se cierra el sobre desde aquí (ver §3 del plan): el arrastre es el
      // gesto exploratorio y el cierre vive en el toque, el botón "Guardar
      // sobre", Enter y Espacio.
      window.clearTimeout(limpiezaRef.current);
      limpiezaRef.current = window.setTimeout(
        () => {
          promocionar(false);
          cierreRef.current = -1;
        },
        efectosApagados ? 0 : ms + RETARDO_TOPE_MS + T_LIMPIEZA_MS,
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
        // Sin velocidad que valga: esto no es soltar, es un gesto abortado. Se
        // vuelve a donde se estaba, con la ley de siempre para que el mazo no
        // dé un tirón raro.
        const ms = duracionCierre(
          Math.abs(pRef.current - indice) + F_PESO_ABANICO * fRef.current,
        );
        pRef.current = indice;
        fRef.current = 0;
        muestrasRef.current.length = 0;
        cierreRef.current = indice;
        escribirMazo(indice, 0, { transicion: ms, escalonado: true });
        window.clearTimeout(limpiezaRef.current);
        limpiezaRef.current = window.setTimeout(
          () => {
            for (const el of ranurasRef.current) {
              if (el) el.style.willChange = "";
            }
            cierreRef.current = -1;
          },
          efectosApagados ? 0 : ms + RETARDO_TOPE_MS + T_LIMPIEZA_MS,
        );
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
            // Ranura nueva: su style está limpio, así que la caché de
            // transitions tiene que olvidar lo que creía haberle escrito.
            transRef.current[j] = "";
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
