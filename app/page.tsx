"use client";

import { useUser } from "@clerk/nextjs";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import {
  getUserData,
  spendCoinsAction,
  syncSetToDatabase,
  savePackToCollection,
  getSetsFromDB,
  getFullCollection,
  claimSetCompletionBonuses,
  sellPackDuplicates,
  getWishlistIds,
} from "./action";
import { getCardsFromSet } from "../services/pokemon";
import { openStandardPack, openPremiumPack, openGoldenPack } from "../utils/packLogic";
import { saveToCollection, getCollection } from "../utils/storage";
import { SELL_PRICES, PACK_PRICES, RARITY_RANK } from "../utils/constanst";
import { RARITY_GLOW } from "../utils/rarityGlow";
import { useCurrency } from "../hooks/useGameCurrency";
import { useHaptics } from "../hooks/useHaptics";
import { useSound } from "../hooks/useSound";
import { useSwipe, touchActionFor } from "../hooks/useSwipe";
import { leerAjustes, guardarAjustes, suscribirseAjustes } from "../utils/settings";
import { useToast } from "../components/ui/Toast";
import { useImmersive } from "../components/AppShell";
import PokemonCard from "../components/PokemonCard";
import { formatNumber } from "../utils/format";
import Portal from "../components/ui/Portal";

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

const cardVariants = {
  enter: (dir: number) => ({
    x: dir > 0 ? 120 : -120,
    opacity: 0,
    rotateY: dir > 0 ? 60 : -60,
    scale: 0.92,
  }),
  center: { x: 0, opacity: 1, rotateY: 0, scale: 1 },
  exit: (dir: number) => ({
    x: dir > 0 ? -120 : 120,
    opacity: 0,
    rotateY: dir > 0 ? -60 : 60,
    scale: 0.92,
  }),
};

export default function Home() {
  const { coins, setCoins, spendCoins, addCoins } = useCurrency();
  const { isSignedIn, isLoaded } = useUser();
  const haptic = useHaptics();
  const toast = useToast();

  const [dbSets, setDbSets] = useState<any[]>([]);
  const [selectedSet, setSelectedSet] = useState<string | null>(null);
  const [allCards, setAllCards] = useState<any[]>([]);
  const [userCollectionIds, setUserCollectionIds] = useState<string[]>([]);
  const [currentPackPrice, setCurrentPackPrice] = useState(0);
  const [currentPackType, setCurrentPackType] = useState<PackType | null>(null);
  const [currentPack, setCurrentPack] = useState<any[]>([]);
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
  const [wishlistIds, setWishlistIds] = useState<string[]>([]);
  const [openSeries, setOpenSeries] = useState<Record<string, boolean>>({});
  const [direction, setDirection] = useState(1);
  /** Hay una acción de servidor en vuelo (compra o guardado): botones apagados. */
  const [busy, setBusy] = useState(false);
  /**
   * Fase de la apertura: el sobre llega sellado y hay que rasgar la tira para
   * ver las cartas. "abierto" es el flujo de revelación de siempre.
   */
  const [packStage, setPackStage] = useState<"sellado" | "abierto">("sellado");
  /**
   * Sentido del rasgado (+1 derecha, -1 izquierda): la tira sale volando hacia
   * donde se arrastró. Viaja por el `custom` de AnimatePresence porque las
   * props del elemento saliente se congelan en su último render.
   */
  const [tearDir, setTearDir] = useState(1);
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
   * Guardado del sobre en vuelo. Se lanza al comprar y NO se espera allí, así
   * que finishPack tiene que aguardarlo antes de plantearse un reintento: sin
   * esa espera se guardaría el mismo sobre dos veces y las cantidades de la
   * colección se duplicarían.
   */
  const savePromiseRef = useRef<Promise<unknown> | null>(null);
  /** Momento del último volteo, para no encadenarle un toque con inercia. */
  const lastFlipAtRef = useRef(0);
  /** Elemento que captura los gestos de la carta durante la apertura. */
  const cardGestureRef = useRef<HTMLDivElement>(null);
  /** Sobre sellado completo (para el atajo de teclado de la vista). */
  const sobreRef = useRef<HTMLDivElement>(null);
  /** Zona que escucha el arrastre de la tira de rasgado. */
  const tearZoneRef = useRef<HTMLDivElement>(null);
  /** Tira visual: recibe el transform a mano durante el arrastre. */
  const tearStripRef = useRef<HTMLDivElement>(null);
  /** La tira ya se rasgó: evita disparos dobles entre gesto, click y teclado. */
  const tornRef = useRef(false);
  const tearWidthRef = useRef(280);
  const tearHapticRef = useRef(0);
  const play = useSound();
  // Menos animación por preferencia del sistema: el aura a pantalla completa es
  // un cambio de luminancia grande y framer no desactiva la opacidad por su
  // cuenta.
  const reduceMotion = useReducedMotion();
  // Adornos pesados (confeti, destellos, tira volando): fuera si lo pide el
  // sistema o el ajuste propio de la app.
  const efectosApagados = !!reduceMotion || ajustes.reducirEfectos;

  // La apertura ocupa toda la pantalla: escondemos la barra de pestañas.
  useImmersive(isPackOpen);

  // El portal necesita document.body, que no existe en el render del servidor.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

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
  // Las cartas destapadas son siempre un prefijo (sólo se avanza desde una ya
  // vista), así que maxRevealed basta y no hace falta llevar un conjunto.
  const currentRevealed = packIndex < maxRevealed;
  const currentRank = rankOf(currentCard?.rarity);
  /** 0 nada · 1 destello · 2 aura · 3 aura y escenario a oscuras. */
  const auraLevel = !currentRevealed
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

  const currentSetObj = dbSets.find((s) => s.id === selectedSet);
  const isSpecialSet = currentSetObj
    ? currentSetObj.name.toLowerCase().includes("promos") ||
      currentSetObj.name.toLowerCase().includes("gallery") ||
      currentSetObj.series === "POP" ||
      currentSetObj.series === "Other" ||
      currentSetObj.total < 69
    : false;

  useEffect(() => {
    (async () => {
      const sets = await getSetsFromDB();
      // Sort by release date desc when available
      sets.sort((a: any, b: any) => {
        const da = a.releaseDate ? new Date(a.releaseDate).getTime() : 0;
        const db = b.releaseDate ? new Date(b.releaseDate).getTime() : 0;
        return db - da;
      });
      setDbSets(sets);
    })();
  }, []);

  useEffect(() => {
    const syncUserData = async () => {
      if (!isLoaded) return;
      if (isSignedIn) {
        const data = await getUserData();
        if (data) setCoins(data.coins);
        const myCards = await getFullCollection();
        setUserCollectionIds(myCards.map((c: any) => c.id));
        getWishlistIds().then(setWishlistIds);
      } else {
        const localCards = getCollection();
        setUserCollectionIds(localCards.map((c: any) => c.id));
      }
    };
    syncUserData();
  }, [isSignedIn, isLoaded, setCoins]);

  const loadAndSync = useCallback(async () => {
    if (!selectedSet) return;
    setLoading(true);
    setLoadError(false);
    try {
      const cards = await getCardsFromSet(selectedSet);
      if (cards && cards.length > 0) {
        setAllCards(cards);
        syncSetToDatabase(selectedSet, cards).catch((err) => console.error("sync:", err));
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

  // Al rasgar, el relevo natural: del sobre a la carta.
  useEffect(() => {
    if (isPackOpen && packStage === "abierto") cardGestureRef.current?.focus();
  }, [isPackOpen, packStage]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isPackOpen) return;
      if (e.repeat) return; // ignora auto-repeat al mantener pulsado
      if (e.code === "Escape") {
        e.preventDefault();
        // Mientras hay un guardado en vuelo, finishPack no entra: la capa se
        // cierra en seco igual que hace el botón de la cabecera, porque aquí no
        // hay barra de pestañas ni gesto de retroceso con los que salir.
        if (finishingRef.current) setIsPackOpen(false);
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
  }, [isPackOpen, maxRevealed, packIndex, currentPack, isSignedIn, packStage]);

  // Precarga de las siguientes cartas: la variante grande ronda el medio mega y
  // hasta ahora la descarga no empezaba hasta que la carta se montaba, así que
  // cada avance enseñaba un rectángulo gris. Un colchón de dos basta; las diez
  // de golpe serían ~5 MB para quien salga en la carta 2. El service worker ya
  // cachea images.pokemontcg.io, así que no se descarga dos veces.
  useEffect(() => {
    if (!isPackOpen) return;
    for (const offset of [1, 2]) {
      const url = currentPack[packIndex + offset]?.images?.large;
      if (url) new Image().src = url;
    }
  }, [isPackOpen, packIndex, currentPack]);

  const handleSelectSet = (setId: string) => {
    setSelectedSet(setId);
    resetPackState();
  };

  const resetPackState = () => {
    setCurrentPack([]);
    setPackIndex(0);
    setMaxRevealed(0);
    setIsPackOpen(false);
    setDirection(1);
    // El siguiente sobre vuelve a llegar sellado.
    setPackStage("sellado");
    tornRef.current = false;
  };

  const handleBuyPack = async (type: PackType) => {
    if (finishingRef.current) return;
    if (!allCards || allCards.length === 0) {
      toast("Las cartas no se han cargado. Recarga la página.", "error");
      return;
    }
    const price = PACK_PRICES[type];
    if (coins < price) {
      haptic("warning");
      toast("No tienes suficientes monedas", "error");
      return;
    }

    let newPack: any[] = [];
    if (type === "STANDARD") newPack = openStandardPack(allCards);
    else if (type === "PREMIUM") newPack = openPremiumPack(allCards);
    else newPack = openGoldenPack(allCards, userCollectionIds);

    // Las dos primeras se piden ya, mientras el cobro viaja al servidor: cuando
    // la vista se abra, la imagen estará en camino o en caché.
    for (const card of newPack.slice(0, 2)) {
      const url = card?.images?.large;
      if (url) new Image().src = url;
    }

    // Cierre mientras el cobro viaja al servidor: sin él, un doble toque
    // compraba dos sobres y se descontaba uno solo.
    finishingRef.current = true;
    setBusy(true);
    packSavedRef.current = false;
    savePromiseRef.current = null;
    try {
      if (isSignedIn) {
        // Con sesión manda el servidor: cobra de forma atómica y devuelve el
        // saldo resultante, que es el que adopta el cliente. Si no hay fondos
        // o falla, no se abre nada y no se ha descontado nada.
        const balance = await spendCoinsAction(price);
        if (balance === null) {
          toast("No se pudo completar la compra", "error");
          haptic("warning");
          return;
        }
        setCoins(balance);
        // El sobre se guarda ya cobrado, sin esperar a que se revele: si la app
        // muere a mitad de la revelación (iOS la mata en segundo plano, recarga,
        // botón atrás) las monedas están gastadas y las cartas deben existir.
        // No se espera aquí: son una veintena de consultas en serie y el sobre
        // tiene que abrirse en el instante del toque. finishPack aguarda esta
        // promesa antes de decidir si reintenta.
        savePromiseRef.current = savePackToCollection(newPack, price)
          .then((res) => {
            // La acción no lanza: devuelve {success:false}. Sin comprobarlo,
            // un fallo de base de datos pasaría por guardado correcto.
            packSavedRef.current = res?.success === true;
          })
          .catch((err) => {
            // No se avisa aquí: finishPack lo reintenta al cerrar la revelación.
            console.error("Error guardando el sobre:", err);
          });
      } else if (!spendCoins(price)) {
        // Invitado: el saldo sólo vive en este dispositivo.
        return;
      } else {
        saveToCollection(newPack);
        packSavedRef.current = true;
      }
    } catch (err) {
      console.error("Error descontando monedas:", err);
      toast("No se pudo completar la compra", "error");
      haptic("warning");
      return;
    } finally {
      finishingRef.current = false;
      setBusy(false);
    }

    play("moneda");
    setPrePackIds([...userCollectionIds]); // snapshot ANTES del sobre
    setSoldInfo(null);
    setCurrentPackType(type);
    setCurrentPack(newPack);
    setCurrentPackPrice(price);
    setPackIndex(0);
    setMaxRevealed(0);
    // Si el sobre anterior se cerró tras retroceder, direction quedaba en -1 y
    // la primera carta del nuevo entraba por el lado contrario.
    setDirection(1);
    // El sobre entra sellado: hay que rasgar la tira para ver las cartas.
    setPackStage("sellado");
    tornRef.current = false;
    setIsPackOpen(true);
  };

  /**
   * Puesta al día tras guardar un sobre (sólo con sesión): bonus por set
   * completado y monedas reales del servidor. Las estadísticas y logros viven
   * ahora en Social, así que aquí ya no se piden.
   * Nunca lanza: un fallo aquí no puede tumbar el guardado del sobre.
   */
  const refreshAfterPack = async () => {
    try {
      const res = await claimSetCompletionBonuses();
      if (res.granted > 0) {
        setSetBonus({ granted: res.granted, sets: res.sets });
        setTimeout(() => setSetBonus(null), 6000);
      }
    } catch (err) {
      console.error("Error reclamando bonus de set:", err);
    }
    try {
      // Las monedas se releen del servidor (el bonus y la compra se aplican
      // allí) para que el marcador no quede desincronizado.
      const data = await getUserData();
      if (data) setCoins(data.coins);
    } catch (err) {
      console.error("Error refrescando el saldo:", err);
    }
  };

  // Apertura múltiple (×N): salta animación, guarda todo, va al resumen.
  const handleBuyMulti = async (type: PackType, count = 10) => {
    if (finishingRef.current) return;
    finishingRef.current = true;
    setBusy(true);
    // Todo va en try/finally: antes, un fallo de red dejaba finishingRef en
    // true y los botones de compra bloqueados para el resto de la sesión.
    try {
      if (!allCards || allCards.length === 0) {
        toast("Las cartas no se han cargado. Recarga la página.", "error");
        return;
      }
      const price = PACK_PRICES[type] * count;
      if (coins < price) {
        haptic("warning");
        toast(`Necesitas ${formatNumber(price)} monedas para ×${count}`, "error");
        return;
      }

      const ownedSnapshot = [...userCollectionIds];
      const owned = new Set(ownedSnapshot);
      const combined: any[] = [];
      for (let i = 0; i < count; i++) {
        let p: any[] = [];
        if (type === "STANDARD") p = openStandardPack(allCards);
        else if (type === "PREMIUM") p = openPremiumPack(allCards);
        else p = openGoldenPack(allCards, Array.from(owned));
        combined.push(...p);
        p.forEach((c) => owned.add(c.id)); // golden garantiza nuevas distintas
      }

      let saved = true;
      try {
        if (isSignedIn) {
          // Cobro atómico primero: si no hay fondos o falla, no se entrega nada.
          const balance = await spendCoinsAction(price);
          if (balance === null) {
            toast("No se pudo completar la compra", "error");
            haptic("warning");
            return;
          }
          setCoins(balance);
          const res = await savePackToCollection(combined, price, count);
          // La acción devuelve {success:false} en vez de lanzar: sin esta
          // comprobación, un fallo se daba por bueno y las cartas no existían.
          if (res?.success !== true) throw new Error(res?.error || "guardado rechazado");
          await refreshAfterPack();
        } else if (!spendCoins(price)) {
          return;
        } else {
          saveToCollection(combined);
        }
      } catch (err) {
        console.error("Error guardando los sobres:", err);
        toast("No se pudieron guardar los sobres en la nube", "error");
        saved = false;
      }
      packSavedRef.current = saved;

      setPrePackIds(ownedSnapshot);
      // Sólo damos por poseídas las cartas si el guardado salió bien.
      if (saved) setUserCollectionIds((prev) => [...prev, ...combined.map((c) => c.id)]);
      setSoldInfo(null);
      setCurrentPackType(type);
      setCurrentPack(combined);
      setCurrentPackPrice(price);
      setIsPackOpen(false); // directo al resumen
      play("moneda");
      haptic("success");
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
      setIsPackOpen(false);
      // El guardado se lanzó al comprar y puede seguir en vuelo: hay que
      // esperarlo ANTES de decidir el reintento o el sobre se guardaría dos
      // veces y las cantidades quedarían dobladas.
      await savePromiseRef.current;
      // El sobre ya se guardó al comprarlo; sólo se reintenta si aquello falló.
      if (!packSavedRef.current) {
        if (isSignedIn) {
          const res = await savePackToCollection(currentPack, currentPackPrice);
          packSavedRef.current = res?.success === true;
        } else {
          saveToCollection(currentPack);
          packSavedRef.current = true;
        }
      }
      if (packSavedRef.current) {
        const newPackIds = currentPack.map((c) => c.id);
        setUserCollectionIds((prev) => [...prev, ...newPackIds]);
        haptic("success");
      } else {
        // Con el sobre sin guardar no se dan por poseídas sus cartas: si no, la
        // colección enseñaría cartas que no están en la base de datos.
        toast("No se pudo guardar el sobre en la nube", "error");
        haptic("warning");
      }
    } catch (err) {
      // Una caída de red al guardar no puede dejar el sobre a medias: se avisa
      // y se sale igualmente al resumen, con las cartas ya en pantalla.
      console.error("Error guardando el sobre:", err);
      toast("No se pudo guardar el sobre en la nube", "error");
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
    if (packStage === "sellado") {
      rasgarSobre();
      return;
    }
    if (!currentRevealed) {
      // El peso lo marca la carta que se está destapando, nunca la siguiente:
      // medirlo sobre la siguiente chivaba la rareza antes de verla.
      haptic(currentRank >= AURA_RANK ? "heavy" : "select");
      play("voltear");
      // La campanada llega justo tras el volteo, con el giro ya en marcha; su
      // riqueza crece con el rango, igual que el aura.
      if (currentRank >= 40) {
        const campanada =
          currentRank >= 85
            ? "revelacion3"
            : currentRank >= AURA_RANK
              ? "revelacion2"
              : "revelacion1";
        window.setTimeout(() => play(campanada), 280);
      }
      lastFlipAtRef.current = performance.now();
      setMaxRevealed((m) => Math.max(m, packIndex + 1));
      return;
    }
    if (packIndex < lastIndex) {
      // Avanzar sólo mueve el mazo: la carta llega tapada y se destapa aparte,
      // así que aquí no hay rareza que anunciar.
      haptic("tap");
      play("tap");
      setDirection(1);
      setPackIndex((prev) => prev + 1);
    } else {
      // Un toque con inercia justo después de destapar la última carta cerraba
      // el sobre sin dejar verla, que es justo lo que se ha pagado.
      if (performance.now() - lastFlipAtRef.current < 400) return;
      await finishPack();
    }
  };

  const handlePrevCard = () => {
    if (packIndex <= 0) return; // no hay carta anterior
    haptic("tap");
    play("tap");
    setDirection(-1);
    setPackIndex((prev) => prev - 1);
  };

  const handleCardTap = () => {
    // Tras un deslizamiento el navegador emite un click sintético: se ignora.
    if (didSwipeRef.current) return;
    handleNextCard();
  };

  // Gestos de la carta: izquierda y derecha para pasar. El giro acompaña al
  // arrastre para dar tacto de carta física. No hay gesto vertical a propósito:
  // un flick en diagonal terminaba el sobre sin aviso ni vuelta atrás; sin
  // manejador, useSwipe le aplica resistencia y la carta vuelve a su sitio.
  // enabled depende también de la fase: la carta no existe hasta rasgar el
  // sobre, y el hook sólo engancha los listeners cuando enabled cambia.
  const didSwipeRef = useSwipe(cardGestureRef, {
    axis: "both",
    rotate: 6,
    enabled: isPackOpen && packStage === "abierto",
    onSwipeLeft: () => handleNextCard(),
    onSwipeRight: packIndex > 0 ? () => handlePrevCard() : undefined,
  });

  /**
   * Rasga el sobre y da paso a las cartas. Lo disparan el arrastre de la tira,
   * un click/Enter en el sobre y las teclas de avanzar: todos pasan por aquí
   * para que sonido, háptico y estado vayan siempre juntos.
   */
  const rasgarSobre = (dir: 1 | -1 = 1) => {
    if (tornRef.current || packStage !== "sellado") return;
    tornRef.current = true;
    play("rasgar");
    haptic("success");
    // En el mismo render que el cambio de fase, para que el custom de
    // AnimatePresence ya lleve el sentido cuando la tira empiece a salir.
    setTearDir(dir);
    setPackStage("abierto");
  };

  // Arrastre de la tira: el progreso se pinta escribiendo el transform a mano
  // en onMove (sin re-render por movimiento). Al pasar el umbral se rasga al
  // instante, sin esperar a levantar el dedo; el camino por soltar (threshold o
  // velocidad) queda como respaldo para arrastres cortos y decididos.
  const tearSwipeRef = useSwipe(tearZoneRef, {
    axis: "x",
    follow: false,
    threshold: 80,
    velocity: 600,
    enabled: isPackOpen && packStage === "sellado",
    onStart: () => {
      tearWidthRef.current = tearZoneRef.current?.offsetWidth || 280;
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
    setDirection(1);
    setMaxRevealed(currentPack.length);
    setPackIndex(lastIndex);
  };

  // Mejor carta del sobre (por valor de venta)
  const bestPull = useMemo(() => {
    if (!currentPack.length) return null;
    return [...currentPack].sort(
      (a, b) => (SELL_PRICES[b.rarity] || 0) - (SELL_PRICES[a.rarity] || 0),
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

  const dupeValue = useMemo(
    () => dupeIdsInPack.reduce((sum, id) => {
      const card = currentPack.find((c) => c.id === id);
      return sum + (SELL_PRICES[card?.rarity] || 10);
    }, 0),
    [dupeIdsInPack, currentPack],
  );

  // Desglose por rareza del sobre
  const rarityBreakdown = useMemo(() => {
    const counts: Record<string, number> = {};
    currentPack.forEach((c) => { counts[c.rarity || "?"] = (counts[c.rarity || "?"] || 0) + 1; });
    return Object.entries(counts).sort(
      (a, b) => (RARITY_RANK[b[0]] || 0) - (RARITY_RANK[a[0]] || 0),
    );
  }, [currentPack]);

  const handleSellPackDupes = async () => {
    if (!isSignedIn || dupeIdsInPack.length === 0 || sellingDupes) return;
    setSellingDupes(true);
    try {
      const res = await sellPackDuplicates(dupeIdsInPack);
      if (res.earned > 0) {
        setCoins((c) => c + res.earned);
        setSoldInfo(res);
        play("moneda");
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
                  description={<>Probabilidades oficiales.<br />La opción clásica.</>}
                  price={PACK_PRICES.STANDARD}
                  odds={[
                    ["Hyper Rare", "0.5%"],
                    ["Special Illust.", "2%"],
                    ["Ultra Rare", "4%"],
                    ["Illustration Rare", "8%"],
                    ["Double Rare", "15.5%"],
                  ]}
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
                  description={<>Sin cartas comunes.<br />2 Raras aseguradas.</>}
                  price={PACK_PRICES.PREMIUM}
                  odds={[
                    ["Hyper Rare", "5%"],
                    ["Special Illust.", "10%"],
                    ["Ultra Rare", "25%"],
                    ["Double Rare", "60%"],
                  ]}
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
                  odds={[
                    ["Carta nueva", "100%"],
                    ["Slot Ultra Rare", "1×"],
                    ["Slot Double Rare", "3×"],
                  ]}
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
      {mounted &&
        isPackOpen &&
        currentCard &&
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
                transition={{ duration: reduceMotion ? 0 : 0.6, ease: "easeOut" }}
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
                transition={{ duration: reduceMotion ? 0 : 1.2, ease: "easeOut" }}
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
              render sea estable. Sólo salta en la carta recién destapada (la
              frontera de maxRevealed): repetirlo al volver atrás lo devalúa.
              Con efectos reducidos ni se monta. */}
          {auraLevel >= 3 && packIndex === maxRevealed - 1 && !efectosApagados && (
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
                      delay: 0.3 + (i % 4) * 0.05,
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
              onClick={busy ? () => setIsPackOpen(false) : finishPack}
              aria-label={busy ? "Salir de la apertura" : "Guardar el sobre y salir"}
              className="chip press touch-target w-10 h-10 rounded-full flex items-center justify-center shrink-0"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-4 h-4">
                <path d="m15 18-6-6 6-6" />
              </svg>
            </button>

            <div className="flex-1 flex items-center gap-1" aria-hidden="true">
              {currentPack.map((_, i) => (
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
              {packIndex + 1} / {currentPack.length}
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
            {currentRevealed
              ? `Carta ${packIndex + 1} de ${currentPack.length}: ${currentCard.name}${currentCard.rarity ? `, ${currentCard.rarity}` : ""}`
              : ""}
          </p>

          {/* ZONA DE CARTA */}
          <div className="relative flex-1 w-full flex items-center justify-center px-4">
            {/* El Promo Pack (SPECIAL) también usa openGoldenPack y coloca la
                garantizada al final: se anuncia igual que en Leyenda. */}
            {packStage === "abierto" &&
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

            {/* SOBRE SELLADO: composición CSS con el logo del set, sin assets.
                La tira superior se arrastra para rasgar; un click o Enter
                también abren (escritorio y accesibilidad). El overflow-hidden
                del sobre recorta la tira cuando sale volando: se va "fuera del
                papel", que es justo la metáfora. */}
            <AnimatePresence custom={tearDir}>
              {packStage === "sellado" && (
                <motion.div
                  key="sobre-sellado"
                  initial={efectosApagados ? false : { opacity: 0, scale: 0.94, y: 16 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{
                    opacity: 0,
                    scale: 1.04,
                    // Mientras sale volando sigue en el DOM por encima de la
                    // carta: sin esto retendría los toques ese medio segundo.
                    // Va en el exit (no en style con packStage) porque
                    // AnimatePresence congela las props del último render.
                    pointerEvents: "none",
                    transition: {
                      duration: efectosApagados ? 0 : 0.3,
                      delay: efectosApagados ? 0 : 0.14,
                      ease: "easeOut",
                    },
                  }}
                  transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
                  className="absolute inset-0 z-20 flex items-center justify-center px-4"
                >
                  <div
                    ref={sobreRef}
                    role="button"
                    tabIndex={0}
                    aria-label="Rasgar y abrir el sobre"
                    onClick={() => {
                      // El click sintético tras un arrastre de la tira no debe
                      // contar como toque de apertura.
                      if (tearSwipeRef.current) return;
                      rasgarSobre();
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        rasgarSobre();
                      }
                    }}
                    className="relative cursor-pointer select-none overflow-hidden rounded-2xl border"
                    style={{
                      width: CARD_WIDTH,
                      aspectRatio: "2.5 / 3.5",
                      borderColor: "var(--border-strong)",
                      boxShadow: "var(--shadow-md)",
                      background:
                        "radial-gradient(120% 70% at 50% 0%, color-mix(in srgb, var(--accent) 26%, transparent), transparent 55%), linear-gradient(165deg, color-mix(in srgb, var(--accent) 20%, var(--surface)) 0%, var(--surface) 46%, color-mix(in srgb, var(--accent) 10%, var(--surface-2)) 100%)",
                    }}
                  >
                    {/* Brillo de foil: rayas diagonales muy tenues. */}
                    <div
                      aria-hidden="true"
                      className="absolute inset-0 pointer-events-none"
                      style={{
                        background:
                          "repeating-linear-gradient(115deg, transparent 0 14px, rgba(255,255,255,0.04) 14px 17px)",
                      }}
                    />

                    {/* Hueco que queda al desprenderse la tira. */}
                    <div
                      aria-hidden="true"
                      className="absolute top-0 inset-x-0 h-12"
                      style={{
                        background: "color-mix(in srgb, var(--bg) 55%, transparent)",
                        boxShadow: "inset 0 -8px 14px rgba(0,0,0,0.28)",
                      }}
                    />

                    {/* TIRA DE RASGADO. La capa exterior (motion) vuela al
                        rasgarse; la interior recibe el transform del dedo. */}
                    <motion.div
                      // Variante dinámica y no un objeto: el sentido llega por
                      // el custom de AnimatePresence en el momento de salir,
                      // que es el único dato fresco que tiene un nodo saliente.
                      variants={{
                        volar: (dir: number) => ({
                          x: 84 * dir,
                          y: -150,
                          rotate: -10 * dir,
                          opacity: 0,
                          transition: {
                            duration: efectosApagados ? 0 : 0.4,
                            ease: "easeOut",
                          },
                        }),
                      }}
                      exit="volar"
                      className="absolute top-0 inset-x-0 z-10"
                    >
                      <div
                        ref={tearZoneRef}
                        className="relative h-12 touch-target"
                        style={{ touchAction: touchActionFor("x") }}
                      >
                        <div
                          ref={tearStripRef}
                          className="absolute inset-0 flex items-center justify-center gap-2 px-3"
                          style={{
                            background:
                              "linear-gradient(180deg, color-mix(in srgb, var(--accent) 34%, var(--surface-2)), color-mix(in srgb, var(--accent) 16%, var(--surface-2)))",
                            // La perforación por la que se rasga la tira.
                            borderBottom: "2px dashed var(--border-strong)",
                          }}
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-3.5 h-3.5 ink-faint shrink-0">
                            <path d="m11 17-5-5 5-5M18 17l-5-5 5-5" />
                          </svg>
                          <span className="text-[10px] font-semibold uppercase tracking-[0.25em] ink-soft whitespace-nowrap">
                            Desliza para rasgar
                          </span>
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-3.5 h-3.5 ink-faint shrink-0">
                            <path d="m6 17 5-5-5-5M13 17l5-5-5-5" />
                          </svg>
                        </div>
                      </div>
                    </motion.div>

                    {/* Cuerpo del sobre: logo y nombre del set. */}
                    <div className="absolute inset-x-0 top-12 bottom-0 flex flex-col items-center justify-center gap-4 px-6">
                      {currentSetObj?.images?.logo ? (
                        <img
                          src={currentSetObj.images.logo}
                          alt=""
                          decoding="async"
                          className="max-h-[38%] max-w-[80%] object-contain"
                        />
                      ) : (
                        <span className="text-lg font-bold text-center">
                          {currentSetObj?.name}
                        </span>
                      )}
                      <div className="flex flex-col items-center gap-2">
                        {currentSetObj?.images?.logo && (
                          <span className="text-xs font-semibold ink-soft text-center">
                            {currentSetObj.name}
                          </span>
                        )}
                        <span className="chip px-3 py-1 text-[10px] uppercase tracking-[0.2em] ink-faint">
                          {formatNumber(currentPack.length)} cartas
                        </span>
                      </div>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {packStage === "abierto" && (
            <>
            {/* El gesto va con useSwipe (eventos de puntero) y no con el drag
                de framer: así el arrastre se pinta escribiendo el transform,
                sin re-render por movimiento, y sigue el dedo con fidelidad. */}
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
              aria-label={
                currentRevealed
                  ? `${currentCard.name}${currentCard.rarity ? `, ${currentCard.rarity}` : ""}`
                  : "Girar carta"
              }
              className="relative z-20 cursor-pointer select-none"
              style={{
                width: CARD_WIDTH,
                touchAction: touchActionFor("both"),
              }}
            >
              {/* la perspectiva va en el padre directo de la carta animada */}
              <div className="relative w-full aspect-[2.5/3.5] perspective-1000">
                {/* Sin mode="wait": las dos cartas son absolute inset-0 dentro
                    de este padre, así que se cruzan sin descolocar nada y se
                    ahorra el medio segundo de zona vacía entre carta y carta. */}
                <AnimatePresence custom={direction}>
                  <motion.div
                    key={packIndex}
                    custom={direction}
                    variants={cardVariants}
                    initial="enter"
                    animate="center"
                    exit="exit"
                    transition={{ duration: 0.26, ease: [0.16, 1, 0.3, 1] }}
                    className="absolute inset-0"
                  >
                    <PokemonCard card={currentCard} reveal={currentRevealed} useHighRes={true} />
                  </motion.div>
                </AnimatePresence>
                {/* La insignia va fuera del bloque animado: con las cartas
                    solapándose se verían dos a la vez durante el relevo. */}
                {newCardIndexes.has(packIndex) && currentRevealed && (
                  <motion.div
                    key={`nueva-${packIndex}`}
                    initial={{ scale: 0, x: -20 }}
                    animate={{ scale: 1, x: 0 }}
                    transition={{ type: "spring", bounce: 0.5 }}
                    className="absolute -top-3 -left-3 z-50 bg-emerald-500 text-white text-[10px] font-bold px-3 py-1 rounded-full uppercase tracking-wider shadow-lg"
                  >
                    Nueva
                  </motion.div>
                )}
              </div>

              {/* DESTELLO en cartas de rango alto: un barrido de luz que cruza
                  la carta al voltearla. Es una capa HERMANA del contenedor 3D,
                  con transform y opacidad a secas: cualquier filter aquí (o en
                  un ancestro) rasterizaría la carta y saldría borrosa. Sólo en
                  la carta recién destapada, no al volver a visitarla. */}
              {currentRevealed &&
                currentRank >= AURA_RANK &&
                packIndex === maxRevealed - 1 &&
                !efectosApagados && (
                <div
                  key={`destello-${packIndex}`}
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 z-30 overflow-hidden rounded-[4.5%]"
                >
                  <motion.div
                    initial={{ x: "-130%", opacity: 0 }}
                    animate={{ x: "130%", opacity: [0, 0.85, 0] }}
                    transition={{ duration: 0.7, delay: 0.3, ease: "easeOut" }}
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
            <div className="h-10 w-full flex flex-col items-center justify-center text-center">
              {packStage === "sellado" ? (
                <p className="ink-faint text-[11px] uppercase tracking-[0.2em]">
                  Rasga la tira superior para abrir
                </p>
              ) : currentRevealed ? (
                <>
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
                    <span className="truncate">
                      {currentCard.rarity || "Sin rareza"} ·{" "}
                      {formatNumber(SELL_PRICES[currentCard.rarity] || 10)} monedas
                    </span>
                  </p>
                </>
              ) : (
                <p className="ink-faint text-[11px] uppercase tracking-[0.2em]">
                  Toca la carta para darle la vuelta
                </p>
              )}
            </div>
            <div className="flex items-center justify-center gap-2 w-full">
              <button
                onClick={handleNextCard}
                disabled={busy}
                className="btn-accent press touch-target px-6 py-2.5 rounded-xl text-sm font-semibold disabled:opacity-60"
              >
                {busy ? (
                  "Guardando..."
                ) : (
                  <>
                    {packStage === "sellado"
                      ? "Abrir sobre"
                      : !currentRevealed
                        ? "Voltear"
                        : packIndex < lastIndex
                          ? "Siguiente"
                          : "Guardar sobre"}{" "}
                    <kbd className="ml-1 text-[10px] opacity-70 hidden sm:inline">espacio</kbd>
                  </>
                )}
              </button>
              {/* Revelar todo no aparece hasta rasgar: saltarse el sobre
                  cerrado desde aquí vaciaría el momento que se acaba de pagar. */}
              {packStage === "abierto" && (
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
              )}
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
              {isSignedIn && dupeIdsInPack.length > 0 && !soldInfo && (
                <button
                  onClick={handleSellPackDupes}
                  disabled={sellingDupes}
                  className="bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-emerald-300 px-5 py-2.5 rounded-xl text-sm font-medium transition disabled:opacity-50"
                >
                  {sellingDupes ? "Vendiendo..." : `Vender ${dupeIdsInPack.length} repetidas (+${formatNumber(dupeValue)})`}
                </button>
              )}
              {soldInfo && (
                <span className="text-emerald-300 text-sm font-medium px-3 py-2.5">
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

          {bestPull && (SELL_PRICES[bestPull.rarity] || 0) >= 50 && (
            <motion.div
              initial={{ opacity: 0, scale: 0.97 }}
              animate={{ opacity: 1, scale: 1 }}
              className="w-full mb-8 surface rounded-2xl p-4 flex items-center gap-4 border border-yellow-500/20"
            >
              <img src={bestPull.images?.small} alt={bestPull.name} className="h-16 md:h-24 rounded-lg shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-yellow-400 text-[9px] md:text-[10px] font-medium uppercase tracking-[0.2em]">Mejor carta del sobre</p>
                <h3 className="text-base md:text-lg font-semibold ink truncate">{bestPull.name}</h3>
                <p className="text-[11px] md:text-xs ink-faint">{bestPull.rarity}</p>
              </div>
              <div className="text-right shrink-0">
                <p className="ink-faint text-[9px] md:text-[10px] uppercase tracking-wider">Valor</p>
                <p className="text-xl md:text-2xl font-semibold text-emerald-400 tabular-nums">{SELL_PRICES[bestPull.rarity] || 10}</p>
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
                  {wishlistIds.includes(card.id) && (
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
