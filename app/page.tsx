"use client";

import { useUser } from "@clerk/nextjs";
import { AnimatePresence, motion } from "framer-motion";
import { useState, useEffect, useMemo } from "react";
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
import PokemonCard from "../components/PokemonCard";
import BackgroundParticles from "../components/BackgroundParticles";
import AppHeader from "../components/AppHeader";

type PackType = "STANDARD" | "PREMIUM" | "GOLDEN" | "SPECIAL";

export default function Home() {
  const { coins, setCoins, spendCoins } = useCurrency();
  const { isSignedIn, isLoaded } = useUser();

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
  const [showAchievements, setShowAchievements] = useState(false);

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
      if (e.code === "Space" && isPackOpen) {
        e.preventDefault();
        handleNextCard();
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
  };

  const handleBuyPack = async (type: PackType) => {
    if (!allCards || allCards.length === 0) {
      alert("Las cartas no se han cargado. Recarga la página.");
      return;
    }
    const price = PACK_PRICES[type];
    if (coins < price) { alert("No tienes suficientes monedas"); return; }

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
    if (!allCards || allCards.length === 0) {
      alert("Las cartas no se han cargado. Recarga la página.");
      return;
    }
    const price = PACK_PRICES[type] * count;
    if (coins < price) { alert(`Necesitas ${price} monedas para ×${count}`); return; }

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
    }
  };

  const finishPack = async () => {
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
    setIsPackOpen(false);
  };

  const handleNextCard = async () => {
    if (!cardRevealed) {
      setCardRevealed(true);
      return;
    }
    if (packIndex < 9) {
      setCardRevealed(true);
      setPackIndex((prev) => prev + 1);
    } else {
      await finishPack();
    }
  };

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
    <main className="flex min-h-screen flex-col items-center p-4 md:p-8 bg-[#050505] text-[#ededed] overflow-hidden select-none">
      <BackgroundParticles />

      <AppHeader />

      {/* SET COMPLETION BONUS TOAST */}
      <AnimatePresence>
        {setBonus && setBonus.granted > 0 && (
          <motion.div
            initial={{ opacity: 0, y: -20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -20 }}
            className="fixed top-24 left-1/2 -translate-x-1/2 z-[200] bg-yellow-500/15 border border-yellow-500/30 backdrop-blur-xl px-6 py-4 rounded-2xl text-center max-w-sm"
          >
            <p className="text-yellow-300 text-sm font-semibold">¡Set completado!</p>
            <p className="text-xs text-gray-300 mt-1">
              {setBonus.sets.join(", ")} · +{setBonus.granted.toLocaleString()} monedas
            </p>
          </motion.div>
        )}
      </AnimatePresence>

      {/* HERO STATS (signed-in) */}
      {!selectedSet && isSignedIn && stats && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="w-full max-w-6xl grid grid-cols-2 md:grid-cols-4 gap-3 mb-12 relative z-10"
        >
          {[
            { label: "Cartas totales", value: stats.totalCards, accent: "text-white" },
            { label: "Únicas", value: stats.totalUnique, accent: "text-blue-300" },
            { label: "Sets completos", value: `${stats.setsCompleted}/${stats.setsTotal}`, accent: "text-emerald-300" },
            { label: "Valor colección", value: stats.totalValue.toLocaleString(), accent: "text-yellow-300" },
          ].map((s) => (
            <div key={s.label} className="surface rounded-2xl p-4">
              <p className="text-gray-500 text-[10px] font-medium uppercase tracking-wider">{s.label}</p>
              <p className={`text-xl md:text-2xl font-semibold mt-1 ${s.accent} tabular-nums`}>{s.value}</p>
            </div>
          ))}
        </motion.div>
      )}

      {/* ACHIEVEMENTS (signed-in) */}
      {!selectedSet && isSignedIn && stats && (
        <div className="w-full max-w-6xl mb-12 relative z-10">
          <button
            onClick={() => setShowAchievements((v) => !v)}
            className="w-full surface surface-hover rounded-2xl px-5 py-4 flex justify-between items-center"
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-white/5 border border-white/5 flex items-center justify-center">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-5 h-5 text-yellow-400">
                  <circle cx="12" cy="8" r="6" /><path d="M15.477 12.89 17 22l-5-3-5 3 1.523-9.11" />
                </svg>
              </div>
              <div className="text-left">
                <h3 className="font-semibold text-sm text-white">Logros</h3>
                <p className="text-xs text-gray-500">{achievementsDone}/{achievements.length} desbloqueados</p>
              </div>
            </div>
            <motion.svg
              animate={{ rotate: showAchievements ? 180 : 0 }}
              viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
              className="w-4 h-4 text-gray-400"
            >
              <path d="m6 9 6 6 6-6" />
            </motion.svg>
          </button>

          <AnimatePresence>
            {showAchievements && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
                className="overflow-hidden"
              >
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mt-3">
                  {achievements.map((ach) => (
                    <div
                      key={ach.id}
                      className={`surface rounded-2xl p-4 flex items-center gap-3 ${ach.done ? "border border-yellow-500/20" : "opacity-50"}`}
                    >
                      <span className={`text-2xl ${ach.done ? "" : "grayscale"}`}>{ach.icon}</span>
                      <div className="min-w-0">
                        <p className={`text-sm font-medium truncate ${ach.done ? "text-white" : "text-gray-400"}`}>{ach.name}</p>
                        <p className="text-[10px] text-gray-500 truncate">{ach.desc}</p>
                      </div>
                      {ach.done && (
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4 text-emerald-400 ml-auto shrink-0">
                          <path d="M20 6 9 17l-5-5" />
                        </svg>
                      )}
                    </div>
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}

      {/* VIEW 1: SET SELECTION */}
      {!selectedSet && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="w-full max-w-6xl flex flex-col gap-16 pb-24 relative z-10"
        >
          {Object.entries(setsBySeries).map(([seriesName, sets], idx) => (
            <motion.div
              key={seriesName}
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: idx * 0.08, duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
              className="flex flex-col gap-6"
            >
              <div className="flex items-center gap-6">
                <h2 className="text-xs font-medium text-gray-400 uppercase tracking-[0.3em]">{seriesName}</h2>
                <div className="h-px bg-white/5 flex-1"></div>
                <span className="text-xs text-gray-600 font-mono">{sets.length}</span>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 md:gap-4">
                {sets.map((set) => (
                  <motion.button
                    key={set.id}
                    whileHover={{ y: -4 }}
                    whileTap={{ scale: 0.96 }}
                    transition={{ duration: 0.2 }}
                    onClick={() => handleSelectSet(set.id)}
                    className="group surface surface-hover p-5 md:p-7 rounded-2xl flex flex-col items-center gap-4 overflow-hidden"
                  >
                    {set.images?.logo ? (
                      <img
                        src={set.images.logo}
                        alt={set.name}
                        className="h-12 md:h-16 object-contain group-hover:scale-105 transition-transform duration-500 opacity-90 group-hover:opacity-100"
                      />
                    ) : (
                      <div className="h-12 md:h-16 flex items-center text-gray-600 text-xs">{set.name}</div>
                    )}
                    <span className="font-medium text-[10px] md:text-xs text-gray-500 group-hover:text-gray-200 transition-colors text-center tracking-wide truncate w-full">
                      {set.name}
                    </span>
                  </motion.button>
                ))}
              </div>
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
            className="mb-12 text-gray-500 hover:text-gray-200 transition flex items-center gap-2 text-xs font-medium uppercase tracking-[0.2em]"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
              <path d="m15 18-6-6 6-6" />
            </svg>
            Volver
          </button>

          {currentSetObj?.images?.logo && (
            <img src={currentSetObj.images.logo} alt={currentSetObj.name} className="h-16 md:h-20 object-contain mb-12 opacity-90" />
          )}

          <div className={`grid grid-cols-1 ${isSpecialSet ? "max-w-md" : "md:grid-cols-3"} gap-4 md:gap-6 w-full px-2`}>
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
                className="fixed inset-0 bg-[#050505]/90 z-[100] flex flex-col items-center justify-center backdrop-blur-xl"
              >
                <div className="w-10 h-10 border-2 border-white/20 border-t-white rounded-full animate-spin mb-6"></div>
                <h2 className="text-xs font-medium text-gray-500 tracking-[0.3em] uppercase">Preparando cartas</h2>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      )}

      {/* VIEW 3: PACK OPENING */}
      {isPackOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="w-full max-w-6xl flex flex-col items-center relative min-h-[70vh] justify-center z-10"
        >
          <div className="relative w-full h-[450px] flex justify-center items-center perspective-1000">
            <AnimatePresence mode="wait">
              <motion.div
                key={packIndex}
                initial={{ x: 120, opacity: 0, rotateY: 60, scale: 0.92 }}
                animate={{ x: 0, opacity: 1, rotateY: 0, scale: 1 }}
                exit={{ x: -120, opacity: 0, rotateY: -60, scale: 0.92 }}
                transition={{ type: "spring", stiffness: 200, damping: 25 }}
                className="absolute z-20 w-56 sm:w-72 aspect-[2.5/3.5] cursor-pointer"
                onClick={handleNextCard}
              >
                <div className="w-full h-full relative">
                  {!userCollectionIds.includes(currentPack[packIndex].id) && cardRevealed && (
                    <motion.div
                      initial={{ scale: 0, x: -20 }}
                      animate={{ scale: 1, x: 0 }}
                      transition={{ type: "spring", bounce: 0.5 }}
                      className="absolute -top-3 -left-3 z-50 bg-emerald-500 text-white text-[10px] font-bold px-3 py-1 rounded-full uppercase tracking-wider shadow-lg"
                    >
                      Nueva
                    </motion.div>
                  )}
                  <PokemonCard card={currentPack[packIndex]} reveal={cardRevealed || packIndex > 0} useHighRes={true} />
                </div>
              </motion.div>
            </AnimatePresence>

            {currentPackType === "GOLDEN" && packIndex === 9 && (
              <motion.div
                initial={{ opacity: 0, y: -20 }}
                animate={{ opacity: 1, y: 0 }}
                className="absolute top-[-40px] text-yellow-400 text-xs font-semibold tracking-[0.3em] uppercase"
              >
                Carta garantizada
              </motion.div>
            )}

            <div className="absolute -bottom-16 text-gray-500 font-mono text-xs tracking-[0.3em] uppercase">
              {packIndex + 1} / {currentPack.length}
            </div>
          </div>

          <div className="mt-24 flex flex-wrap items-center justify-center gap-3 px-4">
            <button
              onClick={handleNextCard}
              className="btn-ghost text-white px-5 py-2.5 rounded-xl text-sm font-medium"
            >
              Siguiente <kbd className="ml-1 text-[10px] opacity-60 hidden sm:inline">espacio</kbd>
            </button>
            <button
              onClick={handleRevealAll}
              className="text-gray-500 hover:text-gray-200 px-4 py-2.5 rounded-xl text-sm font-medium transition flex items-center gap-2"
            >
              Revelar todo
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
                <path d="m13 17 5-5-5-5M6 17l5-5-5-5" />
              </svg>
            </button>
          </div>
        </motion.div>
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
              <h2 className="text-2xl font-semibold text-white tracking-wide">Resumen</h2>
              <p className="text-xs text-gray-500 mt-1">
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
              <button onClick={() => setCurrentPack([])} className="btn-ghost text-white px-5 py-2.5 rounded-xl text-sm font-medium">
                Abrir otro
              </button>
              <button onClick={handleBackToMenu} className="btn-primary px-5 py-2.5 rounded-xl text-sm font-medium">
                Finalizar
              </button>
            </div>
          </div>

          {/* DESGLOSE POR RAREZA */}
          <div className="w-full flex flex-wrap gap-2 mb-8">
            {rarityBreakdown.map(([rarity, count]) => (
              <span
                key={rarity}
                className="bg-white/5 border border-white/5 rounded-full px-3 py-1 text-[11px] text-gray-400"
              >
                {count}× <span className="text-gray-300">{rarity}</span>
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
                <h3 className="text-base md:text-lg font-semibold text-white truncate">{bestPull.name}</h3>
                <p className="text-[11px] md:text-xs text-gray-500">{bestPull.rarity}</p>
              </div>
              <div className="text-right shrink-0">
                <p className="text-gray-500 text-[9px] md:text-[10px] uppercase tracking-wider">Valor</p>
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
                  <PokemonCard card={card} reveal={true} useHighRes={true} />
                </motion.div>
              );
            })}
          </div>
        </motion.div>
      )}
    </main>
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
  const accents: Record<string, { border: string; iconColor: string; btn: string; badgeBg: string }> = {
    white: {
      border: "border-white/5",
      iconColor: "text-gray-400",
      btn: "btn-ghost text-white",
      badgeBg: "bg-white/10 text-gray-300",
    },
    purple: {
      border: "border-purple-500/20",
      iconColor: "text-purple-400",
      btn: "bg-purple-600 hover:bg-purple-500 text-white",
      badgeBg: "bg-purple-500/15 text-purple-300",
    },
    yellow: {
      border: "border-yellow-500/20",
      iconColor: "text-yellow-400",
      btn: "bg-yellow-500 hover:bg-yellow-400 text-black",
      badgeBg: "bg-yellow-500/15 text-yellow-300",
    },
    blue: {
      border: "border-blue-500/20",
      iconColor: "text-blue-400",
      btn: "bg-blue-600 hover:bg-blue-500 text-white",
      badgeBg: "bg-blue-500/15 text-blue-300",
    },
  };
  const a = accents[accent];

  return (
    <motion.div
      whileHover={{ y: -6 }}
      transition={{ duration: 0.25 }}
      className={`bg-[#111] ${a.border} border rounded-3xl p-6 md:p-8 flex flex-col items-center group relative overflow-hidden text-left`}
    >
      {badge && (
        <div className={`absolute top-0 left-0 right-0 ${a.badgeBg} text-[10px] uppercase font-semibold text-center py-1.5 tracking-[0.25em]`}>
          {badge}
        </div>
      )}
      <div className={`${a.iconColor} mb-6 md:mb-8 ${badge ? "mt-6" : ""} group-hover:scale-110 transition-transform duration-500`}>
        {icon}
      </div>
      <h3 className="text-lg md:text-xl font-semibold text-white mb-2 md:mb-3">{title}</h3>
      <p className="text-[11px] md:text-xs text-gray-500 text-center mb-4 leading-relaxed">{description}</p>

      {odds && odds.length > 0 && (
        <div className="w-full mb-5 bg-white/[0.03] border border-white/5 rounded-xl p-3 space-y-1">
          {odds.map(([label, pct]) => (
            <div key={label} className="flex justify-between text-[10px]">
              <span className="text-gray-500">{label}</span>
              <span className={`font-mono ${a.iconColor}`}>{pct}</span>
            </div>
          ))}
        </div>
      )}

      <div className="mt-auto w-full flex flex-col gap-2">
        <button
          onClick={onClick}
          className={`${a.btn} press font-medium py-2.5 px-6 rounded-xl w-full text-center transition text-sm`}
        >
          {price.toLocaleString()} monedas
        </button>
        {onMulti && (
          <button
            onClick={onMulti}
            className="press bg-white/5 hover:bg-white/10 border border-white/5 text-gray-300 font-medium py-2 px-6 rounded-xl w-full text-center transition text-xs"
          >
            Abrir ×{multiCount} · {(price * multiCount).toLocaleString()}
          </button>
        )}
      </div>
    </motion.div>
  );
}
