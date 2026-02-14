"use client";

import { useEffect, useState, useMemo } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useUser } from "@clerk/nextjs";
import { getFullCollection, sellCardAction } from "../action";
import { getCollection, saveCollectionRaw } from "../../utils/storage";
import { useCurrency } from "../../hooks/useGameCurrency";
import {
  AVAILABLE_SETS,
  RARITY_RANK,
  SELL_PRICES,
} from "../../utils/constanst";
import PokemonCard from "../../components/PokemonCard";
import Link from "next/link";

export default function CollectionPage() {
  const { isSignedIn, isLoaded } = useUser();
  const [cards, setCards] = useState<any[]>([]);
  const { coins, addCoins } = useCurrency();
  const [showStats, setShowStats] = useState(false);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [sortBy, setSortBy] = useState("rarity_desc");
  const [filterSet, setFilterSet] = useState("all");
  const [selectedCard, setSelectedCard] = useState<any | null>(null);

  // --- CARGA DE DATOS ---
  useEffect(() => {
    async function initCollection() {
      if (!isLoaded) return;
      setLoading(true);

      if (isSignedIn) {
        try {
          const dbCards = await getFullCollection();
          setCards(dbCards);
        } catch (error) {
          console.error("Error cargando colección:", error);
        }
      } else {
        const localCards = getCollection();
        setCards(localCards);
      }
      setLoading(false);
    }
    initCollection();
  }, [isSignedIn, isLoaded]);

  // --- LÓGICA DE ESTADÍSTICAS ---
  const setStats = useMemo(() => {
    return AVAILABLE_SETS.map((set) => {
      const uniqueCardsOwned = cards.filter((c) =>
        c.id.startsWith(set.id)
      ).length;
      const percentage = Math.min(
        100,
        Math.round((uniqueCardsOwned / set.total) * 100)
      );
      const missing = Math.max(0, set.total - uniqueCardsOwned);
      return { ...set, owned: uniqueCardsOwned, percentage, missing };
    });
  }, [cards]);

  // --- FILTROS Y ORDEN ---
  const processedCards = useMemo(() => {
    let result = [...cards];
    if (searchTerm)
      result = result.filter((c) =>
        c.name.toLowerCase().includes(searchTerm.toLowerCase())
      );
    if (filterSet !== "all")
      result = result.filter((c) => c.id.startsWith(filterSet));

    result.sort((a, b) => {
      switch (sortBy) {
        case "name_asc":
          return a.name.localeCompare(b.name);
        case "quantity_desc":
          return (b.quantity || 1) - (a.quantity || 1);
        case "rarity_desc":
          return (RARITY_RANK[b.rarity] || 0) - (RARITY_RANK[a.rarity] || 0);
        default:
          return 0;
      }
    });
    return result;
  }, [cards, searchTerm, filterSet, sortBy]);

  const getPrice = (rarity: string) => SELL_PRICES[rarity] || 10;

  // --- VENTA ---
  const handleSellCard = async (
    e: React.MouseEvent,
    cardId: string,
    rarity: string
  ) => {
    e.stopPropagation();
    const card = cards.find((c) => c.id === cardId);
    if (!card || card.quantity <= 1) return;

    const price = getPrice(rarity);
    const updatedCards = cards.map((c) => {
      if (c.id === cardId) return { ...c, quantity: c.quantity - 1 };
      return c;
    });

    setCards(updatedCards);
    addCoins(price);

    if (isSignedIn) {
      await sellCardAction(cardId, price);
    } else {
      saveCollectionRaw(updatedCards);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-900 flex flex-col items-center justify-center text-white">
        <div className="text-4xl animate-bounce mb-4">📒</div>
        <p className="animate-pulse">Cargando tu colección...</p>
      </div>
    );
  }

  return (
    <main className="min-h-screen bg-gray-900 text-white p-8 pb-32">
      {/* CABECERA */}
      <div className="sticky top-0 z-40 bg-gray-900/95 backdrop-blur-md border-b border-gray-700 py-4 mb-8 -mx-8 px-8 shadow-2xl flex justify-between items-center">
        <div className="flex items-center gap-4">
          <Link
            href="/"
            className="bg-gray-800 hover:bg-gray-700 p-2 rounded-full transition"
          >
            🏠
          </Link>
          <h1 className="text-2xl font-bold text-yellow-400">Mi Álbum</h1>
        </div>
        <div className="bg-gray-800 px-4 py-1.5 rounded-full border border-gray-600 flex items-center gap-2">
          <span>💰</span>
          <span className="font-bold text-yellow-400">{coins}</span>
        </div>
      </div>

      {/* DASHBOARD ESTADÍSTICAS */}
      <div className="max-w-7xl mx-auto mb-6">
        <button
          onClick={() => setShowStats(!showStats)}
          className="w-full bg-gray-800 p-4 rounded-xl border border-gray-700 flex justify-between items-center hover:bg-gray-700 transition group shadow-lg"
        >
          <div className="flex items-center gap-3">
            <span className="text-2xl">📊</span>
            <div className="text-left">
              <h3 className="font-bold text-white group-hover:text-yellow-400 transition">
                Progreso de Colección
              </h3>
              <p className="text-xs text-gray-400">
                {showStats ? "Ocultar detalles" : "Ver progreso por expansión"}
              </p>
            </div>
          </div>
          <motion.div
            animate={{ rotate: showStats ? 180 : 0 }}
            className="text-gray-400"
          >
            ▼
          </motion.div>
        </button>

        <AnimatePresence>
          {showStats && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="overflow-hidden"
            >
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mt-4 pb-2">
                {setStats.map((stat) => (
                  <div
                    key={stat.id}
                    className="bg-gray-800/50 p-4 rounded-xl border border-gray-700/50 flex flex-col gap-3"
                  >
                    <div className="flex items-center gap-3">
                      <img
                        src={stat.logo}
                        alt={stat.name}
                        className="h-8 object-contain"
                      />
                      <div className="flex-1">
                        <h3 className="font-bold text-sm text-gray-200">
                          {stat.name}
                        </h3>
                        <p className="text-xs text-gray-400">
                          {stat.owned}/{stat.total}
                        </p>
                      </div>
                    </div>
                    <div className="w-full h-2 bg-gray-700 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${
                          stat.percentage === 100
                            ? "bg-green-500"
                            : "bg-blue-500"
                        }`}
                        style={{ width: `${stat.percentage}%` }}
                      ></div>
                    </div>
                  </div>
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* TOOLBAR */}
      <div className="max-w-7xl mx-auto mb-6 flex flex-wrap gap-2 items-center bg-gray-800 p-2 rounded-lg border border-gray-700">
        <input
          type="text"
          placeholder="🔍 Buscar..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="bg-gray-900 text-white px-3 py-1.5 rounded border border-gray-600 focus:border-yellow-400 outline-none text-sm w-full md:w-auto"
        />
        <select
          value={filterSet}
          onChange={(e) => setFilterSet(e.target.value)}
          className="bg-gray-900 text-white px-3 py-1.5 rounded border border-gray-600 text-sm"
        >
          <option value="all">🌍 Todas</option>
          {AVAILABLE_SETS.map((set) => (
            <option key={set.id} value={set.id}>
              {set.name}
            </option>
          ))}
        </select>
        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value)}
          className="bg-gray-900 text-white px-3 py-1.5 rounded border border-gray-600 text-sm"
        >
          <option value="rarity_desc">💎 Rareza</option>
          <option value="quantity_desc">🔢 Cantidad</option>
          <option value="name_asc">🔤 Nombre</option>
        </select>
      </div>

      {/* GRID CARTAS */}
      {processedCards.length === 0 ? (
        <div className="text-center py-20 text-gray-500">
          <p>No tienes cartas aún.</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-6 max-w-7xl mx-auto">
          {processedCards.map((card) => (
            <div
              key={card.id}
              className="relative group cursor-zoom-in"
              onClick={() => setSelectedCard(card)}
            >
              {card.quantity > 1 && (
                <div className="absolute -top-2 -right-2 z-30 bg-blue-600 text-white text-xs font-bold w-6 h-6 flex items-center justify-center rounded-full border border-white shadow-lg">
                  {card.quantity}
                </div>
              )}
              
              <div className="transition transform group-hover:-translate-y-1 duration-300 pointer-events-none">
                {/* 👇 ¡AQUÍ ESTÁ EL ARREGLO! 👇 */}
                <PokemonCard 
                  card={card} 
                  reveal={true} 
                  isFavorite={card.is_favorite} 
                />
              </div>

              <div className="mt-2 flex justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-300">
                {card.quantity > 1 ? (
                  <button
                    onClick={(e) => handleSellCard(e, card.id, card.rarity)}
                    className="bg-red-900/80 hover:bg-red-600 text-white text-xs py-1 px-3 rounded-full border border-red-400 backdrop-blur-sm z-20"
                  >
                    Vender (+{getPrice(card.rarity)})
                  </button>
                ) : (
                  <span className="text-[10px] font-bold text-gray-500 bg-black/60 px-2 py-1 rounded border border-gray-700">
                    🔒 Original
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* MODAL DETALLE */}
      <AnimatePresence>
        {selectedCard && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/90 backdrop-blur-md p-4"
            onClick={() => setSelectedCard(null)}
          >
            <motion.div
              initial={{ scale: 0.9 }}
              animate={{ scale: 1 }}
              exit={{ scale: 0.9 }}
              className="relative w-full max-w-4xl bg-gray-900 rounded-2xl overflow-hidden shadow-2xl border border-gray-700 flex flex-col md:flex-row"
              onClick={(e) => e.stopPropagation()}
            >
              <button
                onClick={() => setSelectedCard(null)}
                className="absolute top-4 right-4 text-gray-400 hover:text-white z-50 bg-black/50 p-2 rounded-full"
              >
                ✕
              </button>

              <div className="w-full md:w-1/2 p-8 bg-gray-800 flex items-center justify-center">
                <img
                  src={selectedCard.images.large}
                  alt={selectedCard.name}
                  className="object-contain max-h-[60vh] drop-shadow-2xl"
                />
              </div>

              <div className="w-full md:w-1/2 p-10 flex flex-col justify-center gap-8 bg-gray-900">
                <div>
                  <p className="text-gray-500 text-xs uppercase tracking-widest mb-1 font-bold">
                    Pokémon
                  </p>
                  <h2 className="text-5xl font-black text-white tracking-tight">
                    {selectedCard.name}
                  </h2>
                </div>

                <div className="flex flex-col gap-2">
                  <p className="text-gray-500 text-xs uppercase tracking-widest font-bold">
                    Expansión
                  </p>
                  <div className="flex items-center gap-3 bg-gray-800 p-3 rounded-xl border border-gray-700">
                    {(() => {
                      const setId = selectedCard.set_id || selectedCard.set?.id;
                      const setInfo = AVAILABLE_SETS.find(
                        (s) => s.id === setId
                      );
                      return setInfo ? (
                        <>
                          <img
                            src={setInfo.logo}
                            alt="set"
                            className="h-8 w-auto object-contain"
                          />
                          <span className="text-xl font-bold text-gray-200">
                            {setInfo.name}
                          </span>
                        </>
                      ) : (
                        <span className="text-xl font-bold text-gray-200">
                          {selectedCard.set?.name || "Desconocido"}
                        </span>
                      );
                    })()}
                  </div>
                </div>

                <div>
                  <p className="text-gray-500 text-xs uppercase tracking-widest mb-2 font-bold">
                    Valor Actual
                  </p>
                  <div className="inline-flex items-center gap-3 bg-yellow-400/10 p-4 rounded-2xl border border-yellow-400/20">
                    <span className="text-4xl font-black text-yellow-400">
                      {getPrice(selectedCard.rarity)}
                    </span>
                    <span className="text-2xl">💰</span>
                  </div>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </main>
  );
}