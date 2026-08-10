"use client";

import { useUser } from "@clerk/nextjs";
import { AnimatePresence, motion } from "framer-motion";
import { useState, useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import {
  getUserData,
  updateCoins,
  syncSetToDatabase,
  savePackToCollection,
  getSetsFromDB,
  getFullCollection,
  getProfileStats,
  claimSetCompletionBonuses,
  sellPackDuplicates,
  getWishlistIds,
} from "./action";
import { getCardsFromSet } from "../services/pokemon";
import { openStandardPack, openPremiumPack, openGoldenPack } from "../utils/packLogic";
import { saveToCollection, getCollection } from "../utils/storage";
import { SELL_PRICES, PACK_PRICES, RARITY_RANK } from "../utils/constanst";
import { useCurrency } from "../hooks/useGameCurrency";
import { useHaptics } from "../hooks/useHaptics";
import { useSwipe, touchActionFor } from "../hooks/useSwipe";
import { useToast } from "../components/ui/Toast";
import { useImmersive } from "../components/AppShell";
import PokemonCard from "../components/PokemonCard";

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
  const { coins, setCoins, spendCoins } = useCurrency();
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
  const [isPackOpen, setIsPackOpen] = useState(false);
  const [cardRevealed, setCardRevealed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [stats, setStats] = useState<any>(null);
  const [setBonus, setSetBonus] = useState<{ granted: number; sets: string[] } | null>(null);
  const [prePackIds, setPrePackIds] = useState<string[]>([]);
  const [soldInfo, setSoldInfo] = useState<{ earned: number; sold: number } | null>(null);
  const [sellingDupes, setSellingDupes] = useState(false);
  const [wishlistIds, setWishlistIds] = useState<string[]>([]);
  const [openSeries, setOpenSeries] = useState<Record<string, boolean>>({});
  const [direction, setDirection] = useState(1);
  const finishingRef = useRef(false);
  /** Elemento que captura los gestos de la carta durante la apertura. */
  const cardGestureRef = useRef<HTMLDivElement>(null);

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
  /** Las cartas anteriores a la actual ya se vieron; la actual depende del flip. */
  const revealedCount = cardRevealed ? packIndex + 1 : packIndex;
  const currentRevealed = cardRevealed || packIndex > 0;
  const showAura =
    currentRevealed && (RARITY_RANK[currentCard?.rarity] || 0) >= AURA_RANK;

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
        getProfileStats().then(setStats);
        getWishlistIds().then(setWishlistIds);
      } else {
        const localCards = getCollection();
        setUserCollectionIds(localCards.map((c: any) => c.id));
      }
    };
    syncUserData();
  }, [isSignedIn, isLoaded, setCoins]);

  useEffect(() => {
    async function loadAndSync() {
      if (!selectedSet) return;
      setLoading(true);
      try {
        const cards = await getCardsFromSet(selectedSet);
        if (cards && cards.length > 0) {
          setAllCards(cards);
          syncSetToDatabase(selectedSet, cards).catch((err) => console.error("sync:", err));
        }
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    }
    loadAndSync();
  }, [selectedSet]);

  const setsBySeries = useMemo(() => {
    const groups: Record<string, any[]> = {};
    dbSets.forEach((set) => {
      const seriesName = set.series || "Otras";
      if (!groups[seriesName]) groups[seriesName] = [];
      groups[seriesName].push(set);
    });
    return groups;
  }, [dbSets]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isPackOpen) return;
      if (e.repeat) return; // ignora auto-repeat al mantener pulsado
      if (e.code === "Space" || e.code === "ArrowRight") {
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
  }, [isPackOpen, cardRevealed, packIndex, currentPack, isSignedIn]);

  const handleSelectSet = (setId: string) => {
    setSelectedSet(setId);
    resetPackState();
  };

  const resetPackState = () => {
    setCurrentPack([]);
    setPackIndex(0);
    setIsPackOpen(false);
    setCardRevealed(false);
    setDirection(1);
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

    if (spendCoins(price)) {
      if (isSignedIn) await updateCoins(coins - price);
      setPrePackIds([...userCollectionIds]); // snapshot ANTES del sobre
      setSoldInfo(null);
      setCurrentPackType(type);
      setCurrentPack(newPack);
      setCurrentPackPrice(price);
      setPackIndex(0);
      setCardRevealed(false);
      setIsPackOpen(true);
    }
  };

  // Apertura múltiple (×N): salta animación, guarda todo, va al resumen.
  const handleBuyMulti = async (type: PackType, count = 10) => {
    if (finishingRef.current) return;
    finishingRef.current = true;
    if (!allCards || allCards.length === 0) {
      toast("Las cartas no se han cargado. Recarga la página.", "error");
      finishingRef.current = false;
      return;
    }
    const price = PACK_PRICES[type] * count;
    if (coins < price) {
      haptic("warning");
      toast(`Necesitas ${price.toLocaleString()} monedas para ×${count}`, "error");
      finishingRef.current = false; // sin esto el botón quedaba bloqueado
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

    if (spendCoins(price)) {
      if (isSignedIn) {
        await updateCoins(coins - price);
        await savePackToCollection(combined, price, count);
        const res = await claimSetCompletionBonuses();
        if (res.granted > 0) {
          setSetBonus({ granted: res.granted, sets: res.sets });
          setCoins((c) => c + res.granted);
          setTimeout(() => setSetBonus(null), 6000);
        }
        getProfileStats().then(setStats);
      } else {
        saveToCollection(combined);
      }
      setPrePackIds(ownedSnapshot);
      setUserCollectionIds((prev) => [...prev, ...combined.map((c) => c.id)]);
      setSoldInfo(null);
      setCurrentPackType(type);
      setCurrentPack(combined);
      setCurrentPackPrice(price);
      setIsPackOpen(false); // directo al resumen
      haptic("success");
    }
    finishingRef.current = false;
  };

  const finishPack = async () => {
    if (finishingRef.current) return;
    finishingRef.current = true;
    try {
      if (isSignedIn) {
        await savePackToCollection(currentPack, currentPackPrice);
        // Bonus por completar sets
        const res = await claimSetCompletionBonuses();
        if (res.granted > 0) {
          setSetBonus({ granted: res.granted, sets: res.sets });
          setCoins((c) => c + res.granted);
          setTimeout(() => setSetBonus(null), 6000);
        }
        getProfileStats().then(setStats);
      } else {
        saveToCollection(currentPack);
      }
      const newPackIds = currentPack.map((c) => c.id);
      setUserCollectionIds((prev) => [...prev, ...newPackIds]);
      haptic("success");
    } catch (err) {
      // Una caída de red al guardar no puede dejar el sobre a medias: se avisa
      // y se sale igualmente al resumen, con las cartas ya en pantalla.
      console.error("Error guardando el sobre:", err);
      toast("No se pudo guardar el sobre en la nube", "error");
    } finally {
      // Sin este finally, un fallo dejaba finishingRef en true y los botones de
      // compra bloqueados para el resto de la sesión.
      setIsPackOpen(false);
      finishingRef.current = false;
    }
  };

  const handleNextCard = async () => {
    if (!cardRevealed) {
      haptic("heavy");
      setCardRevealed(true);
      return;
    }
    if (packIndex < lastIndex) {
      const next = currentPack[packIndex + 1];
      // Las cartas siguientes salen ya reveladas: la vibración fuerte se
      // reserva para las que además encienden el aura.
      haptic((RARITY_RANK[next?.rarity] || 0) >= AURA_RANK ? "heavy" : "tap");
      setDirection(1);
      setCardRevealed(true);
      setPackIndex((prev) => prev + 1);
    } else {
      await finishPack();
    }
  };

  const handlePrevCard = () => {
    if (packIndex <= 0) return; // no hay carta anterior
    haptic("tap");
    setDirection(-1);
    setCardRevealed(true); // las anteriores ya se revelaron
    setPackIndex((prev) => prev - 1);
  };

  const handleCardTap = () => {
    // Tras un deslizamiento el navegador emite un click sintético: se ignora.
    if (didSwipeRef.current) return;
    handleNextCard();
  };

  // Gestos de la carta: izquierda/derecha para pasar, abajo para saltar al
  // resumen. El giro acompaña al arrastre para dar tacto de carta física.
  const didSwipeRef = useSwipe(cardGestureRef, {
    axis: "both",
    rotate: 6,
    enabled: isPackOpen,
    onSwipeLeft: () => handleNextCard(),
    onSwipeRight: packIndex > 0 ? () => handlePrevCard() : undefined,
    onSwipeDown: () => {
      haptic("select");
      handleRevealAll();
    },
  });

  // Revelar todo: salta animación carta por carta y va al resumen.
  const handleRevealAll = async () => {
    await finishPack();
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

  // Cartas nuevas (no estaban antes del sobre)
  const newCardsInPack = useMemo(() => {
    if (!currentPack.length) return 0;
    const before = new Set(prePackIds);
    const seen = new Set<string>();
    let count = 0;
    currentPack.forEach((c) => {
      if (!before.has(c.id) && !seen.has(c.id)) count++;
      seen.add(c.id);
    });
    return count;
  }, [currentPack, prePackIds]);

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

  // Logros derivados de stats
  const achievements = useMemo(() => {
    const s = stats || {};
    const def = [
      { id: "first", name: "Primer sobre", desc: "Abre 1 sobre", done: (s.packsOpened || 0) >= 1, icon: "📦" },
      { id: "collector", name: "Coleccionista", desc: "100 cartas únicas", done: (s.totalUnique || 0) >= 100, icon: "🗂️" },
      { id: "hunter", name: "Cazador raro", desc: "10 cartas raras (IR+)", done: (s.rareHits || 0) >= 10, icon: "💎" },
      { id: "rich", name: "Millonario", desc: "Colección por 10.000", done: (s.totalValue || 0) >= 10000, icon: "💰" },
      { id: "setdone", name: "Maestro de set", desc: "Completa 1 set", done: (s.setsCompleted || 0) >= 1, icon: "🏆" },
      { id: "veteran", name: "Veterano", desc: "Abre 100 sobres", done: (s.packsOpened || 0) >= 100, icon: "⭐" },
    ];
    return def;
  }, [stats]);
  const achievementsDone = achievements.filter((a) => a.done).length;

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
    const res = await sellPackDuplicates(dupeIdsInPack);
    setSellingDupes(false);
    if (res.earned > 0) {
      setCoins((c) => c + res.earned);
      setSoldInfo(res);
      getProfileStats().then(setStats);
    }
  };

  return (
    <div className="flex flex-col items-center select-none w-full">
      {/* SET COMPLETION BONUS TOAST */}
      <AnimatePresence>
        {setBonus && setBonus.granted > 0 && (
          <motion.div
            initial={{ opacity: 0, y: -20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -20 }}
            className="fixed top-24 left-1/2 -translate-x-1/2 z-[200] bg-yellow-500/15 border border-yellow-500/30 backdrop-blur-xl px-6 py-4 rounded-2xl text-center max-w-sm"
          >
            <p className="text-sm font-semibold" style={{ color: "var(--warn)" }}>¡Set completado!</p>
            <p className="text-xs ink-soft mt-1">
              {setBonus.sets.join(", ")} · +{setBonus.granted.toLocaleString()} monedas
            </p>
          </motion.div>
        )}
      </AnimatePresence>

      {/* DASHBOARD (signed-in) — panel unificado */}
      {!selectedSet && isSignedIn && stats && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
          className="w-full mb-10 relative z-10"
        >
          <div className="surface rounded-3xl p-5 md:p-6 overflow-hidden relative">
            <div className="absolute -top-20 -right-20 w-56 h-56 rounded-full blur-3xl pointer-events-none" style={{ background: "radial-gradient(circle, color-mix(in srgb, var(--accent) 22%, transparent), transparent 70%)" }} />

            <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-5 relative">
              <div>
                <p className="text-[10px] uppercase tracking-[0.3em] ink-faint">Valor de tu colección</p>
                <p className="text-3xl md:text-4xl font-bold text-gradient mt-1 tabular-nums">
                  {stats.totalValue.toLocaleString()}
                  <span className="text-base ink-faint font-normal ml-2">monedas</span>
                </p>
              </div>
              <div className="grid grid-cols-3 gap-2 md:gap-3 md:w-auto">
                {[
                  { label: "Cartas", value: stats.totalCards },
                  { label: "Únicas", value: stats.totalUnique },
                  { label: "Sets", value: `${stats.setsCompleted}/${stats.setsTotal}` },
                ].map((s) => (
                  <div key={s.label} className="surface-2 rounded-2xl px-3 md:px-5 py-2.5 text-center md:text-left">
                    <p className="text-[9px] uppercase tracking-wider ink-faint">{s.label}</p>
                    <p className="text-base md:text-xl font-bold tabular-nums mt-0.5">{s.value}</p>
                  </div>
                ))}
              </div>
            </div>

            {/* Logros compactos */}
            <div className="mt-5 pt-4 border-t border-[var(--border)] flex items-center gap-3">
              <span className="text-[10px] uppercase tracking-wider ink-faint shrink-0 hidden sm:inline">
                Logros {achievementsDone}/{achievements.length}
              </span>
              <div className="flex gap-2 overflow-x-auto no-scrollbar pb-1 flex-1">
                {achievements.map((ach) => (
                  <div
                    key={ach.id}
                    title={`${ach.name} — ${ach.desc}`}
                    className={`shrink-0 w-9 h-9 rounded-xl flex items-center justify-center text-lg border transition ${
                      ach.done ? "ring-accent border-transparent" : "surface-2 grayscale opacity-40"
                    }`}
                  >
                    {ach.icon}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </motion.div>
      )}

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
          className="w-full max-w-6xl flex flex-col gap-4 pb-24 relative z-10"
        >
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
                    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 md:gap-4 pt-3">
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
            className="mb-5 md:mb-10 ink-soft hover:ink transition flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] chip px-4 py-2 press"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
              <path d="m15 18-6-6 6-6" />
            </svg>
            Volver
          </button>

          {currentSetObj?.images?.logo && (
            <img src={currentSetObj.images.logo} alt={currentSetObj.name} className="h-14 md:h-20 object-contain mb-5 md:mb-10 opacity-90" />
          )}

          {/* En móvil, carrusel horizontal con anclaje: los tres sobres caben
              "en la misma línea" y se pasan deslizando, en vez de apilarse en
              una columna kilométrica. En md+ vuelve a ser una rejilla. */}
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
                />
              </>
            )}
          </div>

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
          className="fixed inset-0 z-[120] flex flex-col items-center overflow-hidden"
          style={{
            height: "var(--app-height)",
            paddingTop: "var(--sat)",
            paddingBottom: "var(--sab)",
            background: "var(--bg)",
          }}
        >
          {/* AURA de rareza a pantalla completa (sólo en revelaciones buenas) */}
          <AnimatePresence>
            {showAura && (
              <motion.div
                key={`aura-${packIndex}`}
                initial={{ opacity: 0 }}
                animate={{ opacity: [0, 0.9, 0.55] }}
                exit={{ opacity: 0 }}
                transition={{ duration: 1.2, ease: "easeOut" }}
                className="pointer-events-none absolute inset-0 z-0"
                style={{
                  background:
                    "radial-gradient(circle at 50% 48%, color-mix(in srgb, var(--accent) 45%, transparent), color-mix(in srgb, var(--accent-2) 14%, transparent) 45%, transparent 72%)",
                }}
              />
            )}
          </AnimatePresence>

          {/* CABECERA (56px): salir + progreso segmentado + contador */}
          <div className="w-full max-w-2xl h-14 shrink-0 flex items-center gap-3 px-3 md:px-4 relative z-20">
            <button
              onClick={handleRevealAll}
              aria-label="Guardar el sobre y salir"
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
                    animate={{ scaleX: i < revealedCount ? 1 : 0 }}
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
          </div>

          {/* ZONA DE CARTA */}
          <div className="relative flex-1 w-full flex items-center justify-center px-4">
            {currentPackType === "GOLDEN" && packIndex === lastIndex && (
              <motion.div
                initial={{ opacity: 0, y: -20 }}
                animate={{ opacity: 1, y: 0 }}
                className="absolute top-1 left-0 right-0 text-center accent text-[10px] md:text-xs font-semibold tracking-[0.3em] uppercase z-20"
              >
                Carta garantizada
              </motion.div>
            )}

            {/* El gesto va con useSwipe (eventos de puntero) y no con el drag
                de framer: así el arrastre se pinta escribiendo el transform,
                sin re-render por movimiento, y sigue el dedo con fidelidad. */}
            <div
              ref={cardGestureRef}
              onClick={handleCardTap}
              className="relative z-20 cursor-pointer select-none"
              style={{
                width: CARD_WIDTH,
                touchAction: touchActionFor("both"),
                willChange: "transform",
              }}
            >
              {/* la perspectiva va en el padre directo de la carta animada */}
              <div className="relative w-full aspect-[2.5/3.5] perspective-1000">
                <AnimatePresence mode="wait" custom={direction}>
                  <motion.div
                    key={packIndex}
                    custom={direction}
                    variants={cardVariants}
                    initial="enter"
                    animate="center"
                    exit="exit"
                    transition={{ type: "spring", stiffness: 200, damping: 25 }}
                    className="absolute inset-0"
                  >
                    {!userCollectionIds.includes(currentCard.id) && cardRevealed && (
                      <motion.div
                        initial={{ scale: 0, x: -20 }}
                        animate={{ scale: 1, x: 0 }}
                        transition={{ type: "spring", bounce: 0.5 }}
                        className="absolute -top-3 -left-3 z-50 bg-emerald-500 text-white text-[10px] font-bold px-3 py-1 rounded-full uppercase tracking-wider shadow-lg"
                      >
                        Nueva
                      </motion.div>
                    )}
                    <PokemonCard card={currentCard} reveal={currentRevealed} useHighRes={true} />
                  </motion.div>
                </AnimatePresence>
              </div>
            </div>
          </div>

          {/* PIE (96px): texto contextual + acciones */}
          <div className="w-full max-w-2xl h-24 shrink-0 flex flex-col items-center justify-center gap-3 px-4 relative z-20">
            <p className="ink-faint text-[11px] uppercase tracking-[0.2em] text-center">
              {!cardRevealed
                ? "Toca la carta para darle la vuelta"
                : packIndex < lastIndex
                  ? "Desliza o toca para continuar"
                  : "Toca para guardar el sobre"}
            </p>
            <div className="flex items-center justify-center gap-2 w-full">
              <button
                onClick={handleNextCard}
                className="btn-accent press touch-target px-6 py-2.5 rounded-xl text-sm font-semibold"
              >
                Siguiente <kbd className="ml-1 text-[10px] opacity-70 hidden sm:inline">espacio</kbd>
              </button>
              <button
                onClick={handleRevealAll}
                className="ink-soft hover:ink press touch-target px-4 py-2.5 rounded-xl text-sm font-medium transition flex items-center gap-2"
              >
                Revelar todo
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
                  <path d="m13 17 5-5-5-5M6 17l5-5-5-5" />
                </svg>
              </button>
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
                  {sellingDupes ? "Vendiendo..." : `Vender ${dupeIdsInPack.length} repetidas (+${dupeValue})`}
                </button>
              )}
              {soldInfo && (
                <span className="text-emerald-300 text-sm font-medium px-3 py-2.5">
                  +{soldInfo.earned} por {soldInfo.sold} repetidas
                </span>
              )}
              <button onClick={() => setCurrentPack([])} className="btn-ghost press px-5 py-2.5 rounded-xl text-sm font-medium">
                Abrir otro
              </button>
              <button onClick={handleBackToMenu} className="btn-accent press px-6 py-2.5 rounded-xl text-sm font-semibold">
                Finalizar
              </button>
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

          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4 md:gap-6 w-full">
            {currentPack.map((card, index) => {
              const isNew = !prePackIds.includes(card.id);
              return (
                <motion.div
                  key={index}
                  initial={{ opacity: 0, y: 15 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: index * 0.04 }}
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
                  <PokemonCard card={card} reveal={true} useHighRes={true} interactive={false} />
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
}

function PackCard({ accent, badge, title, description, price, icon, onClick, onMulti, multiCount = 10, odds }: PackCardProps) {
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
          <summary className="chip ink-faint cursor-pointer list-none rounded-lg px-3 py-1.5 text-center text-[10px] font-semibold tracking-wide uppercase [&::-webkit-details-marker]:hidden">
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
        <button onClick={onClick} className={`${a.btn} press font-semibold py-2.5 px-6 rounded-xl w-full text-center transition text-sm`}>
          {price.toLocaleString()} monedas
        </button>
        {onMulti && (
          <button onClick={onMulti} className="press btn-ghost font-medium py-2 px-6 rounded-xl w-full text-center transition text-xs">
            Abrir ×{multiCount} · {(price * multiCount).toLocaleString()}
          </button>
        )}
      </div>
    </motion.div>
  );
}
