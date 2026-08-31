"use client";

import { useUser } from "@clerk/nextjs";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import {
  getUserData,
  comprarSobreAction,
  getSetsFromDB,
  getFullCollection,
  claimSetCompletionBonuses,
  sellPackDuplicates,
  getWishlistIds,
} from "./action";
import { getCardsFromSet } from "../services/pokemon";
import {
  openStandardPack,
  openPremiumPack,
  openGoldenPack,
  composicionDelSobre,
  RELLENO_PREMIUM,
} from "../utils/packLogic";
import { saveToCollection, getCollection, saveCollectionRaw } from "../utils/storage";
import {
  SELL_PRICES,
  PACK_PRICES,
  RARITY_RANK,
  precioDeCartaSuelta,
  valorDeVenta,
  COPIAS_PROTEGIDAS,
} from "../utils/constanst";
import { RARITY_GLOW } from "../utils/rarityGlow";
import { useCurrency } from "../hooks/useGameCurrency";
import { useHaptics } from "../hooks/useHaptics";
import { useSound } from "../hooks/useSound";
import { useSwipe, touchActionFor } from "../hooks/useSwipe";
import { leerAjustes, guardarAjustes, suscribirseAjustes } from "../utils/settings";
import { useToast } from "../components/ui/Toast";
import { useImmersive } from "../components/AppShell";
import PokemonCard from "../components/PokemonCard";
import MazoCartas from "../components/MazoCartas";
import BoosterPack, { semillaDeSobre, type FaseSobre } from "../components/BoosterPack";
import { formatNumber } from "../utils/format";
import Portal from "../components/ui/Portal";
import type { Carta, Expansion } from "../utils/tipos";

type PackType = "STANDARD" | "PREMIUM" | "GOLDEN" | "SPECIAL";

/**
 * Ancho de la carta calculado sobre el viewport real (--app-height ya descuenta
 * la barra dinámica de Safari). 56px de cabecera + 96px de pie reservados;
 * 0.714 es 2.5/3.5, la proporción de una carta.
 */
// Los 20px extra son aire: sin ellos la carta ocupaba el 99,96% de la zona
// central y quedaba pegada a la cabecera y al pie.
const CARD_WIDTH =
  "min(82vw, 360px, calc((var(--app-height) - var(--sat) - var(--sab) - 56px - 96px - 20px) * 0.714))";

/** Rareza a partir de la cual la revelación merece aura a pantalla completa. */
const AURA_RANK = 70;

/**
 * Tamaño nominal del sobre. Es sólo el ÚLTIMO respaldo: mientras no se sabe qué
 * expansión se está abriendo (las cartas aún no han cargado), la banda tiene que
 * decir algo y diez es lo que trae un sobre normal.
 *
 * En cuanto hay catálogo manda `cartasPorTipo`, que sale de la calibración real
 * (`composicionDelSobre`): las expansiones a las que se les retira un hueco para
 * que el sobre no valga más de lo que cuesta —hoy swsh35, que se queda en nueve—
 * ya anuncian nueve desde el principio en vez de desmentirse a mitad de apertura.
 */
const CARTAS_POR_SOBRE = 10;

/**
 * Identificador de UN intento de compra. Viaja con la petición y es lo que
 * hace que un reenvío —doble toque, reintento del navegador— no cobre dos
 * veces: el servidor lo anota y el segundo envío recibe el mismo sobre.
 */
const nuevaClaveDeCompra = (): string => {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  // Navegadores viejos y contextos no seguros no traen randomUUID.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}-${Math.random()
    .toString(36)
    .slice(2, 12)}`;
};

/**
 * Fases de la apertura (el tipo vive en components/BoosterPack). Son cuatro y
 * no dos porque la coreografía del rasgado tiene que ser observable:
 * "rasgando" (la tira se desprende), "abriendo" (la carta emerge mientras el
 * sobre aún cae) y "cartas" (el sobre ya no está y se aceptan gestos). Antes
 * todo colgaba del `exit` de AnimatePresence y no había forma de saber en qué
 * punto estaba la apertura.
 *
 * Los valores de abajo y los @keyframes de components/BoosterPack.tsx
 * están calibrados juntos: si cambias uno, mira el otro.
 *
 * Línea de tiempo desde el rasgado (t=0): la tira vuela (0-460), a los 420
 * monta la carta y sube desde detrás del cuerpo del sobre (650ms), a los 620
 * el cuerpo cae (480ms) CRUZÁNDOSE con la carta que sube, a los 950 la
 * primera carta ya está asentada y se celebra, y a los 1150 mandan los
 * gestos y botones.
 */
const T_CARTA = 420; // se monta la carta: la tira ya casi ha salido
const T_FANFARRIA = 950; // la PRIMERA carta ya se asentó: háptico, campanada y fanfarria
const T_FIN = 1150; // el sobre se desmonta y se aceptan gestos y botones
/** Toque con inercia justo tras la llegada de la última carta: cerraría el
 *  sobre sin dejarla ver. Cubre la entrada (260ms) y el arranque de la
 *  campanada, sin frenar a quien va rápido. */
const GUARDA_CIERRE = 550;

/**
 * Rango de una rareza con red de seguridad.
 *
 * packLogic reparte hits por coincidencia de texto ("Rare Holo EX", "LEGEND"…),
 * y esas cadenas no están en RARITY_RANK: saldrían con rango 0 y una carta cara
 * se revelaría igual que una común. Cuando no hay rango se deduce del precio de
 * venta, que sí las cubre.
 */
const rankOf = (rarity?: string): number => {
  if (!rarity) return 0;
  const rank = RARITY_RANK[rarity];
  if (rank) return rank;
  const price = SELL_PRICES[rarity] || 0;
  if (price >= 150) return 90;
  if (price >= 90) return 75;
  if (price >= 50) return 55;
  if (price >= 30) return 40;
  return 0;
};

export default function Home() {
  const { coins, setCoins, spendCoins, addCoins } = useCurrency();
  const { isSignedIn, isLoaded } = useUser();
  const haptic = useHaptics();
  const toast = useToast();

  // Tipados y no `any[]`: son las tres listas de las que cuelga toda la
  // pantalla, y `strict: true` no puede ayudar sobre un `any`. Fue justo un
  // array vacío pasando por donde se esperaba una carta lo que dejó el sobre
  // sellado sin montarse nunca (ver el guard de la VIEW 3).
  const [dbSets, setDbSets] = useState<Expansion[]>([]);
  const [selectedSet, setSelectedSet] = useState<string | null>(null);
  const [allCards, setAllCards] = useState<Carta[]>([]);
  const [userCollectionIds, setUserCollectionIds] = useState<string[]>([]);
  const [currentPackType, setCurrentPackType] = useState<PackType | null>(null);
  const [currentPack, setCurrentPack] = useState<Carta[]>([]);
  const [packIndex, setPackIndex] = useState(0);
  /** Cartas ya destapadas del sobre; no baja al volver a una carta anterior. */
  const [maxRevealed, setMaxRevealed] = useState(0);
  const [isPackOpen, setIsPackOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  /** El set no ha devuelto cartas: la tienda no debe parecer comprable. */
  const [loadError, setLoadError] = useState(false);
  const [setBonus, setSetBonus] = useState<{ granted: number; sets: string[] } | null>(null);
  const [prePackIds, setPrePackIds] = useState<string[]>([]);
  const [soldInfo, setSoldInfo] = useState<{ earned: number; sold: number } | null>(null);
  const [sellingDupes, setSellingDupes] = useState(false);
  /**
   * El sobre no llegó a persistir (fallo de red/BD con sesión, o cuota local en
   * invitado). Con él a true no se ofrece vender repetidas: se venderían contra
   * una colección que aún no incluye el sobre.
   */
  const [packSaveFailed, setPackSaveFailed] = useState(false);
  const [wishlistIds, setWishlistIds] = useState<string[]>([]);
  const [openSeries, setOpenSeries] = useState<Record<string, boolean>>({});
  /**
   * Sentido del último avance: +1 adelante, -1 atrás y 0 "la primera carta sale
   * del sobre". Con el mazo persistente ya no hay entradas ni salidas laterales
   * que orientar, así que su único consumidor es `emerge`: el 0 es lo que le
   * dice al mazo que tiene que hacer la coreografía de emergencia.
   */
  const [direction, setDirection] = useState(1);
  /** Hay una acción de servidor en vuelo (compra o guardado): botones apagados. */
  const [busy, setBusy] = useState(false);
  /**
   * Fase de la apertura: el sobre llega sellado, se rasga, cae, y sólo
   * entonces mandan las cartas. La coreografía es una secuencia explícita de
   * temporizadores (ver rasgarSobre) y no el `exit` de AnimatePresence.
   */
  const [fase, setFase] = useState<FaseSobre>("sellado");
  /**
   * Sentido del rasgado (+1 derecha, -1 izquierda): elige la clase
   * `.sobre__tapa--der|izq`, que es la que lleva el arco de caída de la tira
   * hacia el lado por el que se arrastró.
   */
  const [tearDir, setTearDir] = useState(1);
  /**
   * Sorteo del envoltorio de ESTE sobre (pliegues, reflejos, sombras). Se fija
   * al comprar y no se vuelve a tocar: el sobre no puede cambiar de arrugas a
   * mitad del rasgado.
   */
  const [semillaSobre, setSemillaSobre] = useState(0);
  /**
   * Índice cuya llegada merece fanfarria (destello y confeti). Es estado
   * explícito y no `packIndex === maxRevealed - 1`: con la comparación, ir
   * atrás y volver adelante volvía a disparar el premio de la última carta.
   */
  const [fanfarriaEn, setFanfarriaEn] = useState<number | null>(null);
  /**
   * El usuario ya ha rasgado y el sobre todavía no ha llegado del servidor. En
   * la práctica no se ve nunca (la petición sale con el toque de comprar y el
   * usuario tarda más en agarrar la tira que la red en contestar), pero si la
   * red va mal hay que decir que se está esperando y no dejar el sobre mudo.
   */
  const [esperandoSobre, setEsperandoSobre] = useState(false);
  // Ajustes compartidos (sonido, reducir efectos): el botón de silencio de la
  // cabecera los escribe y esta suscripción los refleja al instante.
  const [ajustes, setAjustes] = useState(() => leerAjustes());
  useEffect(() => suscribirseAjustes(setAjustes), []);
  const finishingRef = useRef(false);
  /**
   * El sobre en pantalla ya está persistido. Se guarda al comprarlo, así que
   * al terminar de revelarlo NO hay que volver a guardarlo: repetir la llamada
   * duplicaría las cartas en la colección.
   */
  const packSavedRef = useRef(false);
  /**
   * El sobre PEDIDO AL SERVIDOR y todavía en vuelo (sólo con sesión: el
   * invitado sigue sorteando en local). Se lanza al comprar y NO se espera
   * allí, para que la vista se abra en el mismo toque; quien lo aguarda es el
   * rasgado, que no puede montar una carta que aún no existe.
   *
   * Se pone a null en cuanto llega, y eso es lo que hace que el caso normal
   * —el sobre aterriza mientras el usuario agarra la tira— rasgue sin un solo
   * tick de espera, igual que cuando el sobre se inventaba en el navegador.
   */
  const sobrePendienteRef = useRef<Promise<boolean> | null>(null);
  /**
   * Las cartas del sobre en curso, legibles fuera del render. finishPack puede
   * ejecutarse con el sobre aún en vuelo (Escape con el sobre sellado) y ahí el
   * `currentPack` de su clausura todavía está vacío.
   */
  const cartasRef = useRef<Carta[]>([]);
  /** Momento de la última llegada de carta, para no encadenarle un toque con
   *  inercia que cerrara el sobre sin dejar ver lo que acaba de salir. */
  const ultimaLlegadaRef = useRef(0);
  /**
   * Cuenta de ventas de repetidas confirmadas. refreshAfterPack lo consulta
   * antes y después de leer el saldo del servidor: si el usuario vendió mientras
   * ese saldo (pre-venta) viajaba, adoptarlo como valor absoluto borraría las
   * monedas de la venta; en ese caso sólo se aplica el bonus como incremento.
   */
  const ventasRef = useRef(0);
  /** Temporizador del toast de bonus de set: sin guardarlo, un segundo set
   *  completado en menos de 6s haría que el primer temporizador borrara su toast. */
  const bonusTimerRef = useRef<number | null>(null);
  /** Temporizadores de la coreografía: salir a mitad tiene que poder anularlos. */
  const temporizadoresRef = useRef<number[]>([]);
  /** Marca de agua de cartas ya vistas: sólo la primera vez se celebra. */
  const vistasRef = useRef(0);
  /** Último índice anunciado. Guarda SÍNCRONA: en desarrollo StrictMode invoca
   *  los efectos dos veces y el sobre sonaba doble. */
  const anunciadoRef = useRef(-1);
  /** Elemento que captura los gestos de la carta durante la apertura. */
  const cardGestureRef = useRef<HTMLDivElement>(null);
  /**
   * Buzón del ref "acabo de arrastrar": el hook de gestos vive ahora en
   * MazoCartas (es él quien mueve las ranuras), pero el onClick de la zona
   * sigue siendo de la página y necesita consultarlo para ignorar el click
   * sintético que el navegador emite tras un arrastre.
   */
  const gestoMazoRef = useRef<React.RefObject<boolean> | null>(null);
  /** Sobre sellado completo (para el atajo de teclado de la vista). */
  const sobreRef = useRef<HTMLDivElement>(null);
  /** Sobre entero: escucha el arrastre de rasgado (ver sobreRef abajo). */
  /** Tira visual: recibe el transform a mano durante el arrastre. */
  const tearStripRef = useRef<HTMLDivElement>(null);
  /** La tira ya se rasgó: evita disparos dobles entre gesto, click y teclado. */
  const tornRef = useRef(false);
  const tearWidthRef = useRef(280);
  /** Sobres abiertos en esta sesión: entra en la semilla del envoltorio para
   *  que dos sobres seguidos del mismo set no salgan clavados. NO lo reinicia
   *  resetPackState a propósito: "otro sobre" trae otro envoltorio. */
  const aperturasRef = useRef(0);
  const tearHapticRef = useRef(0);
  const play = useSound();
  // Menos animación por preferencia del sistema: el aura a pantalla completa es
  // un cambio de luminancia grande y framer no desactiva la opacidad por su
  // cuenta.
  const reduceMotion = useReducedMotion();
  // Adornos pesados (confeti, destellos, tira volando): fuera si lo pide el
  // sistema o el ajuste propio de la app.
  const efectosApagados = !!reduceMotion || ajustes.reducirEfectos;

  /** Temporizador de la coreografía, anotado para poder anularlo. */
  const programar = (fn: () => void, ms: number) => {
    temporizadoresRef.current.push(window.setTimeout(fn, ms));
  };
  const limpiarTemporizadores = () => {
    temporizadoresRef.current.forEach(window.clearTimeout);
    temporizadoresRef.current = [];
  };
  // Salir a mitad de la coreografía (Escape, chevron, desmontaje) no puede
  // dejar un setFase huérfano que abra el sobre SIGUIENTE o marque una carta
  // como vista cuando ya no hay nadie mirando.
  useEffect(() => {
    if (!isPackOpen) limpiarTemporizadores();
    return limpiarTemporizadores;
  }, [isPackOpen]);

  // La apertura ocupa toda la pantalla: escondemos la barra de pestañas.
  useImmersive(isPackOpen);

  // El portal necesita document.body, que no existe en el render del servidor.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Al desmontar la página se cancela el temporizador del toast de bonus para no
  // dejar un setState huérfano en vuelo.
  useEffect(
    () => () => {
      if (bonusTimerRef.current) clearTimeout(bonusTimerRef.current);
    },
    [],
  );

  // La vista de apertura ocupa toda la pantalla: el documento de debajo no debe
  // poder desplazarse, igual que hacen el resto de overlays del proyecto.
  useEffect(() => {
    if (!isPackOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [isPackOpen]);

  const lastIndex = Math.max(0, currentPack.length - 1);
  const currentCard = currentPack[packIndex];
  // Ya no hay volteo: las cartas salen de cara. Lo único que decide si se ven
  // es que la coreografía del sobre haya llegado a su punto.
  //
  // Y que HAYA cartas. La comprobación de longitud parece redundante —el
  // rasgado espera a que llegue el sobre antes de cambiar de fase— pero no lo
  // es: `sobreYaServido` (el camino del reenvío) responde `ok: true` con la
  // lista que devuelva `cartasPorId`, y ésa filtra los ids que ya no estén en
  // `cards`. Si una resiembra se llevó por delante una carta de un sobre
  // recién cobrado, la lista llega VACÍA, el rasgado sigue adelante y 420 ms
  // después el pie se rompe leyendo `currentCard.name` sobre undefined.
  const cartasVisibles = currentPack.length > 0 && (fase === "abriendo" || fase === "cartas");
  const currentRank = rankOf(currentCard?.rarity);
  /** 0 nada · 1 destello · 2 aura · 3 aura y escenario a oscuras.
   *  La guarda es cartasVisibles y no la rareza a secas: sin ella, una Hyper
   *  Rare encendería el aura a pantalla completa DETRÁS del sobre cerrado y
   *  chivaría el premio antes de rasgar. */
  const auraLevel = !cartasVisibles
    ? 0
    : currentRank >= 85
      ? 3
      : currentRank >= AURA_RANK
        ? 2
        : currentRank >= 40
          ? 1
          : 0;
  // El color lo pone la rareza, no la marca: así una Hyper Rare dorada no se
  // siente igual que una Illustration Rare morada.
  const auraColor =
    (currentCard?.rarity && RARITY_GLOW[currentCard.rarity]) ||
    "color-mix(in srgb, var(--accent) 45%, transparent)";
  /** La PRIMERA carta monta con el sobre aún cayendo (fase "abriendo"): el
   *  aura y el escenario esperan a la fanfarria (T_FANFARRIA) para no
   *  encenderse detrás del envoltorio. En el resto de llegadas, al instante.
   *  Es un delay de framer, no un temporizador: cerrar la vista lo desmonta. */
  const retardoAura =
    !efectosApagados && fase !== "cartas" ? (T_FANFARRIA - T_CARTA) / 1000 : 0;

  const currentSetObj = dbSets.find((s) => s.id === selectedSet);

  /**
   * Catálogo del set indexado por id. El sobre llega del servidor con lo justo
   * (id, nombre, rareza e imágenes) porque eso es lo que hay que validar y
   * guardar; la vista de apertura y el resumen enseñan además tipos, ataques y
   * precios, que ya están cargados aquí.
   */
  const catalogoPorId = useMemo(() => {
    const m = new Map<string, Carta>();
    allCards.forEach((c) => m.set(c.id, c));
    return m;
  }, [allCards]);

  /** Cambia las cartas mínimas del servidor por las completas del catálogo. */
  const hidratarCartas = (cartas: Carta[]): Carta[] =>
    (cartas ?? []).map((c) => catalogoPorId.get(c.id) ?? c);

  /** Deseados como Set: el resumen de un ×10 son 100 cartas y un `includes`
   *  contra una lista de cientos es O(n·m) en pleno render. */
  const wishlistSet = useMemo(() => new Set(wishlistIds), [wishlistIds]);

  /* ==================================================================== *
   * LO QUE LA TIENDA ANUNCIA SALE DEL REPARTO, NO DE UNA LISTA A MANO
   * ====================================================================
   *
   * Las probabilidades, el número de cartas y las "raras aseguradas" estaban
   * escritos en el JSX y las tres MENTÍAN:
   *
   *   · "2 Raras aseguradas" en el Premium, que reparte 4 (RELLENO_PREMIUM).
   *   · "Illustration Rare 8%" y "Ultra Rare 4%" en el Estándar. En TODA la era
   *     Espada y Escudo no existe ninguno de los dos escalones, así que
   *     sacarPremio cae al respaldo y ese 12% de sobres da una rara más. El 8%
   *     y el 4% no salían jamás ahí, y encima se rotulaba "oficiales".
   *   · "10 cartas" fijo, cuando la calibración retira huecos en las expansiones
   *     que valdrían más de lo que cuestan (swsh35 se queda en 9).
   *
   * Ahora los tres se derivan de `composicionDelSobre`, que resuelve la tabla
   * de premio contra los pools REALES de esta expansión. Las ramas cuyo escalón
   * no existe se marcan y se pintan diciendo a dónde caen de verdad.
   */
  const composiciones = useMemo(() => {
    if (!allCards || allCards.length === 0) return null;
    return {
      STANDARD: composicionDelSobre(allCards, "STANDARD"),
      PREMIUM: composicionDelSobre(allCards, "PREMIUM"),
      GOLDEN: composicionDelSobre(allCards, "GOLDEN"),
      SPECIAL: composicionDelSobre(allCards, "SPECIAL"),
    };
  }, [allCards]);

  /** Cartas que trae de verdad cada sobre de esta expansión. */
  const cartasPorTipo = useMemo(
    () => ({
      STANDARD: composiciones?.STANDARD.cartas ?? CARTAS_POR_SOBRE,
      PREMIUM: composiciones?.PREMIUM.cartas ?? CARTAS_POR_SOBRE,
      GOLDEN: composiciones?.GOLDEN.cartas ?? CARTAS_POR_SOBRE,
      SPECIAL: composiciones?.SPECIAL.cartas ?? CARTAS_POR_SOBRE,
    }),
    [composiciones],
  );

  /**
   * Cuántas cartas anuncia el sobre EN PANTALLA. Con sesión el contenido llega
   * del servidor con el sobre ya sellado y a la vista, así que hasta que llega
   * hay que decir un número: el de ESTA expansión y ESTE tipo de sobre, ya
   * calibrado. Antes era 10 fijo y la banda se desmentía a mitad de apertura en
   * los sets a los que la calibración les retira un hueco (swsh35 → 9).
   */
  const cartasDelSobre =
    currentPack.length ||
    (currentPackType ? cartasPorTipo[currentPackType] : CARTAS_POR_SOBRE);

  /** Raras garantizadas del Premium, ya calibradas. */
  const rarasPremium =
    composiciones?.PREMIUM.huecos.find((h) => h.pool === "rare")?.cantidad ??
    RELLENO_PREMIUM.raras;

  /**
   * Filas de la tabla desplegable de cada sobre. Un porcentaje sólo se anuncia
   * si su escalón EXISTE en la expansión; si no, se dice a dónde cae, que es
   * más honesto que enseñar una probabilidad inalcanzable.
   */
  const oddsPorTipo = useMemo(() => {
    const filas = (tipo: "STANDARD" | "PREMIUM" | "GOLDEN" | "SPECIAL"): [string, string][] => {
      const comp = composiciones?.[tipo];
      if (!comp) return [];
      const pct = (n: number) => `${Number(n.toFixed(2))}%`;
      // El premio, de mejor a peor (la tabla ya viene en ese orden).
      const premio: [string, string][] = comp.premio.map((r) =>
        r.disponible
          ? [r.etiqueta, pct(r.prob)]
          : [`${r.etiqueta} (no hay)`, `→ ${r.etiquetaReal}`],
      );
      // Los huecos fijos: son la promesa del sobre, no una probabilidad.
      const huecos: [string, string][] = comp.huecos
        .filter((h) => h.pool !== "common" && h.pool !== "uncommon")
        .map((h) =>
          h.disponible
            ? [h.etiqueta, `${h.cantidad}×`]
            : [`${h.etiqueta} (no hay)`, `→ ${h.etiquetaReal}`],
        );
      if (tipo === "GOLDEN" || tipo === "SPECIAL") {
        return [["Carta nueva", "1×"], ...huecos];
      }
      return [...premio, ...huecos];
    };
    return {
      STANDARD: filas("STANDARD"),
      PREMIUM: filas("PREMIUM"),
      GOLDEN: filas("GOLDEN"),
      SPECIAL: filas("SPECIAL"),
    };
  }, [composiciones]);

  /**
   * Un set "abrible" tiene la pirámide normal de rarezas. Los subsets
   * especiales (Trainer Gallery, Shiny Vault, Galarian Gallery, promos) no
   * tienen morralla: TODO lo que cae es carta cara, así que un sobre estándar
   * de 50 se revende por 500-700 — una imprenta de dinero. Medido con 2000
   * sobres simulados por set: Shiny Vault rinde el 1046% del coste y Galarian
   * Gallery el 1357%. El servidor no lo frena: esas cartas son REALES y están
   * en la BD; sólo se cierra la brecha ofreciendo ahí únicamente el Promo Pack.
   *
   * El nombre y el total no bastan (Shiny Vault son 122 cartas y no lleva
   * "gallery"), así que además se mira la COMPOSICIÓN real en cuanto cargan las
   * cartas: sin comunes suficientes, no es un set de sobre estándar.
   */
  const composicionEspecial = useMemo(() => {
    if (!allCards || allCards.length === 0) return false;
    const comunes = allCards.filter((c) => c.rarity === "Common").length;
    const relleno = allCards.filter(
      (c) => c.rarity === "Common" || c.rarity === "Uncommon",
    ).length;
    return comunes < 8 || relleno / allCards.length < 0.2;
  }, [allCards]);

  // OJO AL NOMBRE: con la app en español `name` trae el nombre traducido, y
  // "Promos Escarlata y Púrpura" no contiene "promos" ni "Galería de
  // Entrenadores" contiene "gallery". `nameEn` es el nombre inglés que conserva
  // la capa de idioma justo para esto: qué sobres se venden en una expansión no
  // puede depender del idioma en que se mire. El servidor hace la misma
  // comprobación sobre la tabla `sets`, que nunca se traduce.
  const nombreEnIngles = String(currentSetObj?.nameEn ?? currentSetObj?.name ?? "").toLowerCase();
  const isSpecialSet = currentSetObj
    ? nombreEnIngles.includes("promos") ||
      nombreEnIngles.includes("gallery") ||
      currentSetObj.series === "POP" ||
      currentSetObj.series === "Other" ||
      // El total DECLARADO, no el conteo real: un set a medio sembrar tiene
      // pocas cartas en `cards` y con `cardsCount` aquí se marcaría de especial
      // por error, dejando la expansión sin sobres normales.
      //
      // `> 0 &&` es EXACTAMENTE la condición que aplica el servidor en
      // `sobresPermitidos`. Tiene que ser la misma cadena de comparaciones o
      // esta pantalla pinta botones que el servidor rechaza al pulsarlos: con un
      // `total` nulo, aquí salía false (typeof null es "object") y allí true
      // (Number(null) es 0), así que la tienda ofrecía tres sobres y los tres
      // fallaban.
      (Number(currentSetObj.total) > 0 && Number(currentSetObj.total) < 69) ||
      composicionEspecial
    : false;

  useEffect(() => {
    (async () => {
      try {
        const sets = await getSetsFromDB();
        // Sort by release date desc when available
        sets.sort((a: any, b: any) => {
          const da = a.releaseDate ? new Date(a.releaseDate).getTime() : 0;
          const db = b.releaseDate ? new Date(b.releaseDate).getTime() : 0;
          return db - da;
        });
        setDbSets(sets);
      } catch (err) {
        // getSetsFromDB rechaza ante fallo de red: sin capturarlo la portada se
        // quedaba sin expansiones y sin aviso (rechazo no manejado).
        console.error("Error cargando las expansiones:", err);
        toast("No se pudieron cargar las expansiones. Revisa tu conexión.", "error");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const syncUserData = async () => {
      if (!isLoaded) return;
      try {
        if (isSignedIn) {
          const data = await getUserData();
          if (data) setCoins(data.coins);
          const myCards = await getFullCollection();
          setUserCollectionIds(myCards.map((c: any) => c.id));
          // Un fallo de deseados no puede tumbar el resto de la sincronización.
          getWishlistIds().then(setWishlistIds).catch(() => {});
        } else {
          const localCards = getCollection();
          setUserCollectionIds(localCards.map((c: any) => c.id));
        }
      } catch (err) {
        // Las server actions rechazan ante fallo de red (su try/catch interno
        // sólo cubre errores SQL). Sin capturarlo, el rechazo quedaba sin
        // manejar y colección y saldo se quedaban vacíos EN SILENCIO: el sobre
        // Leyenda "garantizaba" cartas ya poseídas y todo salía marcado "Nueva".
        console.error("Error sincronizando datos de usuario:", err);
        toast("No se pudieron cargar tus datos. Revisa tu conexión.", "error");
      }
    };
    syncUserData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSignedIn, isLoaded, setCoins]);

  const loadAndSync = useCallback(async () => {
    if (!selectedSet) return;
    setLoading(true);
    setLoadError(false);
    try {
      const cards = await getCardsFromSet(selectedSet);
      if (cards && cards.length > 0) {
        setAllCards(cards);
        // AQUÍ YA NO SE SIEMBRA. La siembra la hace el servidor cuando la
        // necesita de verdad (`cartasDelSet`, en app/action.ts, justo antes de
        // sortear el sobre). Dispararla desde aquí costaba un SELECT count(*)
        // por cada cambio de expansión aunque el set ya estuviera sembrado, y
        // obligaba a exportar `syncSetToDatabase` —o sea, a dejar abierto un
        // endpoint POST que inserta ~250 filas y que cualquiera con cuenta
        // podía llamar a voluntad.
      } else {
        // Sin cartas no se puede abrir nada: mejor decirlo aquí que dejar la
        // tienda entera con aspecto de funcionar y fallar al pulsar comprar.
        setLoadError(true);
      }
    } catch (err) {
      console.error(err);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [selectedSet]);

  useEffect(() => {
    loadAndSync();
  }, [loadAndSync]);

  const setsBySeries = useMemo(() => {
    const groups: Record<string, any[]> = {};
    dbSets.forEach((set) => {
      const seriesName = set.series || "Otras";
      if (!groups[seriesName]) groups[seriesName] = [];
      groups[seriesName].push(set);
    });
    return groups;
  }, [dbSets]);

  /**
   * Gestión del foco del diálogo inmersivo. Con el resto de la app inerte
   * (AppShell), el foco tiene que ENTRAR aquí al abrir — si se quedara en el
   * botón de compra, ahora inerte, el teclado y el lector de pantalla se
   * quedarían sin punto de partida — y volver a su sitio al cerrar. Los
   * timeouts dejan pasar el render que monta el portal / retira el inert.
   */
  const prevFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (isPackOpen) {
      prevFocusRef.current = (document.activeElement as HTMLElement) ?? null;
      const t = window.setTimeout(() => {
        (sobreRef.current ?? cardGestureRef.current)?.focus();
      }, 30);
      return () => window.clearTimeout(t);
    }
    const prev = prevFocusRef.current;
    prevFocusRef.current = null;
    if (prev && document.contains(prev)) {
      const t = window.setTimeout(() => prev.focus(), 30);
      return () => window.clearTimeout(t);
    }
  }, [isPackOpen]);

  // Al rasgar, el relevo natural: del sobre a la carta. Se espera a "cartas"
  // porque hasta entonces la zona de gestos no acepta nada.
  useEffect(() => {
    if (isPackOpen && fase === "cartas") cardGestureRef.current?.focus();
  }, [isPackOpen, fase]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isPackOpen) return;
      if (e.repeat) return; // ignora auto-repeat al mantener pulsado
      if (e.code === "Escape") {
        e.preventDefault();
        // Mientras hay un guardado en vuelo, finishPack no entra: la capa se
        // cierra en seco igual que hace el botón de la cabecera, porque aquí no
        // hay barra de pestañas ni gesto de retroceso con los que salir.
        if (finishingRef.current) cerrarVistaSobre();
        else finishPack();
        return;
      }
      if (e.code === "Space" || e.code === "ArrowRight") {
        // Espacio es la tecla de activación de un botón: si el foco está en uno
        // de los controles de la vista, cancelar aquí el keydown lo dejaría
        // muerto. La carta y el sobre sellado se excluyen porque también llevan
        // role="button" y su acción es justamente esta.
        if (e.code === "Space") {
          const btn = (e.target as HTMLElement | null)?.closest?.(
            'button,[role="button"]',
          );
          if (btn && btn !== cardGestureRef.current && btn !== sobreRef.current)
            return;
        }
        e.preventDefault();
        handleNextCard();
      } else if (e.code === "ArrowLeft") {
        e.preventDefault();
        handlePrevCard();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPackOpen, maxRevealed, packIndex, currentPack, isSignedIn, fase]);

  // Precarga de las dos siguientes. La ventana de alta resolución del mazo es
  // ±1, pero la ranura +1 todavía enseña el DORSO (no se destapa hasta que se
  // llega a ella), así que su imagen grande no está pedida: sin este colchón,
  // el primer avance del sobre enseñaría medio segundo de rectángulo vacío.
  // El service worker ya cachea images.pokemontcg.io: no se descarga dos veces.
  useEffect(() => {
    if (!isPackOpen) return;
    for (const salto of [1, 2]) {
      const url = currentPack[packIndex + salto]?.images?.large;
      if (url) new Image().src = url;
    }
  }, [isPackOpen, packIndex, currentPack]);

  const handleSelectSet = (setId: string) => {
    setSelectedSet(setId);
    resetPackState();
  };

  /**
   * Cierra la vista de apertura sin tocar el sobre en sí (el resumen lo sigue
   * necesitando). Lo importante es el `tornRef`: si se sale con el sobre
   * sellado y su contenido AÚN EN VUELO, la espera de rasgarSobre sigue viva y
   * al llegar el sobre desgarraría —sonido, háptico y temporizadores de fase—
   * sobre una vista que ya no está. El rasgado retirado es lo que la para.
   */
  const cerrarVistaSobre = () => {
    tornRef.current = false;
    setEsperandoSobre(false);
    setIsPackOpen(false);
  };

  const resetPackState = () => {
    setCurrentPack([]);
    setPackIndex(0);
    setMaxRevealed(0);
    setIsPackOpen(false);
    setDirection(1);
    // El siguiente sobre vuelve a llegar sellado. Olvidar cualquiera de estas
    // líneas (aquí o en handleBuyPack) hace que el segundo sobre nazca abierto.
    sobrePendienteRef.current = null;
    cartasRef.current = [];
    limpiarTemporizadores();
    setFase("sellado");
    tornRef.current = false;
    vistasRef.current = 0;
    anunciadoRef.current = -1;
    ultimaLlegadaRef.current = 0;
    setFanfarriaEn(null);
    setPackSaveFailed(false);
    setEsperandoSobre(false);
  };

  /**
   * La compra no cuajó con la vista ya abierta. Se cierra el sobre y se dice
   * por qué: no se ha cobrado nada (el servidor sólo cobra si entrega).
   */
  const abortarSobre = (motivo?: string) => {
    sobrePendienteRef.current = null;
    cartasRef.current = [];
    resetPackState();
    toast(
      motivo === "sin-saldo"
        ? "No tienes suficientes monedas"
        : motivo === "sobre-no-disponible"
          ? "Ese sobre no está a la venta en esta expansión"
          : "No se pudo completar la compra",
      "error",
    );
    haptic("warning");
  };

  /**
   * Deja la vista lista para un sobre nuevo, sellado. Es el trozo de
   * handleBuyPack que NO depende de conocer las cartas: con sesión el
   * contenido llega después (lo pide el servidor) y la vista tiene que abrirse
   * en el mismo toque, no cuando conteste la red.
   */
  const abrirSobreSellado = (type: PackType, cartas: Carta[]) => {
    play("moneda");
    setPrePackIds([...userCollectionIds]); // snapshot ANTES del sobre
    setSoldInfo(null);
    setCurrentPackType(type);
    setCurrentPack(cartas);
    setPackIndex(0);
    setMaxRevealed(0);
    // Si el sobre anterior se cerró tras retroceder, direction quedaba en -1 y
    // la primera carta del nuevo entraba por el lado contrario.
    setDirection(1);
    // El sobre entra sellado: hay que rasgar la tira para ver las cartas.
    limpiarTemporizadores();
    setSemillaSobre(semillaDeSobre(selectedSet, aperturasRef.current++));
    setFase("sellado");
    tornRef.current = false;
    vistasRef.current = 0;
    anunciadoRef.current = -1;
    ultimaLlegadaRef.current = 0;
    setFanfarriaEn(null);
    setEsperandoSobre(false);
    setIsPackOpen(true);
  };

  const handleBuyPack = async (type: PackType) => {
    if (finishingRef.current) return;
    if (!allCards || allCards.length === 0) {
      toast("Las cartas no se han cargado. Recarga la página.", "error");
      return;
    }
    // Esto ya NO es la defensa —la pone el servidor, que mide la composición
    // contra la BD— sino cortesía: evita el viaje de ida y vuelta para
    // enseñarle al usuario un error que aquí ya se sabe.
    if (composicionEspecial && type !== "SPECIAL") {
      toast("Esta colección especial sólo tiene Promo Pack", "error");
      return;
    }
    const price = PACK_PRICES[type];
    if (coins < price) {
      haptic("warning");
      toast("No tienes suficientes monedas", "error");
      return;
    }

    // Cierre mientras se prepara la compra: sin él, un doble toque compraba dos
    // sobres. Con sesión, además, la clave de compra hace que un reenvío del
    // mismo sobre no llegue a cobrarse dos veces en el servidor.
    finishingRef.current = true;
    setBusy(true);
    packSavedRef.current = false;
    sobrePendienteRef.current = null;
    cartasRef.current = [];
    setPackSaveFailed(false);

    try {
      if (isSignedIn) {
        /* EL SOBRE SE PIDE, NO SE INVENTA.
         *
         * comprarSobreAction cobra, sortea y guarda en una sola sentencia, así
         * que cuando conteste el sobre YA está pagado y en la colección: no hay
         * nada que reintentar al terminar de revelarlo.
         *
         * Y NO SE ESPERA AQUÍ, que es lo que evita la espera perceptible: la
         * vista se abre en el mismo toque con el sobre sellado y la petición
         * viaja mientras el usuario agarra la tira. Sólo el rasgado la aguarda
         * (ver rasgarSobre), y para entonces lleva medio segundo largo en
         * vuelo: el sobre ya está aquí y la coreografía arranca igual que
         * cuando se sorteaba en el navegador.
         */
        const clave = nuevaClaveDeCompra();
        const pedido: Promise<boolean> = comprarSobreAction(selectedSet!, type, 1, clave)
          .then((res) => {
            // Este sobre ya no es el que está en pantalla (se salió, se cambió
            // de expansión o se compró otro): llegó tarde y no pinta nada. Las
            // cartas están guardadas igual, que para eso se cobraron.
            if (sobrePendienteRef.current !== pedido) return false;
            if (!res?.ok) {
              abortarSobre(res?.motivo);
              return false;
            }
            const cartas = hidratarCartas(res.cartas);
            cartasRef.current = cartas;
            setCurrentPack(cartas);
            // Saldo autoritativo: ya lleva el cobro aplicado en el servidor.
            setCoins(res.coins);
            packSavedRef.current = true;
            // Las dos primeras imágenes, ya: la primera carta se monta 420ms
            // después de rasgar y para entonces tiene que estar en caché.
            for (const card of cartas.slice(0, 2)) {
              const url = card?.images?.large;
              if (url) new Image().src = url;
            }
            // Llegó: a partir de aquí el rasgado no tiene nada que esperar.
            sobrePendienteRef.current = null;
            return true;
          })
          .catch((err) => {
            console.error("Error comprando el sobre:", err);
            // El mismo guard que arriba, y hace falta igual: si se sale con la
            // ✕ estando el sobre sellado y se compra otro, la caída de red de
            // ESTA petición llegaría con otro sobre en pantalla y abortarSobre
            // lo cerraría con un aviso que no es suyo.
            if (sobrePendienteRef.current === pedido) abortarSobre();
            return false;
          });
        sobrePendienteRef.current = pedido;
        abrirSobreSellado(type, []);
        return;
      }

      /* MODO INVITADO: no hay cuenta que defraudar, así que el sobre se sortea
       * y se guarda aquí mismo, en local, exactamente igual que siempre. */
      let newPack: Carta[] = [];
      if (type === "STANDARD") newPack = openStandardPack(allCards);
      else if (type === "PREMIUM") newPack = openPremiumPack(allCards);
      else newPack = openGoldenPack(allCards, userCollectionIds);

      for (const card of newPack.slice(0, 2)) {
        const url = card?.images?.large;
        if (url) new Image().src = url;
      }

      if (!spendCoins(price)) {
        // El saldo del invitado sólo vive en este dispositivo.
        return;
      }
      if (!saveToCollection(newPack)) {
        // Ya cobrado: si el guardado local revienta (cuota de localStorage) se
        // reembolsa el precio para no dejar al invitado sin cartas y sin saldo.
        addCoins(price);
        toast("No se pudo guardar el sobre en este dispositivo", "error");
        haptic("warning");
        return;
      }
      packSavedRef.current = true;
      cartasRef.current = newPack;
      abrirSobreSellado(type, newPack);
    } catch (err) {
      console.error("Error comprando el sobre:", err);
      toast("No se pudo completar la compra", "error");
      haptic("warning");
    } finally {
      finishingRef.current = false;
      setBusy(false);
    }
  };

  /**
   * Puesta al día tras guardar un sobre (sólo con sesión): bonus por set
   * completado y monedas reales del servidor. Las estadísticas y logros viven
   * ahora en Social, así que aquí ya no se piden.
   * Nunca lanza: un fallo aquí no puede tumbar el guardado del sobre.
   */
  const refreshAfterPack = async () => {
    let granted = 0;
    try {
      const res = await claimSetCompletionBonuses();
      if (res.granted > 0) {
        granted = res.granted;
        setSetBonus({ granted: res.granted, sets: res.sets });
        // El id se guarda: completar un segundo set en menos de 6s no debe dejar
        // que el temporizador del primer bonus borre el toast del segundo.
        if (bonusTimerRef.current) clearTimeout(bonusTimerRef.current);
        bonusTimerRef.current = window.setTimeout(() => setSetBonus(null), 6000);
      }
    } catch (err) {
      console.error("Error reclamando bonus de set:", err);
    }
    try {
      // Las monedas se releen del servidor (el bonus y la compra se aplican
      // allí) para que el marcador no quede desincronizado.
      const ventasAntes = ventasRef.current;
      const data = await getUserData();
      if (!data) return;
      if (ventasRef.current === ventasAntes) {
        // Nadie vendió repetidas mientras el saldo viajaba: se adopta el valor
        // autoritativo del servidor (ya incluye el bonus aplicado allí).
        setCoins(data.coins);
      } else if (granted > 0) {
        // Hubo una venta en paralelo cuyo delta ya está en el marcador; este
        // saldo (pre-venta) lo borraría. En vez de pisarlo se aplica sólo el
        // bonus como incremento, que compone bien con el delta de la venta.
        setCoins((c) => c + granted);
      }
    } catch (err) {
      console.error("Error refrescando el saldo:", err);
    }
  };

  // Apertura múltiple (×N): salta animación, guarda todo, va al resumen.
  const handleBuyMulti = async (type: PackType, count = 10) => {
    if (finishingRef.current) return;
    finishingRef.current = true;
    setBusy(true);
    setPackSaveFailed(false);
    sobrePendienteRef.current = null;
    // Todo va en try/finally: antes, un fallo de red dejaba finishingRef en
    // true y los botones de compra bloqueados para el resto de la sesión.
    try {
      if (!allCards || allCards.length === 0) {
        toast("Las cartas no se han cargado. Recarga la página.", "error");
        return;
      }
      // Cortesía, no defensa: el servidor mide la composición contra la BD.
      if (composicionEspecial && type !== "SPECIAL") {
        toast("Esta colección especial sólo tiene Promo Pack", "error");
        return;
      }
      const price = PACK_PRICES[type] * count;
      if (coins < price) {
        haptic("warning");
        toast(`Necesitas ${formatNumber(price)} monedas para ×${count}`, "error");
        return;
      }

      const ownedSnapshot = [...userCollectionIds];
      let combined: Carta[] = [];
      let saved = true;

      if (isSignedIn) {
        // Los `count` sobres se cobran y se acreditan en la MISMA sentencia que
        // los sortea: no hay forma de quedarse con el cobro hecho y las cartas
        // sin dar, ni al revés. Aquí sí se espera —el ×10 va directo al resumen
        // y no hay animación que cubrir— y no se abre nada hasta que conteste.
        const clave = nuevaClaveDeCompra();
        const res = await comprarSobreAction(selectedSet!, type, count, clave);
        if (!res?.ok) {
          toast(
            res?.motivo === "sin-saldo"
              ? "No tienes suficientes monedas"
              : "No se pudieron comprar los sobres",
            "error",
          );
          haptic("warning");
          return;
        }
        combined = hidratarCartas(res.cartas);
        setCoins(res.coins);
        await refreshAfterPack();
      } else {
        /* INVITADO: sorteo y guardado en local, como siempre. */
        const owned = new Set(ownedSnapshot);
        for (let i = 0; i < count; i++) {
          let p: Carta[] = [];
          if (type === "STANDARD") p = openStandardPack(allCards);
          else if (type === "PREMIUM") p = openPremiumPack(allCards);
          else p = openGoldenPack(allCards, Array.from(owned));
          combined.push(...p);
          p.forEach((c) => owned.add(c.id)); // golden garantiza nuevas distintas
        }
        if (!spendCoins(price)) return;
        if (!saveToCollection(combined)) {
          // Si el guardado local revienta (cuota de localStorage) se reembolsa
          // lo cobrado y el resumen queda marcado como no guardado.
          addCoins(price);
          toast("No se pudieron guardar los sobres en este dispositivo", "error");
          saved = false;
        }
      }

      packSavedRef.current = saved;
      cartasRef.current = combined;
      // Con el guardado sin cuajar no se ofrece vender repetidas: se venderían
      // contra una colección que aún no incluye estos sobres.
      setPackSaveFailed(!saved);

      setPrePackIds(ownedSnapshot);
      // Sólo damos por poseídas las cartas si el guardado salió bien.
      if (saved) setUserCollectionIds((prev) => [...prev, ...combined.map((c) => c.id)]);
      setSoldInfo(null);
      setCurrentPackType(type);
      setCurrentPack(combined);
      setIsPackOpen(false); // directo al resumen
      play("moneda");
      haptic("success");
    } catch (err) {
      console.error("Error comprando los sobres:", err);
      toast("No se pudieron comprar los sobres", "error");
      haptic("warning");
    } finally {
      finishingRef.current = false;
      setBusy(false);
    }
  };

  const finishPack = async () => {
    if (finishingRef.current) return;
    finishingRef.current = true;
    setBusy(true);
    try {
      // La vista se cierra antes de tocar la red: el sobre ya está visto y
      // esperar aquí sólo dejaba el pie clavado en "Guardando...".
      cerrarVistaSobre();
      /* AQUÍ YA NO SE GUARDA NADA. El sobre se cobró y se acreditó en la misma
       * sentencia SQL de comprarSobreAction, así que si llegó a haber cartas es
       * que están guardadas; y si no llegaron, no se cobró. Antes esto era un
       * reintento de savePackToCollection y había que hilar fino para no
       * guardar dos veces el mismo sobre.
       *
       * Lo único que puede quedar en vuelo es la compra misma: se sale de la
       * vista con Escape antes de rasgar y sus cartas todavía no han llegado.
       * cartasRef las recoge cuando lleguen (currentPack, en la clausura de
       * esta función, seguiría vacío). */
      await sobrePendienteRef.current;
      const cartasGuardadas = cartasRef.current.length ? cartasRef.current : currentPack;
      if (packSavedRef.current) {
        setUserCollectionIds((prev) => [...prev, ...cartasGuardadas.map((c) => c.id)]);
        setPackSaveFailed(false);
        haptic("success");
      } else {
        // Con el sobre sin guardar no se dan por poseídas sus cartas: si no, la
        // colección enseñaría cartas que no están en la base de datos.
        setPackSaveFailed(true);
        haptic("warning");
      }
    } catch (err) {
      // Una caída de red no puede dejar el sobre a medias: se avisa y se sale
      // igualmente al resumen.
      console.error("Error cerrando el sobre:", err);
      setPackSaveFailed(true);
      toast("No se pudo cerrar el sobre", "error");
    } finally {
      // Sin este finally, un fallo dejaba finishingRef en true y los botones de
      // compra bloqueados para el resto de la sesión.
      finishingRef.current = false;
      setBusy(false);
    }
    // Bonus por completar sets + monedas + estadísticas/logros al día. Va sin
    // await y con la vista ya cerrada: son tres peticiones más y no pueden
    // dejar al usuario encerrado en la pantalla completa esperándolas.
    if (isSignedIn) refreshAfterPack();
  };

  const handleNextCard = async () => {
    // Con el sobre aún sellado, la tecla de avanzar rasga (accesibilidad y
    // escritorio): es lo único que se puede hacer en esa fase.
    if (fase === "sellado") {
      rasgarSobre();
      return;
    }
    // Coreografía en curso: el toque se traga. Aceptarlo saltaría la carta que
    // todavía está emergiendo del sobre.
    if (fase !== "cartas") return;
    if (packIndex < lastIndex) {
      // Sonido y háptico los pone la llegada, que es donde se sabe qué carta
      // aterriza y si es la primera vez que se ve.
      setDirection(1);
      setPackIndex((prev) => prev + 1);
      return;
    }
    // Un toque con inercia justo después de que llegue la última carta cerraba
    // el sobre sin dejar verla, que es justo lo que se ha pagado.
    if (performance.now() - ultimaLlegadaRef.current < GUARDA_CIERRE) return;
    await finishPack();
  };

  const handlePrevCard = () => {
    if (fase !== "cartas") return;
    if (packIndex <= 0) return; // no hay carta anterior
    setDirection(-1);
    setPackIndex((prev) => prev - 1);
  };

  /**
   * Salto a una carta concreta: lo pide el mazo al soltar el arrastre, que ya
   * ha decidido el destino (y ya ha escrito la llegada hacia él).
   * El tope lo garantiza el propio mazo: nunca pasa de maxRevealed.
   */
  const handleIrACarta = (destino: number) => {
    if (fase !== "cartas") return;
    if (destino === packIndex) return;
    setDirection(destino > packIndex ? 1 : -1);
    setPackIndex(destino);
  };

  /**
   * LLEGADA DE CARTA. Sustituye a la rama de volteo: sin volteo, el momento que
   * se celebra es que la carta ATERRICE. Concentrarlo aquí evita repetir el
   * mismo bloque en el toque, el gesto, la tecla y el botón.
   */
  useEffect(() => {
    if (!isPackOpen || !cartasVisibles) return;
    if (anunciadoRef.current === packIndex) return; // re-render / StrictMode
    anunciadoRef.current = packIndex;
    const primera = packIndex >= vistasRef.current;
    vistasRef.current = Math.max(vistasRef.current, packIndex + 1);
    setMaxRevealed((m) => Math.max(m, packIndex + 1));
    ultimaLlegadaRef.current = performance.now();
    if (!primera) {
      // Ya vista: sólo el clic seco de pasar de carta.
      haptic("tap");
      play("tap");
      setFanfarriaEn(null);
      return;
    }
    // El deslizamiento suena YA: es el ruido de la carta saliendo del sobre
    // (o aterrizando, si viene de lado).
    play("voltear");
    // El peso lo marca la carta que llega, nunca la siguiente.
    const rango = currentRank;
    const celebrar = () => {
      haptic(rango >= AURA_RANK ? "heavy" : "select");
      setFanfarriaEn(packIndex);
      if (rango >= 40) {
        const campanada =
          rango >= 85
            ? "revelacion3"
            : rango >= AURA_RANK
              ? "revelacion2"
              : "revelacion1";
        // Un pelín después del golpe: la campanada corona, no compite.
        programar(() => play(campanada), 160);
      }
    };
    if (fase !== "cartas") {
      // Primera carta del sobre: todavía está emergiendo (fase "abriendo").
      // La celebración espera a que se asiente (T_FANFARRIA). Va por
      // programar(): salir a mitad (Escape, chevron) la anula y no suena ni
      // vibra nada con la vista ya cerrada. anunciadoRef ya garantiza que no
      // se programe dos veces. Con efectos apagados nunca se entra aquí: la
      // fase salta directa a "cartas" y se celebra al instante, sin
      // temporizador.
      programar(celebrar, T_FANFARRIA - T_CARTA);
    } else {
      celebrar();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPackOpen, cartasVisibles, packIndex]);

  const handleCardTap = () => {
    // Tras un deslizamiento el navegador emite un click sintético: se ignora.
    if (gestoMazoRef.current?.current) return;
    handleNextCard();
  };

  /**
   * Rasga el sobre y da paso a las cartas. Lo disparan el arrastre de la tira,
   * un click/Enter en el sobre y las teclas de avanzar: todos pasan por aquí
   * para que sonido, háptico y estado vayan siempre juntos.
   *
   * Es el secuenciador de la apertura: la coreografía va en temporizadores
   * explícitos, NO en el `exit` de AnimatePresence. Aquel desvanecía el sobre
   * entero mientras la tira volaba (y el overflow del sobre además la
   * recortaba), así que no se veía nada de lo que se estaba animando.
   */
  const rasgarSobre = (dir: 1 | -1 = 1) => {
    if (tornRef.current || fase !== "sellado") return;
    tornRef.current = true;

    // La coreografía tal cual era. Se saca a una función porque puede tener que
    // esperar (ver abajo), y lo que NO puede es empezar a medias: un rasgado
    // que suena y se queda a mitad porque la carta no ha llegado es peor que
    // medio segundo más de sobre sellado.
    const desgarrar = () => {
      limpiarTemporizadores();
      play("rasgar");
      haptic("success");
      setTearDir(dir);
      setDirection(0); // la primera carta emerge del sobre, no entra de lado
      if (efectosApagados) {
        // Sin coreografía ni temporizadores: las cartas, ya.
        setFase("cartas");
        return;
      }
      setFase("rasgando");
      programar(() => setFase("abriendo"), T_CARTA);
      programar(() => setFase("cartas"), T_FIN);
    };

    /* EL ÚNICO PUNTO EN EL QUE SE ESPERA AL SERVIDOR.
     *
     * Desde que el sobre lo sortea el servidor, la petición sale con el toque
     * de COMPRAR y viaja mientras la vista ya está abierta y el usuario busca
     * la tira. Ese trecho —abrir, mirar, agarrar, arrastrar 80px— es medio
     * segundo largo, muy por encima de lo que tarda la respuesta, así que en la
     * práctica `sobrePendienteRef` ya está a null aquí y `desgarrar()` se
     * ejecuta EN ESTA MISMA LÍNEA: cero espera, misma coreografía que cuando el
     * sobre se inventaba en el navegador.
     *
     * Si la red va mal, el sobre se queda sellado y flotando (con su aviso) en
     * vez de rasgarse hacia una carta que no existe. */
    const pendiente = sobrePendienteRef.current;
    if (!pendiente) {
      desgarrar();
      return;
    }
    setEsperandoSobre(true);
    pendiente.then((llego) => {
      setEsperandoSobre(false);
      // tornRef vuelve a false al reiniciar la vista: si la compra falló o el
      // usuario ya salió, aquí no queda nada que rasgar.
      if (!llego || !tornRef.current) return;
      desgarrar();
    });
  };

  // Arrastre de la tira: el progreso se pinta escribiendo el transform a mano
  // en onMove (sin re-render por movimiento). Al pasar el umbral se rasga al
  // instante, sin esperar a levantar el dedo; el camino por soltar (threshold o
  // velocidad) queda como respaldo para arrastres cortos y decididos.
  const tearSwipeRef = useSwipe(sobreRef, {
    axis: "x",
    follow: false,
    threshold: 80,
    velocity: 600,
    enabled: isPackOpen && fase === "sellado",
    onStart: () => {
      tearWidthRef.current = sobreRef.current?.offsetWidth || 280;
      tearHapticRef.current = 0;
    },
    onMove: (dx) => {
      if (tornRef.current) return;
      const strip = tearStripRef.current;
      if (!strip) return;
      const total = Math.max(90, tearWidthRef.current * 0.55);
      const progreso = Math.min(1, Math.abs(dx) / total);
      strip.style.transform = `translateX(${dx}px)`;
      // Pequeños golpes según avanza el desgarro, como muescas del papel.
      if (progreso - tearHapticRef.current >= 0.2) {
        tearHapticRef.current = progreso;
        haptic("tap");
      }
      if (progreso >= 1) rasgarSobre(dx < 0 ? -1 : 1);
    },
    onEnd: () => {
      if (tornRef.current) return;
      // No llegó al umbral: la tira vuelve a su sitio con un muelle corto.
      const strip = tearStripRef.current;
      if (!strip) return;
      strip.style.transition = "transform 0.25s cubic-bezier(0.32, 0.72, 0, 1)";
      strip.style.transform = "";
      window.setTimeout(() => {
        if (tearStripRef.current) tearStripRef.current.style.transition = "";
      }, 260);
    },
    onSwipeLeft: () => rasgarSobre(-1),
    onSwipeRight: () => rasgarSobre(1),
  });

  // Revelar todo: destapa el sobre entero y deja al usuario en la última carta.
  // No guarda ni cierra: salir es cosa del botón de la cabecera.
  const handleRevealAll = () => {
    if (fase !== "cartas") return;
    setDirection(1);
    setMaxRevealed(currentPack.length);
    // Sin esta línea, la llegada trataría la última carta como recién vista y
    // le montaría la fanfarria: revelar todo nunca ha celebrado nada.
    vistasRef.current = currentPack.length;
    // Único salto que se salta la ventana de alta resolución del mazo (±1): la
    // última ranura pasa de pequeña a frontal de golpe. Se pide su imagen
    // grande ya para que no enseñe un fotograma de imagen escalada.
    const u = currentPack[lastIndex]?.images?.large;
    if (u) new Image().src = u;
    setPackIndex(lastIndex);
  };

  // Mejor carta del sobre (por valor de venta)
  const bestPull = useMemo(() => {
    if (!currentPack.length) return null;
    return [...currentPack].sort(
      (a, b) => precioDeCartaSuelta(b.rarity) - precioDeCartaSuelta(a.rarity),
    )[0];
  }, [currentPack]);

  const handleBackToMenu = () => {
    setSelectedSet(null);
    setAllCards([]);
    resetPackState();
  };

  // Posiciones del sobre que estrenan carta. Sólo cuenta la PRIMERA aparición
  // de cada id: si el sobre trae dos copias de la misma carta, la segunda es
  // una repetida (y como tal la vende dupeIdsInPack), no una nueva.
  const newCardIndexes = useMemo(() => {
    const before = new Set(prePackIds);
    const seen = new Set<string>();
    const indexes = new Set<number>();
    currentPack.forEach((c, i) => {
      if (!before.has(c.id) && !seen.has(c.id)) indexes.add(i);
      seen.add(c.id);
    });
    return indexes;
  }, [currentPack, prePackIds]);

  // Cartas nuevas (no estaban antes del sobre)
  const newCardsInPack = newCardIndexes.size;

  // Duplicados del sobre (ya poseídos antes) → vendibles
  const dupeIdsInPack = useMemo(() => {
    const before = new Set(prePackIds);
    const seenNew = new Set<string>();
    const dupes: string[] = [];
    currentPack.forEach((c) => {
      if (before.has(c.id)) dupes.push(c.id);
      else if (seenNew.has(c.id)) dupes.push(c.id); // repetida dentro del mismo sobre
      else seenNew.add(c.id);
    });
    return dupes;
  }, [currentPack, prePackIds]);

  // Aquí NO se puede estimar el importe: el precio por copia baja con las copias
  // que ya tienes (valorDeVenta) y el cliente, con el sobre recién guardado, no
  // sabe cuántas le han quedado de cada carta. Sumar SELL_PRICES por repetida
  // prometía más de lo que abona sellPackDuplicates, así que el botón no da
  // cifra y el importe real se enseña después, con `soldInfo.earned`.

  // Desglose por rareza del sobre
  const rarityBreakdown = useMemo(() => {
    const counts: Record<string, number> = {};
    currentPack.forEach((c) => { counts[c.rarity || "?"] = (counts[c.rarity || "?"] || 0) + 1; });
    return Object.entries(counts).sort(
      (a, b) => (RARITY_RANK[b[0]] || 0) - (RARITY_RANK[a[0]] || 0),
    );
  }, [currentPack]);

  /**
   * Venta de repetidas del invitado, en local. Es la misma regla y la misma
   * tarifa que aplica el servidor (valorDeVenta), sólo que contra la colección
   * de localStorage: sin esto, el botón del resumen no existía sin cuenta
   * aunque la pantalla de colección sí supiera vender.
   *
   * ORDEN: primero se persiste y luego se abonan las monedas. saveCollectionRaw
   * no captura la excepción de cuota, así que si localStorage revienta el
   * `catch` de quien llama recoge el fallo SIN haber pagado nada.
   */
  const venderRepetidasEnLocal = (ids: string[]): { earned: number; sold: number } => {
    const coleccion = getCollection();
    const porId = new Map(coleccion.map((c) => [c.id, c]));
    const pedidas = new Map<string, number>();
    for (const id of ids) pedidas.set(id, (pedidas.get(id) ?? 0) + 1);

    let earned = 0;
    let sold = 0;
    for (const [id, cuantas] of pedidas) {
      const carta = porId.get(id);
      if (!carta) continue;
      const tengo = Number(carta.quantity) || 0;
      // Nunca por debajo de la copia protegida: el álbum no se vacía.
      const vendibles = Math.min(cuantas, Math.max(0, tengo - COPIAS_PROTEGIDAS));
      if (vendibles <= 0) continue;
      earned += valorDeVenta(carta.rarity, tengo, vendibles);
      carta.quantity = tengo - vendibles;
      sold += vendibles;
    }
    if (sold === 0) return { earned: 0, sold: 0 };

    saveCollectionRaw(coleccion);
    return { earned, sold };
  };

  const handleSellPackDupes = async () => {
    if (dupeIdsInPack.length === 0 || sellingDupes) return;
    setSellingDupes(true);
    try {
      if (!isSignedIn) {
        const res = venderRepetidasEnLocal(dupeIdsInPack);
        if (res.earned > 0) {
          addCoins(res.earned);
          setSoldInfo(res);
          play("moneda");
        } else {
          toast("No había repetidas que vender", "error");
        }
        return;
      }
      // El resumen puede pintarse con la compra AÚN en vuelo (se sale con
      // Escape antes de rasgar). Sin aguardarla, el servidor todavía tiene
      // quantity=1 para estas cartas y sellable=0: la venta saldría a 0 y el
      // botón no haría nada visible.
      await sobrePendienteRef.current;
      const res = await sellPackDuplicates(dupeIdsInPack);
      if (res.earned > 0) {
        // ventasRef avisa a refreshAfterPack de que hay una venta cuyo delta ya
        // está en el marcador, para que no lo pise con un saldo pre-venta.
        ventasRef.current += 1;
        setCoins((c) => c + res.earned);
        setSoldInfo(res);
        play("moneda");
      } else {
        toast("No había repetidas que vender", "error");
      }
    } catch (err) {
      console.error("Error vendiendo repetidas:", err);
      toast("No se pudieron vender las repetidas", "error");
    } finally {
      // Sin el finally, un fallo dejaba el botón en "Vendiendo..." para siempre.
      setSellingDupes(false);
    }
  };

  return (
    <div className="flex flex-col items-center select-none w-full">
      {/* SET COMPLETION BONUS TOAST — en Portal como el resto de capas fijas de
          la página: dentro de la ruta lo contendría el transform de
          app/template.tsx. La TopBar mide 4rem + la safe area y --topbar-h sólo
          cubre esas 4rem, así que hay que sumar --sat para caer por debajo de
          ella y no tapar el saldo. */}
      <Portal>
        <AnimatePresence>
          {setBonus && setBonus.granted > 0 && (
            <motion.div
              initial={{ opacity: 0, y: -20, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -20 }}
              style={{ top: "calc(var(--sat) + var(--topbar-h) + 12px)" }}
              className="fixed left-1/2 -translate-x-1/2 z-[200] bg-yellow-500/15 border border-yellow-500/30 backdrop-blur-xl px-6 py-4 rounded-2xl text-center max-w-sm"
            >
              <p className="text-sm font-semibold" style={{ color: "var(--warn)" }}>¡Set completado!</p>
              <p className="text-xs ink-soft mt-1">
                {setBonus.sets.join(", ")} · +{formatNumber(setBonus.granted)} monedas
              </p>
            </motion.div>
          )}
        </AnimatePresence>
      </Portal>

      {/* Las estadísticas y los logros viven ahora en Social: la portada queda
          en héroe, recompensa diaria y expansiones. */}

      {/* HERO INVITADO */}
      {!selectedSet && isLoaded && !isSignedIn && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
          className="w-full max-w-6xl mb-10 text-center relative z-10"
        >
          <h1 className="text-4xl md:text-6xl font-bold text-gradient-ink tracking-tight">Abre. Colecciona. Completa.</h1>
          <p className="ink-soft text-sm md:text-base mt-4 max-w-md mx-auto">
            Elige una expansión y abre sobres con probabilidades reales. Inicia sesión para guardar tu colección.
          </p>
        </motion.div>
      )}

      {/* VIEW 1: SET SELECTION */}
      {!selectedSet && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="w-full max-w-6xl flex flex-col gap-4 pt-2 pb-24 relative z-10"
        >
          {/* Cabecera de sección: al irse el panel de estadísticas a Social, la
              lista necesitaba un ancla visual que abriera la portada. */}
          {dbSets.length > 0 && (
            <div className="flex items-baseline justify-between px-1 mb-1">
              <h2 className="text-sm font-bold uppercase tracking-[0.2em]">
                Expansiones
              </h2>
              <span className="tnum text-xs ink-faint">
                {formatNumber(dbSets.length)} sets
              </span>
            </div>
          )}
          {Object.entries(setsBySeries).map(([seriesName, sets], idx) => (
            <motion.div
              key={seriesName}
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: idx * 0.08, duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
              className="flex flex-col gap-2"
            >
              <button
                onClick={() => setOpenSeries((s) => ({ ...s, [seriesName]: !s[seriesName] }))}
                className="w-full surface surface-hover rounded-2xl px-4 md:px-5 py-3 md:py-4 flex items-center justify-between press"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <span className="text-sm font-bold uppercase tracking-[0.2em] truncate">{seriesName}</span>
                  <span className="text-xs ink-soft font-mono chip px-2 py-0.5 shrink-0">{sets.length}</span>
                </div>
                <motion.svg
                  animate={{ rotate: openSeries[seriesName] ? 180 : 0 }}
                  transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
                  viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                  className="w-4 h-4 ink-soft"
                >
                  <path d="m6 9 6 6 6-6" />
                </motion.svg>
              </button>

              <AnimatePresence initial={false}>
                {openSeries[seriesName] && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
                    className="overflow-hidden"
                  >
                    <div className="grid grid-cols-2 gap-2.5 md:grid-cols-3 md:gap-4 lg:grid-cols-4 pt-3">
                      {sets.map((set) => (
                        <motion.button
                          key={set.id}
                          whileHover={{ y: -5 }}
                          whileTap={{ scale: 0.96 }}
                          transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
                          onClick={() => handleSelectSet(set.id)}
                          className="group surface surface-hover p-3.5 md:p-8 rounded-2xl md:rounded-3xl flex flex-col items-center justify-between gap-2 md:gap-4 overflow-hidden relative min-h-[126px] md:min-h-[180px]"
                        >
                          <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 bg-[radial-gradient(circle_at_50%_0%,rgba(255,255,255,0.06),transparent_60%)] pointer-events-none" />
                          {/* Esta expansión todavía no tiene diccionario español
                              y se ve en inglés. El aviso existe porque el cron
                              trae expansiones nuevas y la lista va por fecha
                              descendente: salen las PRIMERAS, así que sin él
                              parece que el idioma está roto.
                              `=== false` y no `!set.tieneEs`: el servidor sólo
                              añade el campo en español, así que en inglés es
                              undefined y aquí no se pinta nada.
                              Va como <span> y no como botón: la tarjeta ya es un
                              botón y anidarlos es HTML inválido. */}
                          {set.tieneEs === false && (
                            <span className="absolute top-2 right-2 md:top-3 md:right-3 z-10 chip ink-soft px-1.5 py-0.5 text-[9px] md:text-[10px] font-semibold uppercase tracking-[0.12em] leading-none">
                              EN
                              <span className="sr-only"> · esta expansión todavía no está traducida al español</span>
                            </span>
                          )}
                          <div className="flex-1 flex items-center justify-center w-full relative z-10">
                            {set.images?.logo ? (
                              <img
                                src={set.images.logo}
                                alt={set.name}
                                loading="lazy"
                                decoding="async"
                                className="max-h-[58px] md:max-h-20 max-w-full object-contain group-hover:scale-110 transition-transform duration-500 opacity-90 group-hover:opacity-100 drop-shadow-lg"
                              />
                            ) : (
                              <div className="ink-faint text-sm text-center">{set.name}</div>
                            )}
                          </div>
                          <span className="font-medium text-[11px] md:text-xs ink-soft group-hover:ink transition-colors text-center tracking-wide truncate w-full relative z-10">
                            {set.name}
                          </span>
                        </motion.button>
                      ))}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          ))}
        </motion.div>
      )}

      {/* VIEW 2: PACK SHOP */}
      {selectedSet && !isPackOpen && !currentPack.length && (
        <motion.div
          initial={{ opacity: 0, scale: 0.98 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
          className="w-full max-w-5xl flex flex-col items-center pt-4 relative z-10"
        >
          <button
            onClick={handleBackToMenu}
            className="mb-5 md:mb-10 ink-soft hover:ink transition flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] chip touch-target px-4 py-2 press"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
              <path d="m15 18-6-6 6-6" />
            </svg>
            Volver
          </button>

          {currentSetObj?.images?.logo && (
            <img src={currentSetObj.images.logo} alt={currentSetObj.name} className="h-14 md:h-20 object-contain mb-5 md:mb-10 opacity-90" />
          )}

          {/* Sin cartas no hay sobres que ofrecer: se dice y se ofrece reintentar,
              en vez de enseñar una tienda que falla al pulsar comprar. */}
          {loadError && !loading ? (
            <div className="surface rounded-3xl w-full max-w-sm p-6 flex flex-col items-center gap-3 text-center">
              <p className="text-sm font-semibold">No se han podido cargar las cartas</p>
              <p className="text-xs ink-soft">
                Comprueba tu conexión e inténtalo de nuevo.
              </p>
              <button
                onClick={loadAndSync}
                className="btn-accent press touch-target px-6 py-2.5 rounded-xl text-sm font-semibold"
              >
                Reintentar
              </button>
            </div>
          ) : (
          /* En móvil, carrusel horizontal con anclaje: los tres sobres caben
              "en la misma línea" y se pasan deslizando, en vez de apilarse en
              una columna kilométrica. En md+ vuelve a ser una rejilla. */
          <div
            className={
              isSpecialSet
                ? "w-full max-w-md px-2"
                : "w-full flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:grid md:grid-cols-3 md:gap-6 md:overflow-visible md:px-2 md:pb-0"
            }
          >
            {isSpecialSet ? (
              <PackCard
                accent="blue"
                badge="Edición limitada"
                title="Promo Pack"
                description={<>Garantiza una carta<br />que aún no posees.</>}
                price={PACK_PRICES.SPECIAL}
                odds={oddsPorTipo.SPECIAL}
                icon={
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" className="w-12 h-12 md:w-14 md:h-14">
                    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                  </svg>
                }
                onClick={() => handleBuyPack("SPECIAL")}
                disabled={busy}
              />
            ) : (
              <>
                <PackCard
                  accent="white"
                  title="Estándar"
                  description={<>{cartasPorTipo.STANDARD} cartas.<br />La opción clásica.</>}
                  price={PACK_PRICES.STANDARD}
                  odds={oddsPorTipo.STANDARD}
                  icon={
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" className="w-12 h-12 md:w-14 md:h-14">
                      <rect width="12" height="16" x="2" y="6" rx="2" />
                      <path d="m22 16-2.5-9.4a2 2 0 0 0-2.4-1.4l-4.5 1.2" />
                    </svg>
                  }
                  onClick={() => handleBuyPack("STANDARD")}
                  onMulti={() => handleBuyMulti("STANDARD", 10)}
                  disabled={busy}
                />
                <PackCard
                  accent="purple"
                  badge="Élite"
                  title="Premium"
                  description={<>Sin cartas comunes.<br />{rarasPremium} Raras aseguradas.</>}
                  price={PACK_PRICES.PREMIUM}
                  odds={oddsPorTipo.PREMIUM}
                  icon={
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" className="w-12 h-12 md:w-14 md:h-14">
                      <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z" />
                    </svg>
                  }
                  onClick={() => handleBuyPack("PREMIUM")}
                  onMulti={() => handleBuyMulti("PREMIUM", 10)}
                  disabled={busy}
                />
                <PackCard
                  accent="yellow"
                  badge="Coleccionista"
                  title="Leyenda"
                  description={<>1 carta nueva<br />garantizada.</>}
                  price={PACK_PRICES.GOLDEN}
                  odds={oddsPorTipo.GOLDEN}
                  icon={
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" className="w-12 h-12 md:w-14 md:h-14">
                      <path d="m2 4 3 12h14l3-12-6 7-4-7-4 7-6-7zm3 16h14" />
                    </svg>
                  }
                  onClick={() => handleBuyPack("GOLDEN")}
                  onMulti={() => handleBuyMulti("GOLDEN", 5)}
                  disabled={busy}
                  multiCount={5}
                />
              </>
            )}
          </div>
          )}

          <Portal>
          <AnimatePresence>
            {loading && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fixed inset-0 z-[100] flex flex-col items-center justify-center backdrop-blur-xl"
                style={{ background: "color-mix(in srgb, var(--bg) 70%, transparent)" }}
              >
                <div
                  className="w-10 h-10 border-2 rounded-full animate-spin mb-6"
                  style={{ borderColor: "var(--border)", borderTopColor: "var(--accent)" }}
                ></div>
                <h2 className="text-xs font-semibold ink-soft tracking-[0.3em] uppercase">Preparando cartas</h2>
              </motion.div>
            )}
          </AnimatePresence>
          </Portal>
        </motion.div>
      )}

      {/* VIEW 3: PACK OPENING — inmersiva a pantalla completa.
          Va en un portal a <body> a propósito: app/template.tsx envuelve cada
          ruta en un motion.div con transform, y un ancestro transformado crea
          bloque contenedor para los position:fixed, que dejarían de cubrir la
          pantalla. El portal la saca de ese árbol. */}
      {/* SIN `currentCard &&` EN EL GUARD, Y ES LO QUE HACE QUE SE VEA EL SOBRE.
          Con sesión, handleBuyPack abre la vista con el mazo VACÍO a propósito
          (`abrirSobreSellado(type, [])`) y el contenido llega después: ése es
          justo el truco que esconde la latencia de red, porque el usuario tarda
          más en agarrar la tira que el servidor en contestar.
          Exigir `currentCard` lo anulaba entero: currentPack[0] es undefined
          hasta que llega la respuesta, así que el portal NO se montaba y durante
          todo ese rato isPackOpen ya era true —barra de pestañas escondida por
          useImmersive y body sin scroll— sobre la tienda. Pantalla congelada, y
          el aviso "Preparando el sobre..." era inalcanzable.
          Montar con el mazo vacío es seguro: los seis usos de currentCard de
          aquí dentro cuelgan de `cartasVisibles`, que exige fase "abriendo" o
          "cartas", y el sobre entra en "sellado". */}
      {mounted &&
        isPackOpen &&
        createPortal(
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          data-lenis-prevent
          role="dialog"
          aria-modal="true"
          aria-label="Apertura de sobre"
          className="fixed inset-0 z-[120] flex flex-col items-center overflow-hidden"
          style={{
            height: "var(--app-height)",
            paddingTop: "var(--sat)",
            paddingBottom: "var(--sab)",
            background: "var(--bg)",
          }}
        >
          {/* ESCENARIO Y AURA: capas hermanas en z-0, fuera del contexto 3D de
              la carta. El resplandor nunca puede hacerse con filter ni
              drop-shadow sobre la carta: WebKit rasterizaría la ilustración a
              escala fija y se vería borrosa. */}
          <AnimatePresence>
            {auraLevel >= 2 && (
              // A oscuras la carta buena se lee como un premio; sin esto, en
              // tema claro el aura queda en un manchurrón de color.
              <motion.div
                key={`stage-${packIndex}`}
                initial={{ opacity: 0 }}
                animate={{ opacity: auraLevel >= 3 ? 0.78 : 0.5 }}
                exit={{ opacity: 0, transition: { duration: 0.15 } }}
                transition={{ duration: reduceMotion ? 0 : 0.6, ease: "easeOut", delay: retardoAura }}
                className="pointer-events-none absolute inset-0 z-0"
                style={{
                  background:
                    "radial-gradient(circle at 50% 46%, transparent 26%, rgba(0,0,0,0.92) 100%)",
                }}
              />
            )}
            {auraLevel >= 1 && (
              <motion.div
                key={`aura-${packIndex}`}
                initial={{ opacity: 0 }}
                // Con movimiento reducido se enciende sin pulso: un cambio de
                // luminancia a pantalla completa es lo que evita esa opción.
                animate={
                  reduceMotion
                    ? { opacity: auraLevel >= 2 ? 0.35 : 0.22 }
                    : { opacity: auraLevel >= 3 ? [0, 1, 0.7] : auraLevel >= 2 ? [0, 0.9, 0.55] : [0, 0.5, 0.28] }
                }
                // La salida va corta y aparte: con los 1,2 s de entrada, el
                // resplandor de una rara seguía tiñendo la carta siguiente.
                exit={{ opacity: 0, transition: { duration: 0.15 } }}
                transition={{ duration: reduceMotion ? 0 : 1.2, ease: "easeOut", delay: retardoAura }}
                className="pointer-events-none absolute inset-0 z-0"
                style={{
                  background: `radial-gradient(circle at 50% 46%, ${auraColor}, color-mix(in srgb, ${auraColor} 30%, transparent) 45%, transparent 72%)`,
                }}
              />
            )}
          </AnimatePresence>

          {/* CONFETI sólo para el rango máximo: doce piezas animando transform
              y opacidad, detrás de la carta (z-10 contra su z-20). Los valores
              salen de un pseudoaleatorio determinista por carta para que el
              render sea estable. Sólo salta en la carta que acaba de llegar
              por primera vez (fanfarriaEn): repetirlo al volver atrás lo
              devalúa. Con efectos reducidos ni se monta. */}
          {auraLevel >= 3 && fanfarriaEn === packIndex && !efectosApagados && (
            <div
              key={`confeti-${packIndex}`}
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 z-10 overflow-hidden"
            >
              {Array.from({ length: 12 }).map((_, i) => {
                const s = Math.sin((packIndex + 1) * 91 + i * 37) * 10000;
                const r = s - Math.floor(s); // 0-1 estable por (carta, pieza)
                const ang = (i / 12) * Math.PI * 2 + r * 0.9;
                const dx = Math.cos(ang) * (130 + r * 120);
                const colores = [auraColor, "var(--accent)", "var(--warn)"];
                return (
                  <motion.span
                    key={i}
                    initial={{ x: 0, y: 0, opacity: 0, rotate: 0 }}
                    animate={{
                      x: dx,
                      // Arco sencillo: sube empujado por el estallido y cae.
                      y: [0, -70 - r * 90, 170 + r * 70],
                      opacity: [0, 1, 1, 0],
                      rotate: (r - 0.5) * 540,
                    }}
                    transition={{
                      duration: 1.1 + r * 0.3,
                      // Adelantado: ya no hay giro de 800ms que esperar, el
                      // estallido acompaña a la carta que emerge.
                      delay: 0.2 + (i % 4) * 0.05,
                      ease: "easeOut",
                    }}
                    className="absolute left-1/2 top-[42%] rounded-[2px]"
                    style={{
                      width: 7 + Math.round(r * 4),
                      height: 11 + Math.round(r * 4),
                      background: colores[i % 3],
                    }}
                  />
                );
              })}
            </div>
          )}

          {/* CABECERA (56px): salir + progreso segmentado + contador */}
          <div className="w-full max-w-2xl h-14 shrink-0 flex items-center gap-3 px-3 md:px-4 relative z-20">
            {/* Salida de emergencia: mientras se guarda, este botón NO puede
                llamar a finishPack (lo bloquea finishingRef) ni quedarse
                apagado, porque en esta vista no hay barra de pestañas, ni gesto
                de retroceso, ni scroll: sería un encierro. El sobre ya está
                guardado desde la compra, así que salir no pierde nada. */}
            <button
              onClick={busy ? cerrarVistaSobre : finishPack}
              aria-label={busy ? "Salir de la apertura" : "Guardar el sobre y salir"}
              className="chip press touch-target w-10 h-10 rounded-full flex items-center justify-center shrink-0"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-4 h-4">
                <path d="m15 18-6-6 6-6" />
              </svg>
            </button>

            <div className="flex-1 flex items-center gap-1" aria-hidden="true">
              {Array.from({ length: cartasDelSobre }).map((_, i) => (
                <div
                  key={i}
                  className="h-1 flex-1 rounded-full overflow-hidden"
                  style={{ background: "var(--border-strong)" }}
                >
                  <motion.div
                    initial={false}
                    animate={{ scaleX: i < maxRevealed ? 1 : 0 }}
                    transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
                    className="h-full w-full origin-left"
                    style={{ background: "var(--accent)" }}
                  />
                </div>
              ))}
            </div>

            <span className="tnum ink-soft font-mono text-[11px] tracking-[0.2em] shrink-0">
              {packIndex + 1} / {cartasDelSobre}
            </span>

            {/* Silencio al alcance del pulgar: la apertura es donde suena todo. */}
            <button
              onClick={() => {
                const { sonido } = guardarAjustes({ sonido: !ajustes.sonido });
                // Confirmación audible al activar; de paso desbloquea el
                // AudioContext dentro de un click, que es lo que exige iOS.
                if (sonido) play("tap");
              }}
              aria-label={
                ajustes.sonido
                  ? "Silenciar los efectos de sonido"
                  : "Activar los efectos de sonido"
              }
              aria-pressed={ajustes.sonido}
              className="chip press touch-target w-10 h-10 rounded-full flex items-center justify-center shrink-0"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className={`w-4 h-4 ${ajustes.sonido ? "" : "ink-faint"}`}
              >
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                {ajustes.sonido ? (
                  <>
                    <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                    <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                  </>
                ) : (
                  <>
                    <line x1="22" x2="16" y1="9" y2="15" />
                    <line x1="16" x2="22" y1="9" y2="15" />
                  </>
                )}
              </svg>
            </button>
          </div>

          {/* La carta es una imagen animada: sin esto el lector de pantalla no
              llega a decir qué ha salido. */}
          <p className="sr-only" aria-live="polite">
            {cartasVisibles
              ? `Carta ${packIndex + 1} de ${currentPack.length}: ${currentCard.name}${currentCard.rarity ? `, ${currentCard.rarity}` : ""}`
              : ""}
          </p>

          {/* ZONA DE CARTA */}
          <div className="relative flex-1 w-full flex items-center justify-center px-4">
            {/* El Promo Pack (SPECIAL) también usa openGoldenPack y coloca la
                garantizada al final: se anuncia igual que en Leyenda. */}
            {cartasVisibles &&
              (currentPackType === "GOLDEN" || currentPackType === "SPECIAL") &&
              packIndex === lastIndex && (
              <motion.div
                initial={{ opacity: 0, y: -20 }}
                animate={{ opacity: 1, y: 0 }}
                className="absolute top-1 left-0 right-0 text-center accent text-[10px] md:text-xs font-semibold tracking-[0.3em] uppercase z-20"
              >
                Carta garantizada
              </motion.div>
            )}

            {/* SOBRE: composición CSS con el logo del set, sin assets. La tira
                se arrastra para rasgar; un click o Enter también abren
                (escritorio y accesibilidad). Sigue montado durante "rasgando"
                y "abriendo" para que se le vea caer mientras la carta emerge;
                lo desmonta el paso a "cartas". */}
            {fase !== "cartas" && (
              <BoosterPack
                fase={fase}
                tearDir={tearDir}
                efectosApagados={efectosApagados}
                sobreRef={sobreRef}
                tiraRef={tearStripRef}
                anchoCarta={CARD_WIDTH}
                logo={currentSetObj?.images?.logo}
                nombreSet={currentSetObj?.name}
                cartas={cartasDelSobre}
                gestoRef={tearSwipeRef}
                semilla={semillaSobre}
                onRasgar={rasgarSobre}
              />
            )}

            {/* La red va lenta y el sobre sigue viajando. Casi nunca se ve: la
                petición sale con el toque de comprar y el rasgado ocurre medio
                segundo después. Pero si aparece, el sobre se queda sellado y
                hay que decir por qué en vez de dejarlo mudo. */}
            {esperandoSobre && (
              <p
                aria-live="polite"
                // pointer-events-none: se pinta por encima del sobre y sin
                // esto se comería el pointerdown del arrastre de la tira.
                className="pointer-events-none absolute bottom-4 left-0 right-0 text-center text-[11px] ink-soft animate-pulse z-30"
              >
                Preparando el sobre...
              </p>
            )}

            {cartasVisibles && (
            <>
            {/* ZONA DE GESTO. Sigue siendo de la página (foco, rol de botón,
                Enter y el relevo de foco al rasgar), pero quien escucha el
                arrastre es el mazo: useSwipe se engancha aquí desde
                MazoCartas y mueve las ranuras escribiendo transforms, sin un
                solo re-render por movimiento. */}
            <div
              ref={cardGestureRef}
              onClick={handleCardTap}
              // El espacio ya lo atiende el atajo global de la vista; aquí basta
              // con Enter para que el rol de botón se comporte como tal.
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleNextCard();
                }
              }}
              role="button"
              tabIndex={0}
              // La carta siempre está de cara: la etiqueta dice qué es y qué
              // pasa al tocarla, que ya no es girarla.
              aria-label={`${currentCard.name}${currentCard.rarity ? `, ${currentCard.rarity}` : ""}. ${
                packIndex < lastIndex ? "Siguiente carta" : "Guardar sobre"
              }`}
              className="relative z-40 cursor-pointer select-none"
              style={{
                width: CARD_WIDTH,
                touchAction: touchActionFor("both"),
              }}
            >
              {/* MAZO: se ve UNA carta, de una en una. Las diez ranuras están
                  montadas igualmente —cambiar de carta sólo mueve transforms,
                  nada monta ni desmonta— pero las nueve que no tocan están
                  fuera de la pantalla y a opacidad 0: arrastrar pasa de carta y
                  no destapa ninguna otra. La coreografía de emergencia de la
                  primera carta la hace el MARCO del mazo, con los mismos
                  fotogramas: sube por la boca y se asienta mientras el cuerpo
                  del sobre cae por detrás. Sin perspective: un contexto 3D con
                  diez cartas dentro las rasterizaría todas. */}
              <div className="relative w-full aspect-[2.5/3.5]">
                <MazoCartas
                  cartas={currentPack}
                  indice={packIndex}
                  maxRevealed={maxRevealed}
                  emerge={direction === 0}
                  efectosApagados={efectosApagados}
                  habilitado={isPackOpen && fase === "cartas"}
                  zonaRef={cardGestureRef}
                  gestoRef={gestoMazoRef}
                  onSeleccionar={handleIrACarta}
                />
                {/* La insignia va fuera del mazo: es de la carta actual, no de
                    la ranura, y dentro se iría con ella al pasar de carta. */}
                {newCardIndexes.has(packIndex) && cartasVisibles && (
                  <motion.div
                    key={`nueva-${packIndex}`}
                    // Nada sale de la nada: fundido corto en vez de resorte. En
                    // la primera carta espera a la fanfarria (la carta aún está
                    // emergiendo tras el sobre); en el resto, al instante.
                    initial={efectosApagados ? false : { opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{
                      duration: 0.2,
                      delay:
                        !efectosApagados && fase !== "cartas"
                          ? (T_FANFARRIA - T_CARTA) / 1000
                          : 0,
                    }}
                    className="absolute -top-3 -left-3 z-50 bg-emerald-500 text-white text-[10px] font-bold px-3 py-1 rounded-full uppercase tracking-wider shadow-lg"
                  >
                    Nueva
                  </motion.div>
                )}
              </div>

              {/* DESTELLO en cartas de rango alto: un barrido de luz que cruza
                  la carta al llegar. Es una capa HERMANA del mazo, con
                  transform y opacidad a secas: cualquier filter aquí (o en un
                  ancestro) rasterizaría la carta y saldría borrosa. Sólo en la
                  carta recién llegada, no al volver a visitarla.
                  z-[45] y no z-30: al quitar el perspective del contenedor, el
                  mazo dejó de crear contexto de apilado propio y sus ranuras
                  (la frontal va a z-40) compiten aquí mismo — con z-30 el
                  barrido pasaba POR DETRÁS de la carta y no se veía. Sigue por
                  debajo del sobre (z-50), que está fuera de esta zona. */}
              {fanfarriaEn === packIndex &&
                currentRank >= AURA_RANK &&
                !efectosApagados && (
                <div
                  key={`destello-${packIndex}`}
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 z-[45] overflow-hidden rounded-[4.5%]"
                >
                  <motion.div
                    initial={{ x: "-130%", opacity: 0 }}
                    animate={{ x: "130%", opacity: [0, 0.85, 0] }}
                    transition={{ duration: 0.7, delay: 0.16, ease: "easeOut" }}
                    className="absolute inset-y-[-15%] w-[60%]"
                    style={{
                      background:
                        "linear-gradient(100deg, transparent 12%, rgba(255,255,255,0.45) 50%, transparent 88%)",
                    }}
                  />
                </div>
              )}
            </div>
            </>
            )}
          </div>

          {/* PIE (96px): identidad de la carta + acciones. El alto es fijo a
              propósito: CARD_WIDTH descuenta exactamente estos 96px, así que
              crecer aquí encoge la carta. */}
          <div className="w-full max-w-2xl h-24 shrink-0 flex flex-col items-center justify-center gap-1.5 px-4 relative z-20">
            {/* NADA SALE DE LA NADA: cada estado del rótulo entra y sale en
                fundido, en capa absoluta dentro de un alto reservado (h-10)
                para que nada salte de sitio. AnimatePresence sólo para estos
                elementos pequeños del pie: la coreografía del sobre sigue en
                CSS, que es lo que la hizo fiable. */}
            <div className="relative h-10 w-full">
              <AnimatePresence initial={false}>
                {fase === "sellado" && (
                  <motion.p
                    key="rasga"
                    exit={{ opacity: 0, transition: { duration: efectosApagados ? 0 : 0.15 } }}
                    className="absolute inset-0 flex items-center justify-center ink-faint text-[11px] uppercase tracking-[0.2em]"
                  >
                    Rasga la tira superior para abrir
                  </motion.p>
                )}
                {fase === "rasgando" && (
                  <motion.p
                    key="abriendo"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 0.6 }}
                    exit={{ opacity: 0, transition: { duration: 0.15 } }}
                    transition={{ duration: 0.2 }}
                    className="absolute inset-0 flex items-center justify-center ink-faint text-[11px] uppercase tracking-[0.2em]"
                  >
                    Abriendo…
                  </motion.p>
                )}
                {cartasVisibles && (
                  <motion.div
                    key={`identidad-${packIndex}`}
                    // La identidad de la PRIMERA carta espera a la fanfarria:
                    // aparecer antes chivaría el premio con la carta aún
                    // emergiendo tras el sobre.
                    initial={efectosApagados ? false : { opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, transition: { duration: efectosApagados ? 0 : 0.15 } }}
                    transition={{
                      duration: 0.2,
                      delay:
                        !efectosApagados && fase !== "cartas"
                          ? (T_FANFARRIA - T_CARTA) / 1000
                          : 0,
                    }}
                    className="absolute inset-0 flex flex-col items-center justify-center text-center"
                  >
                    {/* Hasta ahora la vista no decía en ningún sitio qué había
                        salido salvo en el texto para lectores de pantalla. */}
                    <p className="text-sm font-semibold ink leading-tight truncate max-w-full">
                      {currentCard.name}
                    </p>
                    <p className="ink-faint text-[10px] uppercase tracking-[0.16em] leading-tight flex items-center gap-1.5">
                      {RARITY_GLOW[currentCard.rarity] && (
                        // El color de rareza va como punto y no como color de
                        // texto: son rgba fijos y en tema claro no contrastan.
                        <span
                          aria-hidden="true"
                          className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
                          style={{ background: RARITY_GLOW[currentCard.rarity] }}
                        />
                      )}
                      {/* "hasta" y no el precio a secas: lo que se cobra al
                          vender NO es SELL_PRICES, es valorDeVenta, que baja con
                          cada copia que ya tengas (la séptima repetida paga la
                          mitad). El pie prometía la tarifa de la primera y la
                          tienda pagaba otra cosa. */}
                      <span className="truncate">
                        {currentCard.rarity || "Sin rareza"} · hasta{" "}
                        {formatNumber(precioDeCartaSuelta(currentCard.rarity))} monedas
                      </span>
                    </p>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
            {/* Los botones también reservan su hueco (h-11 dentro del pie fijo
                de h-24) y entran en fundido al llegar su fase: durante la
                coreografía no hay nada que pulsar y el pie queda en silencio. */}
            <div className="relative h-11 w-full">
              <AnimatePresence initial={false}>
                {fase === "sellado" && (
                  <motion.div
                    key="abrir"
                    exit={{ opacity: 0, transition: { duration: efectosApagados ? 0 : 0.15 } }}
                    className="absolute inset-0 flex items-center justify-center gap-2"
                  >
                    <button
                      onClick={handleNextCard}
                      disabled={busy}
                      className="btn-accent press touch-target px-6 py-2.5 rounded-xl text-sm font-semibold disabled:opacity-60"
                    >
                      Abrir sobre{" "}
                      <kbd className="ml-1 text-[10px] opacity-70 hidden sm:inline">espacio</kbd>
                    </button>
                  </motion.div>
                )}
                {fase === "cartas" && (
                  <motion.div
                    key="acciones"
                    initial={efectosApagados ? false : { opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.22 }}
                    className="absolute inset-0 flex items-center justify-center gap-2"
                  >
                    <button
                      onClick={handleNextCard}
                      disabled={busy}
                      className="btn-accent press touch-target px-6 py-2.5 rounded-xl text-sm font-semibold disabled:opacity-60"
                    >
                      {busy ? (
                        "Guardando..."
                      ) : (
                        <>
                          {packIndex < lastIndex ? "Siguiente" : "Guardar sobre"}{" "}
                          <kbd className="ml-1 text-[10px] opacity-70 hidden sm:inline">espacio</kbd>
                        </>
                      )}
                    </button>
                    {/* Revelar todo no aparece hasta rasgar: saltarse el sobre
                        cerrado desde aquí vaciaría el momento que se acaba de
                        pagar. */}
                    <button
                      onClick={handleRevealAll}
                      disabled={busy || maxRevealed >= currentPack.length}
                      className="ink-soft hover:ink press touch-target px-4 py-2.5 rounded-xl text-sm font-medium transition flex items-center gap-2 disabled:opacity-50"
                    >
                      Revelar todo
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
                        <path d="m13 17 5-5-5-5M6 17l5-5-5-5" />
                      </svg>
                    </button>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>
        </motion.div>,
          document.body,
        )}

      {/* VIEW 4: SUMMARY */}
      {!isPackOpen && currentPack.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="flex flex-col items-center w-full max-w-7xl pb-24 pt-4 relative z-10"
        >
          <div className="flex flex-col md:flex-row gap-4 mb-12 items-center w-full justify-between">
            <div>
              <h2 className="text-3xl font-bold ink tracking-tight">Resumen</h2>
              <p className="text-xs ink-soft mt-1">
                {newCardsInPack > 0
                  ? `${newCardsInPack} carta${newCardsInPack > 1 ? "s" : ""} nueva${newCardsInPack > 1 ? "s" : ""} añadida${newCardsInPack > 1 ? "s" : ""} a tu colección`
                  : "Sin cartas nuevas en este sobre"}
              </p>
            </div>
            <div className="flex flex-wrap gap-2 md:gap-3 w-full md:w-auto">
              {/* El invitado también vende: su colección vive en localStorage y
                  la pantalla de colección ya sabe venderla (saveCollectionRaw +
                  valorDeVenta). Dejarlo fuera era un hueco, no una decisión. */}
              {dupeIdsInPack.length > 0 && !soldInfo && !packSaveFailed && (
                <button
                  onClick={handleSellPackDupes}
                  disabled={sellingDupes}
                  className="press touch-target px-5 py-2.5 rounded-xl text-sm font-medium transition disabled:opacity-50"
                  style={{
                    background: "var(--ok-weak)",
                    border: "1px solid color-mix(in srgb, var(--ok) 35%, transparent)",
                    color: "var(--ok)",
                  }}
                >
                  {sellingDupes ? "Vendiendo..." : `Vender ${dupeIdsInPack.length} repetidas`}
                </button>
              )}
              {soldInfo && (
                <span className="text-sm font-medium px-3 py-2.5" style={{ color: "var(--ok)" }}>
                  +{formatNumber(soldInfo.earned)} por {soldInfo.sold} repetidas
                </span>
              )}
              {/* Vaciar currentPack a secas dejaba direction en -1 y la primera
                  carta del sobre siguiente entraba por el lado contrario. */}
              <button onClick={resetPackState} className="btn-ghost press touch-target px-5 py-2.5 rounded-xl text-sm font-medium">
                Cambiar de sobre
              </button>
              <button onClick={handleBackToMenu} className="btn-ghost press touch-target px-5 py-2.5 rounded-xl text-sm font-medium">
                Finalizar
              </button>
              {currentPackType && (
                // Repetir el mismo sobre sin pasar por la tienda: handleBuyPack
                // ya comprueba saldo y compra en vuelo, y finishPack ya metió
                // estas cartas en userCollectionIds, así que las "Nuevas" del
                // siguiente sobre salen bien.
                <button
                  onClick={() => handleBuyPack(currentPackType)}
                  disabled={busy}
                  className="btn-accent press touch-target px-6 py-2.5 rounded-xl text-sm font-semibold disabled:opacity-60"
                >
                  {busy ? "Abriendo..." : `Otro sobre · ${formatNumber(PACK_PRICES[currentPackType])}`}
                </button>
              )}
            </div>
          </div>

          {/* DESGLOSE POR RAREZA */}
          <div className="w-full flex flex-wrap gap-2 mb-8">
            {rarityBreakdown.map(([rarity, count]) => (
              <span
                key={rarity}
                className="chip px-3 py-1 text-[11px] ink-soft"
              >
                {count}× <span className="ink font-medium">{rarity}</span>
              </span>
            ))}
          </div>

          {/* El corte usa precioDeCartaSuelta y no `SELL_PRICES[r] || 0`: con el
              respaldo a 0, una rareza fuera de la tabla quedaba fuera de "mejor
              carta del sobre" aunque tres líneas más abajo se le pintaran 10
              monedas. Un solo respaldo para las dos cosas. */}
          {bestPull && precioDeCartaSuelta(bestPull.rarity) >= 50 && (
            <motion.div
              initial={{ opacity: 0, scale: 0.97 }}
              animate={{ opacity: 1, scale: 1 }}
              className="w-full mb-8 surface rounded-2xl p-4 flex items-center gap-4"
              style={{ border: "1px solid color-mix(in srgb, var(--warn) 30%, transparent)" }}
            >
              <img src={bestPull.images?.small} alt={bestPull.name} className="h-16 md:h-24 rounded-lg shrink-0" />
              <div className="flex-1 min-w-0">
                {/* Tokens y no text-yellow-400/text-emerald-400: sobre el papel
                    crema del tema claro esos dos dan ~2:1 de contraste, y aquí
                    se lee lo que vale la carta. --warn-ink y --ok son su
                    versión legible (ver app/globals.css). */}
                <p className="text-[9px] md:text-[10px] font-medium uppercase tracking-[0.2em]" style={{ color: "var(--warn-ink)" }}>Mejor carta del sobre</p>
                <h3 className="text-base md:text-lg font-semibold ink truncate">{bestPull.name}</h3>
                <p className="text-[11px] md:text-xs ink-faint">{bestPull.rarity}</p>
              </div>
              <div className="text-right shrink-0">
                <p className="ink-faint text-[9px] md:text-[10px] uppercase tracking-wider">Valor base</p>
                <p className="text-xl md:text-2xl font-semibold tabular-nums" style={{ color: "var(--ok)" }}>{formatNumber(precioDeCartaSuelta(bestPull.rarity))}</p>
              </div>
            </motion.div>
          )}

          {/* Rejilla estándar de cartas. Sin useHighRes: son miniaturas de
              ~113px y la variante grande son ~600 KB por carta (≈6 MB por
              sobre en datos móviles); PokemonCard elige ya la variante. */}
          <div className="grid grid-cols-3 gap-2.5 sm:grid-cols-4 md:gap-4 lg:grid-cols-6 w-full">
            {currentPack.map((card, index) => {
              const isNew = newCardIndexes.has(index);
              return (
                <motion.div
                  key={index}
                  initial={{ opacity: 0, y: 15 }}
                  animate={{ opacity: 1, y: 0 }}
                  // Un ×10 son 100 cartas: sin tope, la última no aparecía
                  // hasta los cuatro segundos.
                  transition={{ delay: reduceMotion ? 0 : Math.min(index, 12) * 0.04 }}
                  className="relative"
                >
                  {isNew && (
                    <div className="absolute -top-2 -left-2 z-30 bg-emerald-500 text-white text-[9px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider shadow-lg">
                      Nueva
                    </div>
                  )}
                  {wishlistSet.has(card.id) && (
                    <div className="absolute -top-2 -right-2 z-30 bg-pink-500 text-white text-[9px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider shadow-lg">
                      Deseada
                    </div>
                  )}
                  <PokemonCard card={card} reveal={true} interactive={false} />
                </motion.div>
              );
            })}
          </div>
        </motion.div>
      )}
    </div>
  );
}

interface PackCardProps {
  accent: "white" | "purple" | "yellow" | "blue";
  badge?: string;
  title: string;
  description: React.ReactNode;
  price: number;
  icon: React.ReactNode;
  onClick: () => void;
  onMulti?: () => void;
  multiCount?: number;
  odds?: [string, string][];
  /** Hay una compra en vuelo: los botones no deben poder dispararse otra vez. */
  disabled?: boolean;
}

function PackCard({ accent, badge, title, description, price, icon, onClick, onMulti, multiCount = 10, odds, disabled = false }: PackCardProps) {
  const accents: Record<string, { iconColor: string; btn: string; badgeBg: string; glow: string }> = {
    white:  { iconColor: "ink-soft",        btn: "btn-ghost",                                  badgeBg: "chip ink-soft",                       glow: "rgba(148,163,184,0.18)" },
    purple: { iconColor: "text-purple-400", btn: "bg-purple-600 hover:bg-purple-500 text-white", badgeBg: "bg-purple-500/15 text-purple-300 border border-purple-500/20", glow: "rgba(168,85,247,0.22)" },
    yellow: { iconColor: "text-amber-400",  btn: "bg-amber-500 hover:bg-amber-400 text-black",   badgeBg: "bg-amber-500/15 text-amber-300 border border-amber-500/20",   glow: "rgba(245,158,11,0.22)" },
    blue:   { iconColor: "text-sky-400",    btn: "bg-sky-600 hover:bg-sky-500 text-white",       badgeBg: "bg-sky-500/15 text-sky-300 border border-sky-500/20",         glow: "rgba(56,189,248,0.22)" },
  };
  const a = accents[accent];

  return (
    <motion.div
      whileHover={{ y: -6 }}
      whileTap={{ scale: 0.98 }}
      transition={{ duration: 0.25 }}
      className="surface surface-hover rounded-3xl p-5 md:p-8 flex flex-col items-center group relative overflow-hidden text-left w-[76vw] max-w-[300px] shrink-0 snap-center md:w-auto md:max-w-none md:shrink"
    >
      <div className="absolute -top-16 left-1/2 -translate-x-1/2 w-40 h-40 rounded-full blur-3xl pointer-events-none opacity-60 group-hover:opacity-100 transition-opacity" style={{ background: `radial-gradient(circle, ${a.glow}, transparent 70%)` }} />
      {badge && (
        <div className={`absolute top-0 left-0 right-0 ${a.badgeBg} text-[10px] uppercase font-semibold text-center py-1.5 tracking-[0.25em]`}>
          {badge}
        </div>
      )}
      <div className={`${a.iconColor} mb-3 md:mb-8 ${badge ? "mt-6" : ""} group-hover:scale-110 transition-transform duration-500 relative z-10`}>
        {icon}
      </div>
      <h3 className="text-lg md:text-xl font-bold mb-1.5 md:mb-3 relative z-10">{title}</h3>
      <p className="text-[11px] md:text-xs ink-soft text-center mb-3 md:mb-4 leading-relaxed relative z-10">{description}</p>

      {/* Las probabilidades van plegadas: interesan, pero no como para triplicar
          el alto de la tarjeta en un móvil. */}
      {odds && odds.length > 0 && (
        <details className="w-full mb-3 md:mb-5 relative z-10 group/odds">
          <summary className="chip ink-faint touch-target flex items-center justify-center cursor-pointer list-none rounded-lg px-3 py-3 text-center text-[10px] font-semibold tracking-wide uppercase [&::-webkit-details-marker]:hidden">
            Probabilidades
          </summary>
          <div className="surface-2 mt-2 space-y-1 rounded-xl p-3">
            {odds.map(([label, pct]) => (
              <div key={label} className="flex justify-between text-[10px]">
                <span className="ink-faint">{label}</span>
                <span className={`font-mono ${a.iconColor}`}>{pct}</span>
              </div>
            ))}
          </div>
        </details>
      )}

      <div className="mt-auto w-full flex flex-col gap-2 relative z-10">
        <button
          onClick={onClick}
          disabled={disabled}
          className={`${a.btn} press touch-target font-semibold py-2.5 px-6 rounded-xl w-full text-center transition text-sm disabled:opacity-50 disabled:cursor-not-allowed`}
        >
          {disabled ? "Abriendo..." : `${formatNumber(price)} monedas`}
        </button>
        {onMulti && (
          <button
            onClick={onMulti}
            disabled={disabled}
            className="press btn-ghost touch-target font-medium py-2 px-6 rounded-xl w-full text-center transition text-xs disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Abrir ×{multiCount} · {formatNumber(price * multiCount)}
          </button>
        )}
      </div>
    </motion.div>
  );
}
