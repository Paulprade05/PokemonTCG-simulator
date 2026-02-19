// src/app/collection/page.tsx
"use client";

import { useEffect, useState, useMemo } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useUser } from "@clerk/nextjs";
import {
  getFullCollection,
  sellCardAction,
  toggleFavorite,
  sellAllDuplicatesAction,
  getSetsFromDB, // 👈 IMPORTANTE: Añadimos esto
} from "../action";
import { getCollection, saveCollectionRaw } from "../../utils/storage";
import { useCurrency } from "../../hooks/useGameCurrency";
import {
  RARITY_RANK,
  SELL_PRICES,
} from "../../utils/constanst"; // 👈 QUITAMOS AVAILABLE_SETS de aquí
import PokemonCard from "../../components/PokemonCard";
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
  const [selectedCard, setSelectedCard] = useState<any | null>(null);

  // --- CARGA DE DATOS ---
  useEffect(() => {
    async function initCollection() {
      if (!isLoaded) return;
      setLoading(true);

      // 👈 NUEVO: Cargamos los sets siempre
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
        const localCards = getCollection();
        setCards(localCards);
      }
      setLoading(false);
    }
    initCollection();
  }, [isSignedIn, isLoaded]);

  // --- LÓGICA DE ESTADÍSTICAS ---
 // --- LÓGICA DE ESTADÍSTICAS ---
  const setStats = useMemo(() => {
    return dbSets.map((set) => {
      // 👇 AQUÍ ESTÁ LA MAGIA: Añadimos + "-" para evitar colisiones de nombres
      const uniqueCardsOwned = cards.filter((c) =>
        c.id.startsWith(set.id + "-"), 
      ).length;
      
      // Protegemos contra divisiones por 0
      const totalInSet = set.total || 1; 
      
      const percentage = Math.min(
        100,
        Math.round((uniqueCardsOwned / totalInSet) * 100),
      );
      const missing = Math.max(0, totalInSet - uniqueCardsOwned);
      
      const logoUrl = set.images?.logo || ""; 
      
      return { ...set, logo: logoUrl, owned: uniqueCardsOwned, percentage, missing };
    });
  }, [cards, dbSets]);

  // --- FILTROS Y ORDEN ---
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
      // 👑 REGLA DE ORO: Los favoritos SIEMPRE van primero
      // Si 'a' es favorita y 'b' no lo es -> 'a' gana (-1)
      if (a.is_favorite && !b.is_favorite) return -1;
      // Si 'b' es favorita y 'a' no lo es -> 'b' gana (1)
      if (!a.is_favorite && b.is_favorite) return 1;

      // Si empatan (las dos son favoritas o ninguna lo es),
      // entonces desempatamos con el criterio del desplegable:
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
    rarity: string,
  ) => {
    e.stopPropagation();
    const card = cards.find((c) => c.id === cardId);
    if (!card || card.quantity <= 1) return;

    const price = getPrice(rarity);
    const updatedCards = cards.map((c) => {
      if (c.id === cardId) return { ...c, quantity: c.quantity - 1 };
      return c;
    });
    // --- FUNCIÓN PARA VENDER TODOS LOS DUPLICADOS ---

    setCards(updatedCards);
    addCoins(price);

    if (isSignedIn) {
      await sellCardAction(cardId, price);
    } else {
      saveCollectionRaw(updatedCards);
    }
  };
  // --- FUNCIÓN NUEVA: VENDER TODOS LOS DUPLICADOS ---
  const handleSellAll = async (e: React.MouseEvent) => {
    e.stopPropagation(); // Evita conflictos de clic
    if (!selectedCard || selectedCard.quantity <= 1) return;

    const unitPrice = getPrice(selectedCard.rarity);
    const duplicates = selectedCard.quantity - 1;
    const totalValue = duplicates * unitPrice;

    // 1. UI Optimista: Actualizamos monedas y carta visualmente YA
    const oldQuantity = selectedCard.quantity;
    addCoins(totalValue);

    // Dejamos la carta con 1 sola copia en el modal y en la lista de fondo
    setSelectedCard({ ...selectedCard, quantity: 1 });
    setCards((prev) =>
      prev.map((c) => (c.id === selectedCard.id ? { ...c, quantity: 1 } : c)),
    );

    // 2. Llamada al servidor (en segundo plano)
    const res = await sellAllDuplicatesAction(selectedCard.id, unitPrice);

    // 3. Si falla, deshacemos los cambios
    if (!res?.success) {
      alert("Error al vender: " + (res?.error || "Desconocido"));
      addCoins(-totalValue);
      setSelectedCard({ ...selectedCard, quantity: oldQuantity });
      setCards((prev) =>
        prev.map((c) =>
          c.id === selectedCard.id ? { ...c, quantity: oldQuantity } : c,
        ),
      );
    }
  };
  // 🔥 NUEVA LÓGICA DE FAVORITOS (SOLO EN MODAL)
  const handleToggleFavInModal = async () => {
    if (!selectedCard) return;

    // 1. UI Optimista (Cambio visual inmediato en el modal y en la lista de fondo)
    const newStatus = !selectedCard.is_favorite;

    // Actualizamos la carta seleccionada
    setSelectedCard({ ...selectedCard, is_favorite: newStatus });

    // Actualizamos la lista principal de cartas para que se guarde el estado si cerramos el modal
    setCards((prev) =>
      prev.map((c) =>
        c.id === selectedCard.id ? { ...c, is_favorite: newStatus } : c,
      ),
    );

    // 2. Llamada al servidor
    const res = await toggleFavorite(selectedCard.id);

    // Si falla, revertimos
    if (res?.error) {
      alert(res.error);
      const revertedStatus = !newStatus;
      setSelectedCard({ ...selectedCard, is_favorite: revertedStatus });
      setCards((prev) =>
        prev.map((c) =>
          c.id === selectedCard.id ? { ...c, is_favorite: revertedStatus } : c,
        ),
      );
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
    <main className="min-h-screen bg-gray-900 text-white p-8 pb-32 select-none">
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
          {dbSets.map((set) => ( // 👈 CAMBIADO: Usamos dbSets
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
                {/* Usamos PokemonCard "limpio" (sin lógica interna de favoritos) */}
                <PokemonCard
                  card={card}
                  reveal={true}
                  // isFavorite NO se pasa aquí, porque no queremos verlo en pequeño
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

              <div className="w-full md:w-1/2 p-8 bg-gray-800 flex items-center justify-center relative">
                {/* OPCIÓN 1: BOTÓN FLOTANTE SOBRE LA IMAGEN */}
                <button
                  onClick={handleToggleFavInModal}
                  className="absolute top-6 right-6 z-50 bg-black/40 backdrop-blur-md p-3 rounded-full hover:scale-110 transition border border-white/10 group"
                  title={
                    selectedCard.is_favorite
                      ? "Quitar de favoritos"
                      : "Añadir a favoritos"
                  }
                >
                  <span
                    className={`text-3xl filter drop-shadow-lg block ${selectedCard.is_favorite ? "" : "grayscale opacity-50 group-hover:grayscale-0 group-hover:opacity-100 transition-all"}`}
                  >
                    {selectedCard.is_favorite ? "❤️" : "🤍"}
                  </span>
                </button>

                <img
                  src={selectedCard.images.large}
                  alt={selectedCard.name}
                  className="object-contain max-h-[60vh] drop-shadow-2xl"
                />
              </div>

              <div className="w-full md:w-1/2 bg-gray-900 flex flex-col h-full max-h-[90vh] overflow-y-auto custom-scrollbar">
                {/* 1. CABECERA (Nombre y Favorito) */}
                <div className="p-8 pb-4 border-b border-gray-800">
                  <div className="flex justify-between items-start gap-4">
                    <div>
                      <p className="text-blue-400 text-xs uppercase tracking-widest font-bold mb-1">
                        {selectedCard.supertype || "Pokémon"}
                      </p>
                      <h2 className="text-4xl md:text-5xl font-black text-white tracking-tight leading-none">
                        {selectedCard.name}
                      </h2>
                    </div>

                    {/* Botón Favorito Pequeño */}
                    <button
                      onClick={handleToggleFavInModal}
                      className={`p-3 rounded-xl border transition-all ${
                        selectedCard.is_favorite
                          ? "bg-red-500/20 border-red-500 text-red-500"
                          : "bg-gray-800 border-gray-700 text-gray-500 hover:text-white"
                      }`}
                    >
                      <span className="text-2xl">
                        {selectedCard.is_favorite ? "❤️" : "🤍"}
                      </span>
                    </button>
                  </div>
                </div>

                {/* 2. CUERPO DE DATOS */}
                <div className="p-8 pt-6 flex-1 flex flex-col gap-8">
                  {/* PRECIO / VALOR */}
                    
                    <div className="text-right">
                      {/* PRECIO / VALOR */}
                      <div className="bg-gradient-to-r from-gray-800 to-gray-900 p-4 rounded-2xl border border-gray-700 flex items-center justify-between shadow-lg">
                        <div>
                          <p className="text-gray-400 text-xs font-bold uppercase mb-1">
                            Valor de Mercado
                          </p>
                          <p className="text-3xl font-black text-yellow-400 flex items-center gap-2">
                            {getPrice(selectedCard.rarity)}{" "}
                            <span className="text-lg">💰</span>
                          </p>
                        </div>

                        
                          {selectedCard.quantity > 1 ? (
                            <button
                              onClick={handleSellAll}
                              // Añadimos 'min-w-[150px]' para que tenga un ancho mínimo estable
                              className="group relative px-4 py-2 rounded-full border border-red-500 bg-red-500/10 text-red-400 font-bold text-xs hover:bg-red-500 hover:text-white transition-all overflow-hidden min-w-[150px]"
                            >
                              {/* 1. TEXTO NORMAL: */}
                              {/* Cambiamos 'group-hover:hidden' por 'group-hover:opacity-0' */}
                              {/* Así el texto se vuelve invisible pero SIGUE OCUPANDO ESPACIO, evitando que el botón se encoja */}
                              <span className="relative z-10 transition-opacity group-hover:opacity-0">
                                VENDER {selectedCard.quantity - 1} COPIAS
                              </span>

                              {/* 2. TEXTO HOVER: */}
                              {/* Cambiamos 'hidden' por 'opacity-0' y 'group-hover:flex' por 'group-hover:opacity-100' */}
                              <span className="absolute inset-0 z-20 flex items-center justify-center font-black bg-red-600 text-white opacity-0 group-hover:opacity-100 transition-opacity">
                                +
                                {(selectedCard.quantity - 1) *
                                  getPrice(selectedCard.rarity)}{" "}
                                💰
                              </span>
                            </button>
                          ) : (
                            <button
                              disabled
                              className="text-xs px-3 py-1.5 rounded-full border bg-gray-700 border-gray-600 text-gray-500 cursor-not-allowed opacity-50"
                            >
                              ÚLTIMA COPIA
                            </button>
                          )}
                      </div>
                    </div>
                  

                  {/* FLAVOR TEXT (Descripción) */}
                  {selectedCard.flavorText && (
                    <div className="relative pl-4 border-l-4 border-blue-500 italic text-gray-300 text-lg leading-relaxed">
                      <span className="absolute -top-2 -left-2 text-4xl text-blue-500 opacity-20">
                        “
                      </span>
                      {selectedCard.flavorText}
                      <span className="absolute -bottom-4 right-0 text-4xl text-blue-500 opacity-20">
                        ”
                      </span>
                    </div>
                  )}

                  {/* GRID DE DETALLES TÉCNICOS */}
                  <div className="grid grid-cols-2 gap-4">
                    {/* Rareza */}
                    <div className="bg-gray-800/50 p-3 rounded-xl border border-gray-700/50">
                      <p className="text-gray-500 text-[10px] uppercase font-bold">
                        Rareza
                      </p>
                      <p className="text-white font-medium flex items-center gap-2">
                        💎 {selectedCard.rarity || "Común"}
                      </p>
                    </div>

                    {/* Artista */}
                    <div className="bg-gray-800/50 p-3 rounded-xl border border-gray-700/50">
                      <p className="text-gray-500 text-[10px] uppercase font-bold">
                        Ilustrador
                      </p>
                      <p className="text-white font-medium truncate flex items-center gap-2">
                        🖌️ {selectedCard.artist || "Desconocido"}
                      </p>
                    </div>

                    {/* Set / Expansión */}
                    <div className="col-span-2 bg-gray-800/50 p-3 rounded-xl border border-gray-700/50 flex items-center gap-3">
                      {(() => {
                        const setId = selectedCard.set_id || selectedCard.set?.id;
                        // 👈 CAMBIADO: Usamos dbSets
                        const setInfo = dbSets.find((s) => s.id === setId);
                        
                        return (
                          <>
                            {setInfo && (
                              <img
                                // 👈 CAMBIADO: Usamos setInfo.images.logo
                                src={setInfo.images?.logo} 
                                className="h-6 w-auto opacity-80"
                              />
                            )}
                            <div>
                              <p className="text-gray-500 text-[10px] uppercase font-bold">
                                Expansión
                              </p>
                              <p className="text-white font-medium">
                                {setInfo?.name ||
                                  selectedCard.set?.name ||
                                  setId}
                                <span className="text-gray-500 text-sm ml-2">
                                  #{selectedCard.number}
                                </span>
                              </p>
                            </div>
                          </>
                        );
                      })()}
                    </div>
                  </div>
                </div>

                {/* PIE DE PÁGINA: ESTÉTICO */}
                <div className="p-6 border-t border-gray-800 text-center">
                  <p className="text-[10px] text-gray-600 uppercase tracking-widest">
                    Pokémon TCG Simulator • {new Date().getFullYear()}
                  </p>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </main>
  );
}
