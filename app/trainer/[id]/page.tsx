"use client";

import { useEffect, useState, useMemo } from "react";
import { useParams } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { useUser } from "@clerk/nextjs";
import { getTrainerCollection, getSetsFromDB } from "../../action";
import { RARITY_RANK, SELL_PRICES } from "../../../utils/constanst";
import PokemonCard from "../../../components/PokemonCard";
import AppHeader from "../../../components/AppHeader";
import BackgroundParticles from "../../../components/BackgroundParticles";
import Loader from "../../../components/Loader";
import CardDetailModal from "../../../components/CardDetailModal";

export default function TrainerProfilePage() {
  const params = useParams();
  const trainerId = params.id as string;
  const { isLoaded } = useUser();
  const [cards, setCards] = useState<any[]>([]);
  const [dbSets, setDbSets] = useState<any[]>([]);
  const [showStats, setShowStats] = useState(false);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [sortBy, setSortBy] = useState("rarity_desc");
  const [filterSet, setFilterSet] = useState("all");
  const [filterRarity, setFilterRarity] = useState("all");
  const [selectedCard, setSelectedCard] = useState<any | null>(null);

  const rarityOptions = useMemo(() => {
    const set = new Set<string>();
    cards.forEach((c) => c.rarity && set.add(c.rarity));
    return Array.from(set).sort((a, b) => (RARITY_RANK[b] || 0) - (RARITY_RANK[a] || 0));
  }, [cards]);

  useEffect(() => {
    async function init() {
      if (!trainerId) return;
      setLoading(true);
      const sets = await getSetsFromDB();
      setDbSets(sets);
      try {
        const trainerCards = await getTrainerCollection(trainerId);
        setCards(trainerCards);
      } catch (e) { console.error(e); }
      setLoading(false);
    }
    init();
  }, [trainerId]);

  const setStats = useMemo(() => dbSets.map((set) => {
    const owned = cards.filter((c) => c.id.startsWith(set.id + "-")).length;
    const total = set.total || 1;
    const percentage = Math.min(100, Math.round((owned / total) * 100));
    return { ...set, logo: set.images?.logo || "", owned, percentage };
  }), [cards, dbSets]);

  const processedCards = useMemo(() => {
    let result = [...cards];
    if (searchTerm) result = result.filter((c) => c.name.toLowerCase().includes(searchTerm.toLowerCase()));
    if (filterSet !== "all") result = result.filter((c) => c.id.startsWith(filterSet));
    if (filterRarity !== "all") result = result.filter((c) => c.rarity === filterRarity);
    result.sort((a, b) => {
      if (a.is_favorite && !b.is_favorite) return -1;
      if (!a.is_favorite && b.is_favorite) return 1;
      switch (sortBy) {
        case "name_asc": return a.name.localeCompare(b.name);
        case "quantity_desc": return (b.quantity || 1) - (a.quantity || 1);
        case "rarity_desc": return (RARITY_RANK[b.rarity] || 0) - (RARITY_RANK[a.rarity] || 0);
        default: return 0;
      }
    });
    return result;
  }, [cards, searchTerm, filterSet, filterRarity, sortBy]);

  const getPrice = (rarity: string) => SELL_PRICES[rarity] || 10;

  if (loading || !isLoaded) return <Loader label="Cargando entrenador" />;

  return (
    <main className="flex min-h-screen flex-col items-center p-4 md:p-8 bg-[#050505] text-[#ededed] select-none overflow-hidden">
      <BackgroundParticles />
      <AppHeader back={{ href: "/friends" }} title="Álbum de amigo" subtitle={trainerId} showCollectionLink={false} />

      <div className="w-full max-w-7xl flex flex-col gap-6 pb-24 relative z-10">
        <div>
          <button
            onClick={() => setShowStats(!showStats)}
            className="w-full surface surface-hover rounded-2xl px-5 py-4 flex justify-between items-center"
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-white/5 border border-white/5 flex items-center justify-center">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-5 h-5 text-blue-400">
                  <path d="M3 3v18h18" /><path d="M7 14l4-4 4 4 6-6" />
                </svg>
              </div>
              <div className="text-left">
                <h3 className="font-semibold text-sm text-white">Progreso del entrenador</h3>
                <p className="text-xs text-gray-500">{showStats ? "Ocultar detalles" : "Ver por expansión"}</p>
              </div>
            </div>
            <motion.svg
              animate={{ rotate: showStats ? 180 : 0 }}
              viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
              className="w-4 h-4 text-gray-400"
            >
              <path d="m6 9 6 6 6-6" />
            </motion.svg>
          </button>

          <AnimatePresence>
            {showStats && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                className="overflow-hidden"
              >
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 mt-3">
                  {setStats.map((stat) => (
                    <div key={stat.id} className="surface rounded-2xl p-4">
                      <div className="flex items-center gap-3 mb-3">
                        {stat.logo && <img src={stat.logo} alt={stat.name} className="h-7 object-contain opacity-90" />}
                        <div className="flex-1 min-w-0">
                          <h3 className="font-medium text-sm text-gray-200 truncate">{stat.name}</h3>
                          <p className="text-[10px] text-gray-500 font-mono">{stat.owned}/{stat.total}</p>
                        </div>
                        <span className="text-xs font-semibold text-gray-400">{stat.percentage}%</span>
                      </div>
                      <div className="w-full h-1.5 bg-white/5 rounded-full overflow-hidden">
                        <div className={stat.percentage === 100 ? "progress-bar h-full" : "progress-bar-blue h-full"} style={{ width: `${stat.percentage}%` }} />
                      </div>
                    </div>
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <div className="surface rounded-2xl px-3 py-3 flex flex-wrap gap-2 items-center">
          <div className="flex items-center gap-2 bg-white/5 px-3 py-2 rounded-xl border border-white/5 flex-1 min-w-[180px]">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4 text-gray-500">
              <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
            </svg>
            <input
              type="text" placeholder="Buscar..."
              value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)}
              className="bg-transparent text-white outline-none text-sm flex-1 placeholder:text-gray-600"
            />
          </div>
          <select value={filterSet} onChange={(e) => setFilterSet(e.target.value)} className="bg-white/5 hover:bg-white/10 text-white px-3 py-2 rounded-xl border border-white/5 text-xs cursor-pointer">
            <option value="all" className="bg-[#111]">Todas</option>
            {dbSets.map((set) => <option key={set.id} value={set.id} className="bg-[#111]">{set.name}</option>)}
          </select>
          <select value={filterRarity} onChange={(e) => setFilterRarity(e.target.value)} className="bg-white/5 hover:bg-white/10 text-white px-3 py-2 rounded-xl border border-white/5 text-xs cursor-pointer">
            <option value="all" className="bg-[#111]">Toda rareza</option>
            {rarityOptions.map((r) => <option key={r} value={r} className="bg-[#111]">{r}</option>)}
          </select>
          <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} className="bg-white/5 hover:bg-white/10 text-white px-3 py-2 rounded-xl border border-white/5 text-xs cursor-pointer">
            <option value="rarity_desc" className="bg-[#111]">Rareza</option>
            <option value="quantity_desc" className="bg-[#111]">Cantidad</option>
            <option value="name_asc" className="bg-[#111]">Nombre</option>
          </select>
        </div>

        {processedCards.length === 0 ? (
          <div className="surface rounded-2xl py-20 text-center text-gray-500 text-sm">Este entrenador no tiene cartas.</div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4 md:gap-6">
            {processedCards.map((card, idx) => (
              <motion.div
                key={card.id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: Math.min(idx * 0.015, 0.5) }}
                className="relative group cursor-zoom-in"
                onClick={() => setSelectedCard(card)}
              >
                {card.quantity > 1 && (
                  <div className="absolute -top-2 -right-2 z-30 bg-white text-black text-[10px] font-bold w-6 h-6 flex items-center justify-center rounded-full border border-white/20 shadow-lg">
                    {card.quantity}
                  </div>
                )}
                {card.is_favorite && (
                  <div className="absolute -top-2 -left-2 z-30 bg-rose-500 w-5 h-5 rounded-full flex items-center justify-center shadow-lg">
                    <svg viewBox="0 0 24 24" fill="white" className="w-3 h-3">
                      <path d="M12 21s-7-4.5-9.5-9A5.5 5.5 0 0 1 12 5.5 5.5 5.5 0 0 1 21.5 12c-2.5 4.5-9.5 9-9.5 9z" />
                    </svg>
                  </div>
                )}
                <div className="transition transform group-hover:-translate-y-1 duration-300 pointer-events-none">
                  <PokemonCard card={card} reveal={true} />
                </div>
                <div className="mt-2 flex justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-300">
                  <span className="text-[10px] text-gray-500 bg-white/5 px-2 py-1 rounded-full border border-white/5">
                    {card.quantity > 1 ? `${card.quantity} copias` : "Única"}
                  </span>
                </div>
              </motion.div>
            ))}
          </div>
        )}
      </div>

      <CardDetailModal card={selectedCard} onClose={() => setSelectedCard(null)} readOnly />
    </main>
  );
}
