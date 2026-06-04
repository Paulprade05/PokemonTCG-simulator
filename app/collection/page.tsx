"use client";

import { useEffect, useState, useMemo } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useUser } from "@clerk/nextjs";
import {
  getFullCollection,
  sellCardAction,
  toggleFavorite,
  sellAllDuplicatesAction,
  getSetsFromDB,
} from "../action";
import { getCollection, saveCollectionRaw } from "../../utils/storage";
import { useCurrency } from "../../hooks/useGameCurrency";
import { RARITY_RANK, SELL_PRICES } from "../../utils/constanst";
import PokemonCard from "../../components/PokemonCard";
import AppHeader from "../../components/AppHeader";
import BackgroundParticles from "../../components/BackgroundParticles";
import Loader from "../../components/Loader";
import CardDetailModal from "../../components/CardDetailModal";
import Link from "next/link";

export default function CollectionPage() {
  const { isSignedIn, isLoaded } = useUser();
  const [cards, setCards] = useState<any[]>([]);
  const [dbSets, setDbSets] = useState<any[]>([]);
  const { coins, addCoins } = useCurrency();
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
    async function initCollection() {
      if (!isLoaded) return;
      setLoading(true);
      const sets = await getSetsFromDB();
      setDbSets(sets);
      if (isSignedIn) {
        try {
          const dbCards = await getFullCollection();
          setCards(dbCards);
        } catch (error) {
          console.error("Error cargando colección:", error);
        }
      } else {
        setCards(getCollection());
      }
      setLoading(false);
    }
    initCollection();
  }, [isSignedIn, isLoaded]);

  const setStats = useMemo(() => {
    return dbSets.map((set) => {
      const uniqueCardsOwned = cards.filter((c) => c.id.startsWith(set.id + "-")).length;
      const totalInSet = set.total || 1;
      const percentage = Math.min(100, Math.round((uniqueCardsOwned / totalInSet) * 100));
      const missing = Math.max(0, totalInSet - uniqueCardsOwned);
      const logoUrl = set.images?.logo || "";
      return { ...set, logo: logoUrl, owned: uniqueCardsOwned, percentage, missing };
    });
  }, [cards, dbSets]);

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

  const handleSellCard = async (e: React.MouseEvent, cardId: string, rarity: string) => {
    e.stopPropagation();
    const card = cards.find((c) => c.id === cardId);
    if (!card || card.quantity <= 1) return;
    const price = getPrice(rarity);
    const updatedCards = cards.map((c) => (c.id === cardId ? { ...c, quantity: c.quantity - 1 } : c));
    setCards(updatedCards);
    addCoins(price);
    if (isSignedIn) await sellCardAction(cardId, price);
    else saveCollectionRaw(updatedCards);
  };

  const handleSellAllDuplicates = async () => {
    const duplicates = cards.filter((card) => card.quantity > 1 && !card.is_favorite);
    if (duplicates.length === 0) {
      alert("No tienes duplicados (o están protegidos como favoritas).");
      return;
    }
    let totalGanancias = 0;
    duplicates.forEach((card) => { totalGanancias += (card.quantity - 1) * getPrice(card.rarity); });
    if (!confirm(`¿Vender todos los duplicados por ${totalGanancias} monedas?`)) return;
    const newCollection = cards.map((card) =>
      card.quantity > 1 && !card.is_favorite ? { ...card, quantity: 1 } : card,
    );
    setCards(newCollection);
    addCoins(totalGanancias);
    if (isSignedIn) await Promise.all(duplicates.map((c) => sellAllDuplicatesAction(c.id, getPrice(c.rarity))));
    else saveCollectionRaw(newCollection);
  };

  const handleSellAllFromModal = async () => {
    if (!selectedCard || selectedCard.quantity <= 1) return;
    const unitPrice = getPrice(selectedCard.rarity);
    const duplicates = selectedCard.quantity - 1;
    const totalValue = duplicates * unitPrice;
    addCoins(totalValue);
    setSelectedCard({ ...selectedCard, quantity: 1 });
    setCards((prev) => prev.map((c) => (c.id === selectedCard.id ? { ...c, quantity: 1 } : c)));
    if (isSignedIn) await sellAllDuplicatesAction(selectedCard.id, unitPrice);
    else saveCollectionRaw(cards.map((c) => (c.id === selectedCard.id ? { ...c, quantity: 1 } : c)));
  };

  const handleToggleFavInModal = async () => {
    if (!selectedCard) return;
    const newStatus = !selectedCard.is_favorite;
    setSelectedCard({ ...selectedCard, is_favorite: newStatus });
    setCards((prev) => prev.map((c) => (c.id === selectedCard.id ? { ...c, is_favorite: newStatus } : c)));
    const res = await toggleFavorite(selectedCard.id);
    if (res?.error) alert(res.error);
  };

  if (loading) return <Loader label="Cargando Colección" />;

  return (
    <main className="flex min-h-screen flex-col items-center p-4 md:p-8 ink select-none overflow-hidden">
      <BackgroundParticles />

      <AppHeader
        back={{ href: "/" }}
        title="Mi Álbum"
        showCollectionLink={false}
        rightExtra={
          <button
            onClick={handleSellAllDuplicates}
            className="hidden sm:flex items-center gap-2 bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 text-red-300 px-3 py-2 rounded-xl text-xs font-medium transition"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
              <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
            </svg>
            <span>Limpiar duplicados</span>
          </button>
        }
      />

      <div className="w-full max-w-7xl flex flex-col gap-6 pb-24 relative z-10">
        {/* PROGRESS PANEL */}
        <div>
          <button
            onClick={() => setShowStats(!showStats)}
            className="w-full surface surface-hover rounded-2xl px-5 py-4 flex justify-between items-center group"
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-white/5 border border-white/5 flex items-center justify-center">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-5 h-5 text-emerald-400">
                  <path d="M3 3v18h18" />
                  <path d="M7 14l4-4 4 4 6-6" />
                </svg>
              </div>
              <div className="text-left">
                <h3 className="font-semibold text-sm text-white">Progreso de colección</h3>
                <p className="text-xs text-gray-500">{showStats ? "Ocultar detalles" : "Ver progreso por expansión"}</p>
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
                transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
                className="overflow-hidden"
              >
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 mt-3">
                  {setStats.map((stat, idx) => (
                    <motion.div
                      key={stat.id}
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: idx * 0.03 }}
                    >
                      <Link href={`/album/${stat.id}`} className="block surface surface-hover rounded-2xl p-4 h-full">
                        <div className="flex items-center gap-3 mb-3">
                          {stat.logo && <img src={stat.logo} alt={stat.name} className="h-7 object-contain opacity-90" />}
                          <div className="flex-1 min-w-0">
                            <h3 className="font-medium text-sm text-gray-200 truncate">{stat.name}</h3>
                            <p className="text-[10px] text-gray-500 font-mono">{stat.owned}/{stat.total}</p>
                          </div>
                          <span className="text-xs font-semibold text-gray-400">{stat.percentage}%</span>
                        </div>
                        <div className="w-full h-1.5 bg-white/5 rounded-full overflow-hidden">
                          <div
                            className={stat.percentage === 100 ? "progress-bar h-full" : "progress-bar-blue h-full"}
                            style={{ width: `${stat.percentage}%` }}
                          />
                        </div>
                      </Link>
                    </motion.div>
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* TOOLBAR */}
        <div className="surface rounded-2xl px-3 py-3 flex flex-wrap gap-2 items-center">
          <div className="flex items-center gap-2 bg-white/5 px-3 py-2 rounded-xl border border-white/5 flex-1 min-w-[180px]">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4 text-gray-500">
              <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
            </svg>
            <input
              type="text"
              placeholder="Buscar..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="bg-transparent text-white outline-none text-sm flex-1 placeholder:text-gray-600"
            />
          </div>
          <select
            value={filterSet}
            onChange={(e) => setFilterSet(e.target.value)}
            className="bg-white/5 hover:bg-white/10 transition text-white px-3 py-2 rounded-xl border border-white/5 text-xs cursor-pointer"
          >
            <option value="all" className="bg-[#111]">Todas las expansiones</option>
            {dbSets.map((set) => (
              <option key={set.id} value={set.id} className="bg-[#111]">{set.name}</option>
            ))}
          </select>
          <select
            value={filterRarity}
            onChange={(e) => setFilterRarity(e.target.value)}
            className="bg-white/5 hover:bg-white/10 transition text-white px-3 py-2 rounded-xl border border-white/5 text-xs cursor-pointer"
          >
            <option value="all" className="bg-[#111]">Toda rareza</option>
            {rarityOptions.map((r) => (
              <option key={r} value={r} className="bg-[#111]">{r}</option>
            ))}
          </select>
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
            className="bg-white/5 hover:bg-white/10 transition text-white px-3 py-2 rounded-xl border border-white/5 text-xs cursor-pointer"
          >
            <option value="rarity_desc" className="bg-[#111]">Rareza</option>
            <option value="quantity_desc" className="bg-[#111]">Cantidad</option>
            <option value="name_asc" className="bg-[#111]">Nombre</option>
          </select>
          <button
            onClick={handleSellAllDuplicates}
            className="sm:hidden flex items-center gap-2 bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 text-red-300 px-3 py-2 rounded-xl text-xs font-medium"
          >
            Limpiar duplicados
          </button>
        </div>

        {/* GRID */}
        {processedCards.length === 0 ? (
          <div className="surface rounded-2xl py-16 md:py-20 px-6 text-center flex flex-col items-center gap-4">
            <div className="w-14 h-14 rounded-2xl bg-white/5 border border-white/5 flex items-center justify-center">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-7 h-7 text-gray-500">
                <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
              </svg>
            </div>
            <div>
              <p className="text-white font-medium">{cards.length === 0 ? "Aún no tienes cartas" : "Sin resultados"}</p>
              <p className="text-gray-500 text-sm mt-1">{cards.length === 0 ? "Abre tu primer sobre para empezar" : "Prueba otros filtros"}</p>
            </div>
            {cards.length === 0 && (
              <Link href="/" className="btn-primary press px-5 py-2.5 rounded-xl text-sm font-medium">Abrir sobres</Link>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4 md:gap-6">
            {processedCards.map((card) => (
              <div
                key={card.id}
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
                  {card.quantity > 1 ? (
                    <button
                      onClick={(e) => handleSellCard(e, card.id, card.rarity)}
                      className="chip ink text-[10px] py-1 px-3 rounded-full press hover:brightness-110"
                    >
                      Vender +{getPrice(card.rarity)}
                    </button>
                  ) : (
                    <span className="chip ink-soft text-[10px] px-2 py-1 rounded-full">Única</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <CardDetailModal
        card={selectedCard}
        onClose={() => setSelectedCard(null)}
        onToggleFavorite={handleToggleFavInModal}
        onSellAll={handleSellAllFromModal}
      />
    </main>
  );
}
