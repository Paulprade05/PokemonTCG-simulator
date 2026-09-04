"use client";

import { motion } from "framer-motion";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type MutableRefObject, type RefObject } from "react";
import PokemonCard from "./PokemonCard";
import DesperfectosCarta, {
  estadoDeCopia,
  estiloDescentrado,
} from "./DesperfectosCarta";
import { useHaptics } from "../hooks/useHaptics";
import { useSwipe } from "../hooks/useSwipe";
import type { Desperfectos, MarcasDeCarta } from "../utils/graduacion";

/**
 * MAZO DE LA APERTURA (app/page.tsx, VIEW 3).
 *
 * DE UNA EN UNA. Se ve UNA carta y sólo una. Arrastrar pasa de carta —
 * izquierda avanza, derecha retrocede— pero no destapa nada del resto: no hay
 * abanico, no hay escalera y no asoma el canto de ninguna otra. Se probaron las
 * dos formas de enseñar el mazo entero bajo el dedo y las dos se descartaron.
 *
 * Entonces, ¿por qué siguen aquí las diez ranuras? Por FLUIDEZ, no por estética:
 * se montan UNA vez y se quedan montadas, así que pasar de carta es sólo mover
 * transforms. Cuando cada avance montaba y desmontaba un <motion.div> (con su
 * <img> grande recién pedida), ese relevo era lo que se sentía tosco. Las nueve
 * que no se ven están apartadas fuera de la pantalla y a opacidad 0; la de al
 * lado ya tiene su imagen grande decodificada para cuando le toque salir.
 *
 * ---------------------------------------------------------------------------
 * INVARIANTE DE ESPACIO — en reposo NO se ve nada más que la carta de delante.
 *
 * CARD_WIDTH = min(82vw, 360px, …). En el caso peor W = 0.82·vw, así que el
 * borde del viewport cae a 0.61·W del centro de la carta y el diálogo lleva
 * overflow-hidden. Las apartadas se van a F_SALIDA·W, que está calculado para
 * dejar su canto más cercano en 0.676·W: fuera de la pantalla, ni un píxel
 * asomando. En pantallas anchas (W = 360px con vw de sobra) sí caben al lado, y
 * por eso van ADEMÁS a opacidad 0. Las dos condiciones son necesarias.
 *
 * Mientras una carta SALE sí la corta el borde de la pantalla, y así debe ser:
 * eso es lo que significa salirse de la pantalla. Lo que no puede pasar —y era
 * el defecto del abanico— es que una carta quieta aparezca cortada en recto.
 *
 * ---------------------------------------------------------------------------
 * NITIDEZ.
 *
 * 1. Ninguna pose lleva escala. Ni una. Así ninguna capa se rasteriza a un
 *    tamaño para pintarse a otro, que es la única forma de emborronar una carta
 *    promocionada (el abanico encogía las de detrás hasta 0.529 y la que
 *    volvía crecía un 89%: allí sí había que despromocionar antes de la
 *    transición, aquí no hace falta).
 * 2. `will-change` sólo en las ranuras que se están moviendo y sólo mientras se
 *    mueven. Un will-change permanente deja la textura congelada.
 * 3. Ni filter, ni drop-shadow, ni backdrop-filter, ni mix-blend-mode, ni
 *    perspective, ni preserve-3d aquí ni en ningún ancestro. La sombra de la
 *    carta va en box-shadow.
 *
 * ---------------------------------------------------------------------------
 * FÍSICA DEL GESTO — por qué pasar de carta se siente como papel.
 *
 * 1. MIENTRAS ARRASTRAS. La carta que ves sigue al dedo con resistencia
 *    creciente (nunca se despega del centro más de SIGUE_MAX_F·W) y detrás no
 *    aparece nada. El transform se escribe desde el propio pointermove: sin
 *    setState, sin rAF y sin transition, así que va pegada al dedo sin un
 *    fotograma de deuda. La selección de destino sí se lleva la cuenta
 *    completa —con zona muerta y paso de carta— pero NO se pinta: se resuelve
 *    al soltar.
 * 2. AL SOLTAR. Se mide la velocidad (media móvil de VENTANA_VEL_MS) y se
 *    proyecta con deceleración exponencial: un lanzamiento salta varias cartas
 *    y frena, un empujón corto engancha a la de al lado. El destino se redondea
 *    SIEMPRE a una carta del rango, nunca se queda a medias.
 * 3. LA LLEGADA. Duración proporcional al recorrido (T_CIERRE_MIN..MAX) con
 *    muelle suave: la que sale se va por donde iba el dedo y la que entra llega
 *    del lado contrario y se cuadra con un "clac". Nunca hay tres cartas en
 *    pantalla: el fundido se come a la que sale antes de que acabe de irse.
 *
 * Las tres comparten el mismo reloj: el will-change vive exactamente lo que
 * dura la llegada (duración + margen) y se limpia.
 *
 * ---------------------------------------------------------------------------
 * EL ESTADO FÍSICO DE LA COPIA.
 *
 * Una copia que salió machacada del sobre se ve machacada AQUÍ, en la apertura,
 * y no sólo al graduarla. Lo pinta DesperfectosCarta sobre la ilustración; el
 * descentrado lo aplica el marco de la ranura moviendo la imagen dentro de él.
 * Lo importante es de dónde sale el dato: viene YA CALCULADO del servidor y
 * sólo en las copias que de verdad se ven mal. Aquí no se deriva nada — el
 * porqué está entero sobre `estadoDeCopia`, unas líneas más abajo, y es una
 * regla de economía, no de estilo.
 */

/* ------------------------------------------------------------------ */
/* GEOMETRÍA — sólo hay dos poses: la de delante y la de fuera.        */
/* ------------------------------------------------------------------ */

/**
 * Apartado de las que no se ven, en anchos de carta. Es el número del
 * invariante de arriba: deja la carta ENTERA fuera de la pantalla en el caso
 * peor (W = 0.82·vw, borde del viewport a 0.61·W del centro).
 *
 * Con el giro de GIRO_SALIDA grados la caja envolvente ensancha, así que la
 * media anchura no es 0.5·W sino (W/2)·cos g + (h/2)·sen g = 0.524·W (h = 1.4·W,
 * la proporción 2.5/3.5). El canto más cercano cae entonces en
 * 1.2 − 0.524 = 0.676·W: 0.066·W (unos 20px) por fuera del recorte del diálogo.
 * Por debajo de 1.135 empezaría a asomar.
 */
const F_SALIDA = 1.2;
/**
 * Vuelco de papel de la que entra y de la que sale, en grados. Es carácter, no
 * información: 2° se leen como una carta que se echa a un lado, y al ser un
 * giro puro (sin escala) no toca la nitidez.
 */
const GIRO_SALIDA = 2;

/* ---------------------------- GESTO ------------------------------- */
/** Un roce no mueve la selección. */
const F_ZONA_MUERTA = 0.075;
/** Arrastre que vale una carta. */
const F_PASO = 0.3;
/* El cruce de decisión cae en ZONA_MUERTA + PASO/2 = 0.225·W = 69px con
   W=307,5, contra los 70px del threshold de siempre: la memoria muscular
   del deslizamiento de toda la vida da exactamente el mismo resultado. */

/**
 * SEGUIMIENTO. Lo que se aparta del centro la carta que estás mirando, como
 * función de lo que ha viajado el dedo: g(e) = MAX·e/(e + MAX/K), con
 * g'(0) = K y g(∞) = MAX.
 *
 * Es una goma, y va aquí y no en los topes del mazo por una razón: al no
 * enseñarse el resto de cartas, mover la que ves es el ÚNICO acuse de recibo
 * que tiene el gesto. Con K = 0.7 arranca casi pegada al dedo (se nota desde
 * el primer píxel) y con MAX = 0.26·W nunca llega a destapar medio hueco: en
 * el punto de decisión (69px de dedo) la carta se ha ido 30px, un 10% de su
 * ancho, que es exactamente lo que hace falta para saber que ahí hay un gesto.
 * Y como nunca alcanza el máximo, el mazo siempre responde algo: no hay tope
 * duro que dé la sensación de que la pantalla se ha colgado.
 */
const SIGUE_MAX_F = 0.26;
const SIGUE_K = 0.7;

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

/* ------------------------- LLEGADA / CIERRE ----------------------- */
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
 *
 * El peor caso, 420ms, sigue por debajo de los 550ms de GUARDA_CIERRE
 * (app/page.tsx): la carta SIEMPRE termina de asentarse antes de que se acepte
 * el toque que guarda el sobre.
 */
const T_CIERRE_MIN = 180;
const T_CIERRE_MAX = 420;
/** Recorrido, en cartas, que satura la duración. */
const D_REF_CIERRE = 3;
/**
 * MUELLE de papel. Medido: sobrepasa el 4,1% del recorrido a la mitad del
 * tiempo y dedica la otra mitad a asentarse. Es el "clac" de la carta al
 * cuadrarse, no una goma: un muelle de verdad (overshoot del 15-20%) parece
 * gelatina.
 *
 * Sólo va en el transform. En la opacidad, un sobrepaso se saldría de [0,1], y
 * el recorte se ve como un parpadeo: allí manda una rampa lineal.
 */
const CURVA_MUELLE = "cubic-bezier(.2,1.35,.3,1)";
/**
 * Fracción de la duración que dura el fundido. Corto a propósito: la carta que
 * sale se apaga en la primera mitad del viaje y termina de irse ya invisible,
 * así que nunca se ven dos cartas a la vez con entidad. Es lo que hace que
 * salgan DE UNA EN UNA también en pantallas anchas, donde el apartado de
 * F_SALIDA·W no basta para sacarlas del campo de visión.
 */
const F_FUNDIDO = 0.55;
/** Margen tras el último fotograma antes de despromocionar las capas. */
const T_LIMPIEZA_MS = 80;

/** Resistencia asintótica del seguimiento, en px: nunca llega al máximo. */
const seguir = (dxPx: number, W: number) => {
  const e = Math.abs(dxPx);
  const max = SIGUE_MAX_F * W;
  return Math.sign(dxPx) * ((max * e) / (e + max / SIGUE_K));
};

/** Duración del cierre para un recorrido dado, en cartas. */
const duracionCierre = (recorrido: number) =>
  Math.round(
    T_CIERRE_MIN +
      (T_CIERRE_MAX - T_CIERRE_MIN) * Math.min(1, Math.abs(recorrido) / D_REF_CIERRE),
  );

/* ------------------------------------------------------------------ */
/* ESTADO FÍSICO DE LA COPIA                                           */
/* ------------------------------------------------------------------ */

/** Lo que hace falta para pintar el desgaste de UNA copia. */
type EstadoCopia = { desperfectos: Desperfectos; marcas: MarcasDeCarta };

/**
 * El estado de una copia, Y SÓLO SI EL SERVIDOR LO HA MANDADO.
 *
 * AQUÍ NO SE DERIVA NADA: ni de la semilla, ni de la rareza, ni de la nota. El
 * desgaste está construido para ser coherente con la nota de graduación, así
 * que enseñarlo entero la DELATA — medido sobre 60.000 copias, una carta sin un
 * solo pique era SIEMPRE un 10, y quien lo supiera graduaría sólo ésas y se
 * llevaría el ×3 garantizado, convirtiendo la graduación en beneficio seguro.
 * Por eso el filtro vive en el servidor (app/action.ts, conEstadoFisico: de
 * nota 7 en adelante no viaja nada) y el cliente se limita a pintar lo que le
 * llega. LA AUSENCIA DEL DATO SIGNIFICA "SE VE LIMPIA", nunca "no se sabe": en
 * cuanto esta función llamara a `desperfectosDeCopia` o a `notaDeCopia`, el
 * agujero quedaría reabierto.
 *
 * Los dos campos llegan tipados como `unknown` (utils/tipos.ts) a propósito: la
 * misma carta puede venir del servidor, de un JSON del repositorio o del
 * localStorage de un invitado. Se comprueba la forma mínima que va a leerse
 * para que un dato viejo o a medias no reviente la apertura, que es el momento
 * de la app en el que menos se puede permitir una excepción.
 *
 * Devuelve null también cuando el estado no tiene NADA que enseñar: si no se
 * puede nombrar un defecto tampoco se puede rotular la carta como dañada, y un
 * rótulo sin marcas debajo se lee como un fallo de pintado.
 */

/**
 * El desgaste en palabras, para quien no puede verlo.
 *
 * DICE QUÉ HAY Y NUNCA CUÁNTO, y esa parte no es cosmética. `firmaVisible`
 * (utils/graduacion.ts) define qué puede distinguir el jugador de una copia sin
 * graduarla, y el invariante "ningún estado visible delata una nota" de
 * scripts/test-invariantes.mjs agrupa las copias POR ESA DESCRIPCIÓN para
 * exigir que ningún grupo compense graduarlo. Allí los recuentos van por tramos
 * ("pocos", "varios", "muchos") porque nadie cuenta diecisiete piques de un
 * vistazo; escribir aquí "6 piques" enseñaría más detalle del que el invariante
 * protege y lo dejaría comprobando algo que ya no es cierto. Nombrar las clases
 * de defecto es estrictamente MÁS GRUESO que un tramo: sólo separa "hay piques"
 * de "no hay", que es exactamente lo que ya se ve en la ilustración.
 *
 * El umbral del descentrado es el mismo 1,5 % que usa `firmaVisible` para
 * decidir si una copia está "torcida", por la misma razón: los dos tienen que
 * describir lo mismo o el invariante deja de proteger lo que cree proteger.
 */

type Pose = { x: number; g: number; o: number };

/**
 * Pose de la ranura j con la carta p delante. Sólo hay dos: la de p (centrada,
 * entera y sin transform) y la del resto (fuera de la pantalla y a opacidad 0,
 * a un lado o al otro según ya se hayan pasado o estén por ver).
 *
 * p es SIEMPRE un entero. El arrastre ya no mueve la selección a medias, así
 * que no existen poses intermedias que calcular: el paso de una carta a otra lo
 * interpola la transición CSS, propiedad a propiedad.
 */
function pose(j: number, p: number, W: number): Pose {
  if (j === p) return { x: 0, g: 0, o: 1 };
  const lado = j > p ? 1 : -1;
  return { x: lado * F_SALIDA * W, g: lado * GIRO_SALIDA, o: 0 };
}

/**
 * La carta de delante en reposo se queda SIN transform: sin capa, sin escala y
 * sin contexto de apilado propio, que es la condición exacta que PokemonCard
 * necesita para pintarse a la densidad de la pantalla.
 */
function escribirTransform(el: HTMLElement, x: number, g: number) {
  el.style.transform =
    x === 0 && g === 0
      ? ""
      : `translate3d(${x.toFixed(2)}px, 0, 0) rotate(${g.toFixed(2)}deg)`;
}

interface MazoCartasProps {
  cartas: any[];
  indice: number;
  /** Cartas ya destapadas: la selección nunca puede pasar de aquí. */
  maxRevealed: number;
  /** La primera carta del sobre: el MARCO hace la coreografía de emergencia. */
  emerge: boolean;
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
  efectosApagados,
  habilitado,
  zonaRef,
  gestoRef,
  onSeleccionar,
}: MazoCartasProps) {
  const haptic = useHaptics();
  const marcoRef = useRef<HTMLDivElement>(null);
  const ranurasRef = useRef<(HTMLDivElement | null)[]>([]);
  /** Región viva que dicta el estado de la copia que se está mirando. */
  /** Ancho de la carta frontal: se lee una vez por gesto, nunca por fotograma. */
  const anchoRef = useRef(0);
  /** Selección continua bajo el dedo. Se lleva la cuenta pero NO se pinta: sólo
   *  decide dónde se aterriza al soltar. */
  const pRef = useRef(indice);
  /** Carta que está delante: la única visible y la única que mueve el arrastre. */
  const focoRef = useRef(-1);
  /** Deslizamiento confirmado por el hook: -1 izquierda, +1 derecha, 0 nada. */
  const flingRef = useRef(0);
  /** Hay un arrastre en curso al que aún no le ha llegado su onEnd. */
  const gestoVivoRef = useRef(false);
  const limpiezaRef = useRef(0);
  const montadoRef = useRef(false);
  /** Muestras (t, dx) del arrastre para medir la velocidad al soltar. */
  const muestrasRef = useRef<{ t: number; dx: number }[]>([]);
  /** Último desplazamiento visto: onEnd no recibe ninguno. */
  const dxRef = useRef(0);
  /** Píxeles que la carta visible está apartada del centro por el arrastre. */
  const arrastreRef = useRef(0);
  /** El gesto ya ha colocado el mazo (transiciones apagadas) en este arrastre. */
  const arrastrandoRef = useRef(false);
  /** Detente háptico: última carta bajo la que ha cruzado el dedo. */
  const detenteRef = useRef(-1);
  /**
   * Destino cuya llegada ya escribió el gesto. El re-render que provoca
   * onSeleccionar dispara el layout effect, y sin esta marca volvería a escribir
   * el mismo destino con la duración por defecto, aplanando la coreografía que
   * el gesto acababa de calcular.
   */
  const cierreRef = useRef(-1);
  /**
   * Instante (performance.now) en el que termina la llegada que está en vuelo,
   * o 0 si no hay ninguna. Lo anotan los tres sitios que escriben una llegada
   * con transición (el relevo por toque o tecla, el soltar del gesto y el
   * abandono) y lo consulta el reajuste por resize: ver `recolocar`.
   */
  const llegadaHastaRef = useRef(0);
  /** Reajuste por resize aplazado hasta que termine la llegada en curso. */
  const recolocarTimerRef = useRef(0);
  /**
   * Última cadena de `transition` escrita en cada ranura. Comparar evita que el
   * motor de estilo reparsee diez declaraciones cada vez que se coloca el mazo.
   */
  const transRef = useRef<string[]>([]);
  /** Índice anterior: da el recorrido del relevo por toque, tecla o botón. */
  const indicePrevRef = useRef(indice);

  const n = cartas.length;
  /** Tope de selección: sólo se avanza UNA carta por gesto, porque maxRevealed
   *  no sube hasta que la carta llega. Hacia atrás no hay tope. */
  const tope = Math.max(0, Math.min(maxRevealed, n - 1));

  /**
   * El estado de las diez, resuelto UNA vez por sobre.
   *
   * Se memoiza contra `cartas` y no contra `indice` porque este componente se
   * vuelve a renderizar en cada cambio de carta —y la apertura es el momento de
   * la app con presupuesto en milisegundos—: sin esto se recorrerían las diez
   * copias en cada paso para sacar siempre exactamente el mismo resultado. Con
   * el sobre entero limpio (lo normal: el estado sólo viaja en ~1 de cada 20
   * copias) el array es de nulls y no se monta un solo nodo de más.
   */
  const estados = useMemo(() => cartas.map((c) => estadoDeCopia(c)), [cartas]);

  const medir = useCallback(() => {
    const w = marcoRef.current?.offsetWidth || zonaRef.current?.offsetWidth || 0;
    if (w > 0) anchoRef.current = w;
    return anchoRef.current;
  }, [zonaRef]);

  /**
   * z-index: sólo se escribe cuando cambia la carta de delante, jamás por
   * fotograma (tocarlo en cada movimiento fuerza recomposición del árbol). En
   * el relevo importa que la que ENTRA vaya por encima de la que sale.
   */
  const escribirZ = useCallback((foco: number) => {
    for (let j = 0; j < ranurasRef.current.length; j++) {
      const el = ranurasRef.current[j];
      if (el) el.style.zIndex = String(j === foco ? 40 : 30 - Math.abs(foco - j));
    }
  }, []);

  /**
   * ÚNICO punto que coloca el mazo entero. React no toca nunca `transform` ni
   * `opacity` aquí, así que sus re-renders (cambio de índice, de variante de
   * imagen…) no pisan el gesto en curso. Es idempotente: escribir dos veces el
   * mismo destino no reinicia nada, porque una transición CSS sólo arranca si
   * el valor calculado cambia.
   */
  const escribirMazo = useCallback(
    (
      p: number,
      opts?: {
        transicion?: number;
        /** Apartado de la carta visible mientras el dedo la lleva, en px. */
        arrastre?: number;
        curva?: string;
      },
    ) => {
      // Sin guarda de W a propósito: si midiera 0 (layout aún sin resolver),
      // las x salen 0 pero las opacidades NO dependen de W, así que el mazo
      // degrada a una pila perfecta con la carta buena delante — nunca a diez
      // cartas superpuestas con la última encima.
      const W = anchoRef.current || medir();
      const ms = efectosApagados ? 0 : (opts?.transicion ?? 0);
      const curva = opts?.curva ?? CURVA_MUELLE;
      const arrastre = opts?.arrastre ?? 0;
      const foco = Math.round(p);
      if (foco !== focoRef.current) {
        focoRef.current = foco;
        escribirZ(foco);
      }
      // El fundido va aparte del viaje y más corto: la que sale se apaga antes
      // de terminar de irse y la que entra ya está entera mientras se cuadra.
      const trans = ms
        ? `transform ${ms}ms ${curva}, opacity ${Math.round(ms * F_FUNDIDO)}ms linear`
        : "none";
      for (let j = 0; j < n; j++) {
        const el = ranurasRef.current[j];
        if (!el) continue;
        const { x, g, o } = pose(j, foco, W);
        if (trans !== transRef.current[j]) {
          transRef.current[j] = trans;
          el.style.transition = trans;
        }
        escribirTransform(el, j === foco ? x + arrastre : x, g);
        el.style.opacity = String(o);
      }
    },
    [efectosApagados, escribirZ, medir, n],
  );

  /**
   * ARRASTRE, fotograma a fotograma. La única ranura que se mueve es la que se
   * ve, así que se escribe UNA declaración por pointermove y no diez: las otras
   * nueve ya están fuera y ahí se quedan.
   */
  const escribirArrastre = useCallback((px: number) => {
    const el = ranurasRef.current[focoRef.current];
    if (el) escribirTransform(el, px, 0);
  }, []);

  /** Anota que hay una llegada de `ms` en vuelo (más el margen de limpieza). */
  const anotarLlegada = useCallback(
    (ms: number) => {
      llegadaHastaRef.current = ms
        ? performance.now() + ms + T_LIMPIEZA_MS
        : 0;
    },
    [],
  );

  /**
   * Reposición: cambio de carta por toque, teclado o botón, y primer pintado.
   * Va en layout effect para que el destino esté escrito antes de pintar.
   */
  useLayoutEffect(() => {
    medir();
    const salto = Math.abs(indice - indicePrevRef.current);
    indicePrevRef.current = indice;
    pRef.current = indice;
    flingRef.current = 0;
    const primera = !montadoRef.current;
    montadoRef.current = true;
    // El gesto ya escribió EXACTAMENTE esta llegada, con su duración: repisarla
    // aquí la aplanaría a mitad de vuelo.
    if (cierreRef.current === indice) return;
    if (primera) {
      // Primer pintado: nada que animar, el mazo nace donde le toca. Durante la
      // emergencia del sobre esto deja a la carta 0 centrada y a las otras nueve
      // fuera y a opacidad 0, que es justo lo que la coreografía necesita.
      escribirMazo(indice, { transicion: 0 });
      return;
    }
    if (salto === 0) return;
    // Relevo por toque, tecla o botón: la misma ley que el gesto. Con salto = 1
    // devuelve los 260ms de siempre.
    const ms = duracionCierre(salto);
    anotarLlegada(efectosApagados ? 0 : ms);
    escribirMazo(indice, { transicion: ms });
    // maxRevealed no entra aquí: las poses no dependen de él (sólo del índice),
    // y reescribir el mazo cuando sube el fondo molestaría a una llegada en
    // curso.
  }, [indice, efectosApagados, escribirMazo, medir, anotarLlegada]);

  /**
   * EL DESGASTE, DICHO. Sin esto, una copia machacada sólo existe para quien la
   * ve: el rótulo de la esquina es una imagen más dentro de la carta.
  /**
   * AQUÍ NO SE DICE NADA DEL DESGASTE, Y ES DELIBERADO.
   *
   * Había una región viva que anunciaba «Estado de la copia: dañada. Se le ven
   * piques en los cantos, arañazos» en cada relevo del mazo, y un rótulo
   * «ESTADO: DAÑADA» sobre la ilustración. Las dos se han quitado porque el
   * dueño del juego lo pidió así, con estas palabras: «cuando una carta este
   * dañada no quiero que se me informe de ninguna manera solo cuando este
   * graduada».
   *
   * SE LE PREGUNTÓ SI ERAN SÓLO LOS RÓTULOS O TAMBIÉN LAS MARCAS PINTADAS, y
   * eligió expresamente: sólo los rótulos. Por eso las marcas siguen
   * pintándose aquí abajo, con DesperfectosCarta, exactamente igual que antes.
   * Se ve el desgaste; no se nombra.
   *
   * LA CONSECUENCIA DE ACCESIBILIDAD ESTÁ ACEPTADA: las marcas quedan como
   * decoración pura y quien navega con lector de pantalla no se entera de que
   * la copia está dañada. Eso NO es un descuido que haya que arreglar
   * reponiendo un aria-label, un title o una región viva: sería deshacer lo
   * que se pidió. Lo mismo está escrito en components/CardDetailModal.tsx y en
   * components/vitrina/FundaCarta.tsx, que tenían las otras cuatro salidas del
   * mismo dato.
   *
   * DÓNDE SÍ SE DICE: en la vitrina de graduadas, que es lo que el dueño pidió
   * con «solo cuando este graduada». Allí la nota está pagada y enseñada, así
   * que describir el desgaste no adelanta nada.
   */

  /**
   * La barra dinámica de Safari mueve --app-height y con ella CARD_WIDTH: sin
   * releer W las cartas apartadas se quedan mal apartadas hasta el siguiente
   * gesto (y en el caso peor asomaría un canto, que es justo lo que no puede
   * pasar).
   *
   * PERO NUNCA A MITAD DE UNA LLEGADA. Este reajuste escribe el mazo con
   * transición 0, y Safari colapsa la barra justo cuando el dedo se mueve: si
   * el resize cae dentro de los 180-420 ms de una llegada, la carta en vuelo
   * saltaba en seco a su destino. Así que mientras haya una llegada en curso
   * (`llegadaHastaRef`) el reajuste se APLAZA a su final, no se descarta: el
   * ancho nuevo se aplica igual, sólo que cuando ya no hay nada volando.
   *
   * Y se coloca lo que está PINTADO (`focoRef`), con el apartado del arrastre
   * si lo hay: durante un arrastre la selección continua (`pRef`) puede haber
   * cruzado a la siguiente carta sin que se pinte, y recolocar sobre ella
   * cambiaba la carta bajo el dedo.
   */
  useEffect(() => {
    const recolocar = () => {
      window.clearTimeout(recolocarTimerRef.current);
      const falta = llegadaHastaRef.current - performance.now();
      if (falta > 0) {
        recolocarTimerRef.current = window.setTimeout(recolocar, falta);
        return;
      }
      anchoRef.current = 0;
      medir();
      const pintada = focoRef.current >= 0 ? focoRef.current : pRef.current;
      escribirMazo(pintada, { transicion: 0, arrastre: arrastreRef.current });
    };
    window.addEventListener("resize", recolocar);
    window.addEventListener("orientationchange", recolocar);
    return () => {
      window.removeEventListener("resize", recolocar);
      window.removeEventListener("orientationchange", recolocar);
      window.clearTimeout(limpiezaRef.current);
      window.clearTimeout(recolocarTimerRef.current);
    };
  }, [escribirMazo, medir]);

  /**
   * will-change SÓLO en las ranuras que se van a mover y SÓLO mientras se
   * mueven. Aquí ninguna pose lleva escala, así que promocionar no puede
   * emborronar nada: la capa se rasteriza al tamaño con el que se va a pintar.
   */
  const promocionar = (js: number[]) => {
    for (const j of js) {
      const el = ranurasRef.current[j];
      if (el) el.style.willChange = "transform, opacity";
    }
  };
  const despromocionar = () => {
    for (let j = 0; j < ranurasRef.current.length; j++) {
      const el = ranurasRef.current[j];
      if (el) el.style.willChange = "";
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
  // En useCallback —y `anotarMuestra`, abajo, igual— por el linter, no por
  // rendimiento: las reglas del compilador de React tratan una función creada
  // en el render como si pudiera EJECUTARSE en el render, y performance.now()
  // ahí es "impuro". Sólo las llaman onMove y onEnd, que son manejadores.
  const medirVelocidad = useCallback(() => {
    const m = muestrasRef.current;
    const ahora = performance.now();
    while (m.length && ahora - m[0].t > VENTANA_VEL_MS) m.shift();
    m.push({ t: ahora, dx: dxRef.current });
    const a = m[0];
    const b = m[m.length - 1];
    const dt = b.t - a.t;
    return dt > 0 ? (b.dx - a.dx) / dt : 0;
  }, []);

  /**
   * Ventana deslizante de velocidad. Se poda ANTES de meter la nueva muestra
   * para que la ventana sea siempre la de los últimos ms reales.
   */
  const anotarMuestra = useCallback((dx: number) => {
    const ahora = performance.now();
    const m = muestrasRef.current;
    while (m.length && ahora - m[0].t > VENTANA_VEL_MS) m.shift();
    m.push({ t: ahora, dx });
    dxRef.current = dx;
  }, []);

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

  /**
   * Recorrido de la llegada, en cartas: el trecho que de verdad va a viajar el
   * mazo MÁS lo que la carta visible tiene que volver del arrastre.
   *
   * `desde` es la carta PINTADA, no la seleccionada. Con el abanico el mazo se
   * movía bajo el dedo y las dos coincidían; ahora el arrastre no mueve la
   * selección a la vista —sólo aparta la carta de delante— así que el mazo
   * sigue pintado en `indice` hasta que se suelta. Medir desde la selección
   * daba 0 cuando el dedo ya había cruzado a la siguiente y la llegada de una
   * carta entera se despachaba en 189ms en vez de los 260 de siempre.
   *
   * El segundo término está en anchos de salida (F_SALIDA·W) porque ésa es la
   * distancia que recorre una carta al cambiar: así las dos partes se suman en
   * la misma unidad. Sin él, soltar tras un arrastre largo sin cambiar de carta
   * cerraría en el mínimo seco.
   */
  const recorridoCierre = (desde: number, hasta: number, W: number) =>
    Math.abs(desde - hasta) +
    (W ? Math.abs(arrastreRef.current) / (F_SALIDA * W) : 0);

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
      detenteRef.current = indice;
      muestrasRef.current.length = 0;
      dxRef.current = 0;
      arrastreRef.current = 0;
      arrastrandoRef.current = false;
      cierreRef.current = -1;
      window.clearTimeout(limpiezaRef.current);
      // useSwipe promociona la ZONA aunque follow sea false, y la zona es
      // ancestro de las diez ranuras: dejarlo rasterizaría el subárbol entero.
      if (zonaRef.current) zonaRef.current.style.willChange = "";
      // Se promociona sólo la que se va a mover, que es la que se ve.
      if (W) promocionar([indice]);
    },
    // Nada de setState aquí: el arrastre se pinta escribiendo el transform desde
    // el propio pointermove. Ni React, ni rAF, ni un fotograma de retraso.
    onMove: (dx) => {
      const W = anchoRef.current;
      if (!W) return;
      anotarMuestra(dx);

      // SELECCIÓN: se lleva la cuenta completa (zona muerta, paso de carta y
      // recorte al rango) pero no se pinta. Nadie ve las otras cartas mientras
      // el dedo está abajo; lo único que hace esta cuenta es decidir dónde se
      // aterriza y marcar los detentes.
      const adx = Math.abs(dx);
      const avance = Math.max(0, adx - F_ZONA_MUERTA * W) / (F_PASO * W);
      const p = Math.max(0, Math.min(tope, indice - Math.sign(dx) * avance));
      pRef.current = p;

      // MOVIMIENTO: sólo la carta que se ve, y con resistencia creciente.
      const px = seguir(dx, W);
      arrastreRef.current = px;
      if (!arrastrandoRef.current) {
        // Primer movimiento del gesto: coloca el mazo y apaga las transiciones
        // de las diez de una vez. A partir de aquí ya sólo se toca una.
        arrastrandoRef.current = true;
        escribirMazo(indice, { transicion: 0, arrastre: px });
      } else {
        escribirArrastre(px);
      }

      // DETENTE: el mismo idioma que las muescas del rasgado. Con una sola
      // carta a la vista es el único aviso de que se ha cruzado a la siguiente,
      // así que aquí importa más que cuando se veía el mazo abierto.
      const cruce = Math.round(p);
      if (cruce !== detenteRef.current) {
        detenteRef.current = cruce;
        if (!efectosApagados) haptic("tap");
      }
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
      // INERCIA: dónde habría acabado la selección si siguiera rodando y frenando.
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
      arrastrandoRef.current = false;
      pRef.current = destino;
      // Lo que de verdad recorre el mazo: el trecho desde la carta que está
      // PINTADA (indice, porque el arrastre no mueve la selección a la vista)
      // hasta la destino, más lo que la que estás viendo tiene que volver del
      // arrastre. Con un cambio de una carta da los 260ms de siempre, exactamente
      // los mismos que el relevo por toque, tecla o botón.
      const ms = duracionCierre(recorridoCierre(indice, destino, W));
      // La que entra se mueve tanto como la que sale: se promociona ahora, que
      // es justo cuando empieza a hacerlo. Ninguna de las dos crece, así que no
      // hay que despromocionar a nadie antes de escribirle la transición.
      promocionar([indice, destino]);
      cierreRef.current = destino;
      anotarLlegada(efectosApagados ? 0 : ms);
      escribirMazo(destino, { transicion: ms });
      if (destino !== indice) onSeleccionar(destino);
      arrastreRef.current = 0;
      muestrasRef.current.length = 0;
      // Las capas viven exactamente lo que dura la llegada. Un will-change que
      // sobreviva al gesto deja la textura rasterizada y desenfoca la carta.
      // NUNCA se cierra el sobre desde aquí: el arrastre es el gesto de pasar
      // cartas y el cierre vive en el toque, el botón "Guardar sobre", Enter y
      // Espacio.
      window.clearTimeout(limpiezaRef.current);
      limpiezaRef.current = window.setTimeout(
        () => {
          despromocionar();
          cierreRef.current = -1;
        },
        efectosApagados ? 0 : ms + T_LIMPIEZA_MS,
      );
    },
    // El hook abandona el gesto sin soltarlo cuando baja un segundo dedo (es
    // un pellizco) y avisa por aquí: se deja el mazo en reposo por el mismo
    // camino que el cierre de seguridad de abajo.
    onCancel: () => abortarRef.current(),
  });

  /**
   * GESTO ABANDONADO: la carta vuelve a su sitio sin velocidad ni destino.
   *
   * Sin velocidad que valga: esto no es soltar, es un gesto abortado. Se vuelve
   * a donde se estaba, con la ley de siempre para que la carta no dé un tirón
   * raro. El mazo sigue pintado en `indice`: lo único que tiene que deshacerse
   * es el apartado del arrastre. Medir desde pRef daría el recorrido de una
   * carta que nunca llegó a moverse, y la carta volvería a cámara lenta desde
   * 40px.
   *
   * Lo llaman dos sitios y por eso vive en un ref que se renueva tras cada
   * render: el `onCancel` del hook (que lee sus opciones al vuelo) y el cierre
   * de seguridad de abajo, cuyos escuchas no pueden depender de una función
   * recreada en cada render sin resuscribirse en cada uno. El ref se escribe
   * en un layout effect y NO en el cuerpo del render: escribir un ref durante
   * el render es lo que React prohíbe (y lo que marca el linter), y el layout
   * effect corre antes de que pueda llegar ningún pointerup.
   */
  const abortarGesto = () => {
    if (!gestoVivoRef.current) return;
    gestoVivoRef.current = false;
    flingRef.current = 0;
    arrastrandoRef.current = false;
    const ms = duracionCierre(
      recorridoCierre(indice, indice, anchoRef.current),
    );
    pRef.current = indice;
    arrastreRef.current = 0;
    muestrasRef.current.length = 0;
    cierreRef.current = indice;
    anotarLlegada(efectosApagados ? 0 : ms);
    escribirMazo(indice, { transicion: ms });
    window.clearTimeout(limpiezaRef.current);
    limpiezaRef.current = window.setTimeout(
      () => {
        despromocionar();
        cierreRef.current = -1;
      },
      efectosApagados ? 0 : ms + T_LIMPIEZA_MS,
    );
  };
  const abortarRef = useRef(abortarGesto);
  useLayoutEffect(() => {
    abortarRef.current = abortarGesto;
  });

  /**
   * CIERRE DE SEGURIDAD. El hook ya avisa por `onCancel` de los dos abandonos
   * que conoce (segundo dedo, eje ajeno), pero hay un tercero que no puede
   * avisar: que `enabled` pase a false a mitad de gesto y el hook se
   * resuscriba sin pointerup. Este escucha lo cubre. Se comprueba en un
   * temporizador a 0 para que el onEnd normal —que es síncrono— gane siempre,
   * sea cual sea el orden en que se registraron los escuchas; y si onCancel ya
   * pasó por aquí, `gestoVivoRef` está a false y no hace nada.
   */
  useEffect(() => {
    const revisar = () => {
      window.setTimeout(() => abortarRef.current(), 0);
    };
    window.addEventListener("pointerup", revisar);
    window.addEventListener("pointercancel", revisar);
    return () => {
      window.removeEventListener("pointerup", revisar);
      window.removeEventListener("pointercancel", revisar);
    };
  }, []);

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
      //
      // Y SIN SCALE, como dice la cabecera de este fichero: había un
      // [0.97, 0.99, 1] sobre el marco de las diez ranuras, 700 ms de escala
      // sobre un ancestro de la carta justo mientras se la mira por primera
      // vez.
      //
      // LOS 90px SE QUEDAN aunque el sobre mida ahora lo que la carta (130px
      // más alto que ella en el iPhone, 124 en el PC, centrados los dos en la
      // misma zona). Medido a 375x812: la carta arranca 64px por debajo del
      // borde del sobre, y subir sólo 90 asomaría 26. Pero subir más no cabe:
      // con -90 el borde superior de la carta llega ya 16px por encima de la
      // zona central —justo el relleno inferior de la cabecera—, y con los
      // -156 que harían falta para asomar 90 la carta cubriría la cabecera
      // entera y el contador durante 300 ms. Lo que hace que asome es que el
      // SOBRE BAJA mientras la carta sube: sobre-cuerpo-cae, en
      // components/BoosterPack.tsx, desciende 60px entre 500 y 808 ms, así
      // que en la cima de la subida (805 ms) la carta asoma 86px en el iPhone
      // y 88 en el PC, lo mismo que asomaba antes. Los dos relojes van a la
      // par: si tocas la duración o los `times` de aquí, mira aquel keyframe.
      initial={emerge && !efectosApagados ? { y: 0 } : false}
      animate={emerge && !efectosApagados ? { y: [0, -90, 0] } : { y: 0 }}
      transition={
        emerge && !efectosApagados
          ? { duration: 0.7, times: [0, 0.55, 1], ease: ["easeOut", "easeInOut"] }
          : { duration: 0 }
      }
      className="relative w-full aspect-[2.5/3.5]"
    >
      {/* AVISO DE ESTADO. Va fuera de las ranuras (ver el efecto que lo
          escribe) y nace vacío: su contenido lo pone el efecto, que es lo que
          hace que la región viva de verdad anuncie algo. */}

      {cartas.map((carta, j) => {
        // En una constante y no leído tres veces del array: así el compilador
        // estrecha el tipo una sola vez y el JSX de abajo no necesita repetir
        // que no es null.
        const estado = estados[j];
        return (
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
            // Las ranuras son decoración: quien escucha toques y arrastres es la
            // ZONA, que es su padre y cubre exactamente la carta. Sin esto, las
            // nueve apartadas —que ahora se van más de un ancho de carta hacia
            // los lados y siguen siendo elementos vivos aunque estén a opacidad
            // 0— se comerían los toques de lo que haya a ambos lados en las
            // pantallas donde sobra sitio.
            pointerEvents: "none",
            // Sombra de la carta. box-shadow y NUNCA drop-shadow: un filter aquí
            // rasteriza el subárbol y la carta sale blanda.
            boxShadow:
              "6px 0 10px -6px rgba(0,0,0,.45), 0 6px 14px -10px rgba(0,0,0,.5)",
            borderRadius: "4.5%",
          }}
        >
          {/* Todas van de cara, también las que aún no has pasado: la que está
              fuera de pantalla es la siguiente en entrar y un dorso que se
              voltea a mitad de viaje se ve como un parpadeo. No destripa nada:
              fuera del viewport y a opacidad 0 no se ve absolutamente nada de
              ellas hasta que les toca.
              Grande sólo la frontal y sus dos vecinas: tener ya decodificada la
              imagen de la que entra es la mitad de la fluidez del relevo; al
              resto la variante pequeña le sobra. */}
          {estado ? (
            /* COPIA EN MAL ESTADO. Dos envoltorios y no uno, igual que en
               components/graduacion/CartaConDesperfectos.tsx: el descentrado de
               una carta mal cortada no se pinta, se MUEVE la ilustración dentro
               de su marco y se deja que el marco recorte. Por el lado del que
               se retira asoma el fondo, que por eso es el color del cartón.
               El marco es además el `relative` + `overflow-hidden` que exige
               DesperfectosCarta, así que sirve para las dos cosas.

               El desplazamiento es `translate` y JAMÁS `scale`: WebKit rasteriza
               a escala fija la capa de todo lo que lleve scale, filter,
               drop-shadow, backdrop-filter o mix-blend-mode, y la ilustración
               sale borrosa en un iPhone (cabecera de este fichero, punto 3).

               Se monta desde el primer fotograma y no cuando la carta entra:
               montar y desmontar nodos en el relevo es exactamente lo que este
               componente lleva diez ranuras evitando. */
            <div
              className="relative w-full overflow-hidden rounded-[4.5%]"
              style={{ background: "var(--surface-2)" }}
            >
              <div style={estiloDescentrado(estado.desperfectos)}>
                <PokemonCard
                  card={carta}
                  reveal
                  interactive={false}
                  useHighRes={Math.abs(j - indice) <= 1}
                />
              </div>
              <DesperfectosCarta
                desperfectos={estado.desperfectos}
                marcas={estado.marcas}
              />
            </div>
          ) : (
            <PokemonCard
              card={carta}
              reveal
              interactive={false}
              useHighRes={Math.abs(j - indice) <= 1}
            />
          )}

          {/* Aquí iba el rótulo «ESTADO: DAÑADA». Quitado a petición del dueño;
              el porqué entero está arriba, donde estaba la región viva. Las
              marcas de DesperfectosCarta se siguen pintando. */}
        </div>
        );
      })}
    </motion.div>
  );
}
