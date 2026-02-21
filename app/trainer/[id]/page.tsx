"use client";

import { useEffect, useState, useMemo } from "react";
import { useParams } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { useUser, SignedIn, UserButton } from "@clerk/nextjs";
import {
  getTrainerCollection,
  getSetsFromDB,
} from "../../action";
import { useCurrency } from "../../../hooks/useGameCurrency";
import {
  RARITY_RANK,
  SELL_PRICES,
} from "../../../utils/constanst";
import PokemonCard from "../../../components/PokemonCard";
import Link from "next/link";

export default function TrainerProfilePage() {
  const params = useParams();
  const trainerId = params.id as string;

  const { isLoaded } = useUser();
  const [cards, setCards] = useState<any[]>([]);
  const [dbSets, setDbSets] = useState<any[]>([]);
  const { coins } = useCurrency();
  const [showStats, setShowStats] = useState(false);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [sortBy, setSortBy] = useState("rarity_desc");
  const [filterSet, setFilterSet] = useState("all");
  const [selectedCard, setSelectedCard] = useState<any | null>(null);

  // --- CARGA DE DATOS DEL AMIGO ---
  useEffect(() => {
    async function initCollection() {
      if (!trainerId) return;
      setLoading(true);

      const sets = await getSetsFromDB();
      setDbSets(sets);

      try {
        const trainerCards = await getTrainerCollection(trainerId);
        setCards(trainerCards);
      } catch (error) {
        console.error("Error cargando colección del entrenador:", error);
      }
      
      setLoading(false);
    }
    initCollection();
  }, [trainerId]);

  // --- LÓGICA DE ESTADÍSTICAS ---
  const setStats = useMemo(() => {
    return dbSets.map((set) => {
      const uniqueCardsOwned = cards.filter((c) =>
        c.id.startsWith(set.id + "-"), 
      ).length;
      
      const totalInSet = set.total || 1; 
      const percentage = Math.min(100, Math.round((uniqueCardsOwned / totalInSet) * 100));
      const missing = Math.max(0, totalInSet - uniqueCardsOwned);
      const logoUrl = set.images?.logo || ""; 
      
      return { ...set, logo: logoUrl, owned: uniqueCardsOwned, percentage, missing };
    });
  }, [cards, dbSets]);

  // --- FILTROS Y ORDEN ---
  const processedCards = useMemo(() => {
    let result = [...cards];
    if (searchTerm)
      result = result.filter((c) =>
        c.name.toLowerCase().includes(searchTerm.toLowerCase()),
      );
    if (filterSet !== "all")
      result = result.filter((c) => c.id.startsWith(filterSet));

    result.sort((a, b) => {
      if (a.is_favorite && !b.is_favorite) return -1;
      if (!a.is_favorite && b.is_favorite) return 1;

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

  if (loading || !isLoaded) {
    return (
      <div className="min-h-screen bg-gray-900 flex flex-col items-center justify-center text-white">
        <div className="text-4xl animate-bounce mb-4">👀</div>
        <p className="animate-pulse">Cargando colección de tu amigo...</p>
      </div>
    );
  }

  return (
    <main className="min-h-screen bg-gray-900 text-white p-8 pb-32 select-none">
      {/* CABECERA (SOLO LECTURA) */}
      <div className="w-full max-w-7xl mx-auto sticky top-4 z-50 bg-gray-800 p-4 rounded-xl shadow-xl border border-gray-700 mb-8 flex justify-between items-center">
        <div className="flex items-center gap-4">
          <Link href="/friends" className="bg-gray-700 hover:bg-gray-600 w-10 h-10 flex items-center justify-center rounded-lg border border-gray-600 transition shadow" title="Volver a Amigos">
            ⬅️
          </Link>
          <div>
            <h1 className="text-xl md:text-2xl font-bold text-white tracking-wide">Álbum de Amigo</h1>
            <p className="text-[10px] text-gray-400 font-mono truncate max-w-[150px] sm:max-w-xs">{trainerId}</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* Mostramos tus propias monedas y tu perfil para que sigas viendo tu info */}
          <div className="flex items-center gap-2 bg-gray-900/60 px-4 py-2 rounded-full border border-gray-700 shadow-inner">
            <span className="text-xl">💰</span>
            <span className="font-black text-yellow-400">{coins}</span>
          </div>
          
          <SignedIn>
            <div className="bg-gray-700/50 p-1 rounded-full border border-gray-600 hidden sm:block">
              <UserButton />
            </div>
          </SignedIn>
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
              <h3 className="font-bold text-white group-hover:text-yellow-400 transition">Progreso de su Colección</h3>
              <p className="text-xs text-gray-400">{showStats ? "Ocultar detalles" : "Ver progreso por expansión"}</p>
            </div>
          </div>
          <motion.div animate={{ rotate: showStats ? 180 : 0 }} className="text-gray-400">▼</motion.div>
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
                  <div key={stat.id} className="bg-gray-800/50 p-4 rounded-xl border border-gray-700/50 flex flex-col gap-3 h-full">
                    <div className="flex items-center gap-3">
                      <img src={stat.logo} alt={stat.name} className="h-8 object-contain" />
                      <div className="flex-1">
                        <h3 className="font-bold text-sm text-gray-200">{stat.name}</h3>
                        <p className="text-xs text-gray-400">{stat.owned}/{stat.total}</p>
                      </div>
                    </div>
                    <div className="w-full h-2 bg-gray-700 rounded-full overflow-hidden mt-auto">
                      <div
                        className={`h-full rounded-full ${stat.percentage === 100 ? "bg-green-500" : "bg-blue-500"}`}
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
          {dbSets.map((set) => (
            <option key={set.id} value={set.id}>{set.name}</option>
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
          <p>Este entrenador aún no tiene cartas.</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-6 max-w-7xl mx-auto">
          {processedCards.map((card) => (
            <div key={card.id} className="relative group cursor-zoom-in" onClick={() => setSelectedCard(card)}>
              {/* Etiqueta de cantidad */}
              {card.quantity > 1 && (
                <div className="absolute -top-2 -right-2 z-30 bg-blue-600 text-white text-xs font-bold w-6 h-6 flex items-center justify-center rounded-full border border-white shadow-lg">
                  {card.quantity}
                </div>
              )}
              {/* Etiqueta de Favorito (Solo lectura) */}
              {card.is_favorite && (
                <div className="absolute -top-2 -left-2 z-30 text-xl filter drop-shadow-md">
                  ❤️
                </div>
              )}
              
              <div className="transition transform group-hover:-translate-y-1 duration-300 pointer-events-none">
                <PokemonCard card={card} reveal={true} />
              </div>
              
              {/* Tag informativo inferior en vez de botón de vender */}
              <div className="mt-2 flex justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-300">
                <span className="text-[10px] font-bold text-gray-400 bg-gray-800 px-3 py-1 rounded-full border border-gray-700 shadow-md">
                  {card.quantity > 1 ? `Posee ${card.quantity} copias` : "🔒 Copia única"}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* MODAL DETALLE (SOLO LECTURA) */}
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
              className="relative w-full max-w-4xl bg-gray-900 rounded-2xl overflow-y-auto shadow-2xl border border-gray-700 flex flex-col md:flex-row max-h-[90vh] custom-scrollbar"
              onClick={(e) => e.stopPropagation()}
            >
              <button onClick={() => setSelectedCard(null)} className="absolute top-4 right-4 w-10 h-10 flex items-center justify-center text-white z-50 bg-gray-800 hover:bg-red-500 border border-gray-600 rounded-full transition">✕</button>

              <div className="w-full md:w-1/2 p-8 pt-16 md:pt-8 bg-gray-800 flex items-center justify-center relative">
                {/* Corazón en modal (Solo Lectura, ya no es un botón) */}
                <div className="absolute top-4 left-4 z-50 bg-black/40 p-3 rounded-full border border-white/10">
                  <span className={`text-2xl ${selectedCard.is_favorite ? "" : "grayscale opacity-50"}`}>
                    {selectedCard.is_favorite ? "❤️" : "🤍"}
                  </span>
                </div>
                <img src={selectedCard.images.large} alt={selectedCard.name} className="object-contain max-h-[40vh] md:max-h-[60vh] drop-shadow-2xl" />
              </div>

              <div className="w-full md:w-1/2 bg-gray-900 flex flex-col p-8">
                <p className="text-blue-400 text-xs font-bold mb-1 uppercase tracking-widest">{selectedCard.supertype}</p>
                <h2 className="text-4xl font-black text-white mb-6">{selectedCard.name}</h2>
                
                <div className="bg-gray-800 p-4 rounded-2xl border border-gray-700 flex items-center justify-between mb-8">
                  <div>
                    <p className="text-gray-400 text-xs font-bold uppercase">Valor Mercado</p>
                    <p className="text-2xl font-black text-yellow-400">{getPrice(selectedCard.rarity)} 💰</p>
                  </div>
                  {/* Etiqueta de cantidad en vez de botón de vender */}
                  {selectedCard.quantity > 1 ? (
                    <span className="bg-gray-700 text-gray-300 px-4 py-2 rounded-full font-bold text-xs border border-gray-600">
                      TIENE {selectedCard.quantity} COPIAS
                    </span>
                  ) : (
                    <span className="text-xs text-gray-500">COPIA ÚNICA</span>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-4 mt-auto">
                    <div className="bg-gray-800/50 p-3 rounded-xl border border-gray-700/50">
                        <p className="text-gray-500 text-[10px] font-bold">RAREZA</p>
                        <p className="text-white text-sm">💎 {selectedCard.rarity}</p>
                    </div>
                    <div className="bg-gray-800/50 p-3 rounded-xl border border-gray-700/50">
                        <p className="text-gray-500 text-[10px] font-bold">ARTISTA</p>
                        <p className="text-white text-sm">🖌️ {selectedCard.artist}</p>
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