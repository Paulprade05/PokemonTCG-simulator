// src/app/collection/page.tsx
"use client";

import { useEffect, useState, useMemo } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useUser } from "@clerk/nextjs"; // <--- 1. Importar Clerk
// 👇 2. Importar tus acciones de servidor (Asegúrate del nombre del archivo: action o actions)
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
  const { isSignedIn, isLoaded } = useUser(); // Hook de usuario
  const [cards, setCards] = useState<any[]>([]);
  const { coins, addCoins } = useCurrency(); // Esto actualiza el contador visual localmente
  const [showStats, setShowStats] = useState(false);
  const [loading, setLoading] = useState(true); // Estado de carga
  const [searchTerm, setSearchTerm] = useState("");
  const [sortBy, setSortBy] = useState("rarity_desc");
  const [filterSet, setFilterSet] = useState("all");
  const [selectedCard, setSelectedCard] = useState<any | null>(null);

  // --- CARGA DE DATOS (BD vs LocalStorage) ---
  useEffect(() => {
    async function initCollection() {
      if (!isLoaded) return; // Esperar a que Clerk cargue

      setLoading(true);

      if (isSignedIn) {
        // ☁️ MODO NUBE: Cargar desde Postgres
        try {
          const dbCards = await getFullCollection();
          setCards(dbCards);
        } catch (error) {
          console.error("Error cargando colección:", error);
        }
      } else {
        // 💾 MODO LOCAL: Fallback a localStorage
        const localCards = getCollection();
        setCards(localCards);
      }

      setLoading(false);
    }

    initCollection();
  }, [isSignedIn, isLoaded]);

  // --- LÓGICA DE PROGRESO POR SET (Tu código original intacto) ---
  const setStats = useMemo(() => {
    return AVAILABLE_SETS.map((set) => {
      const uniqueCardsOwned = cards.filter((c) =>
        c.id.startsWith(set.id),
      ).length;
      const percentage = Math.min(
        100,
        Math.round((uniqueCardsOwned / set.total) * 100),
      );
      const missing = Math.max(0, set.total - uniqueCardsOwned);
      return { ...set, owned: uniqueCardsOwned, percentage, missing };
    });
  }, [cards]);

  // --- FILTROS Y ORDEN (Tu código original intacto) ---
  const processedCards = useMemo(() => {
    let result = [...cards];
    if (searchTerm)
      result = result.filter((c) =>
        c.name.toLowerCase().includes(searchTerm.toLowerCase()),
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

  // --- VENTA DE CARTAS (Híbrido BD + Local) ---
  const handleSellCard = async (
    e: React.MouseEvent,
    cardId: string,
    rarity: string,
  ) => {
    e.stopPropagation();

    // 🔍 BUSCAMOS LA CARTA PARA VER SU CANTIDAD
    const card = cards.find((c) => c.id === cardId);

    // 🛡️ PROTECCIÓN: Si no existe o solo tienes 1, no hacemos nada.
    if (!card || card.quantity <= 1) return;

    const price = getPrice(rarity);

    // ... (el resto de tu código sigue igual: UI Optimista, setCards, etc.) ...
    const updatedCards = cards.map((c) => {
      if (c.id === cardId) return { ...c, quantity: c.quantity - 1 };
      return c;
    }); // Nota: Ya no filtramos quantity > 0 porque sabemos que mínimo quedará 1.

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
      {/* Cabecera */}
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

      {/* --- DASHBOARD DE PROGRESO (DESPLEGABLE) --- */}
      <div className="max-w-7xl mx-auto mb-6">
        {/* BOTÓN TOGGLE */}
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
                {showStats
                  ? "Haz click para ocultar"
                  : "Haz click para ver cuánto te falta"}
              </p>
            </div>
          </div>

          {/* Flechita animada */}
          <motion.div
            animate={{ rotate: showStats ? 180 : 0 }}
            transition={{ duration: 0.3 }}
            className="text-gray-400"
          >
            ▼
          </motion.div>
        </button>

        {/* CONTENIDO DESPLEGABLE */}
        <AnimatePresence>
          {showStats && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.4, ease: "easeInOut" }}
              className="overflow-hidden"
            >
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mt-4 pb-2">
                {setStats.map((stat) => (
                  <div
                    key={stat.id}
                    className="bg-gray-800/50 p-4 rounded-xl border border-gray-700/50 flex flex-col gap-3 hover:border-gray-500 transition"
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
                          {stat.owned} / {stat.total} cartas
                        </p>
                      </div>
                    </div>

                    <div className="w-full h-2 bg-gray-700 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${stat.percentage === 100 ? "bg-green-500" : "bg-blue-500"}`}
                        style={{ width: `${stat.percentage}%` }}
                      ></div>
                    </div>

                    <div className="flex justify-between text-xs font-mono">
                      <span className="text-blue-300">{stat.percentage}%</span>
                      {stat.missing > 0 ? (
                        <span className="text-red-300">-{stat.missing}</span>
                      ) : (
                        <span className="text-green-400 font-bold">✓</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Toolbar de Filtros */}
      <div className="max-w-7xl mx-auto mb-6 flex flex-wrap gap-2 items-center bg-gray-800 p-2 rounded-lg border border-gray-700">
        <input
          type="text"
          placeholder="🔍 Buscar carta..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="bg-gray-900 text-white px-3 py-1.5 rounded border border-gray-600 focus:border-yellow-400 outline-none text-sm w-full md:w-auto"
        />
        <select
          value={filterSet}
          onChange={(e) => setFilterSet(e.target.value)}
          className="bg-gray-900 text-white px-3 py-1.5 rounded border border-gray-600 outline-none text-sm flex-1 md:flex-none"
        >
          <option value="all">🌍 Todas las Expansiones</option>
          {AVAILABLE_SETS.map((set) => (
            <option key={set.id} value={set.id}>
              {set.name}
            </option>
          ))}
        </select>
        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value)}
          className="bg-gray-900 text-white px-3 py-1.5 rounded border border-gray-600 outline-none text-sm flex-1 md:flex-none"
        >
          <option value="rarity_desc">💎 Valor</option>
          <option value="quantity_desc">🔢 Cantidad</option>
          <option value="name_asc">🔤 Nombre</option>
        </select>
      </div>

      {/* Grid de Cartas */}
      {processedCards.length === 0 ? (
        <div className="text-center py-20 text-gray-500">
          <p className="text-xl">No se encontraron cartas.</p>
          <Link href="/" className="text-blue-400 underline mt-2 inline-block">
            ¡Ve a abrir sobres!
          </Link>
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
                <PokemonCard card={card} reveal={true} />
              </div>
              <div className="mt-2 flex justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-300">
                {/* 👇 SOLO MOSTRAMOS EL BOTÓN SI TIENES DUPLICADOS (quantity > 1) 👇 */}
                {card.quantity > 1 ? (
                  <button
                    onClick={(e) => handleSellCard(e, card.id, card.rarity)}
                    className="bg-red-900/80 hover:bg-red-600 text-white text-xs py-1 px-3 rounded-full flex items-center gap-1 border border-red-400 backdrop-blur-sm z-20 transition"
                  >
                    Vender (+{getPrice(card.rarity)})
                  </button>
                ) : (
                  // Opcional: Mostrar un texto que diga "Original"
                  <span className="text-[10px] font-bold text-gray-500 bg-black/60 px-2 py-1 rounded select-none border border-gray-700">
                    🔒 Original
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* MODAL DETALLE (FICHA TÉCNICA) */}
      <AnimatePresence>
        {selectedCard && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/95 backdrop-blur-md p-4"
            onClick={() => setSelectedCard(null)}
          >
            <motion.div
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.9, y: 20 }}
              className="relative w-full max-w-5xl bg-gray-900 rounded-2xl overflow-hidden shadow-2xl border border-gray-700 flex flex-col md:flex-row max-h-[90vh]"
              onClick={(e) => e.stopPropagation()}
            >
              {/* BOTÓN CERRAR */}
              <button
                onClick={() => setSelectedCard(null)}
                className="absolute top-4 right-4 text-gray-400 hover:text-white bg-black/50 hover:bg-red-600 rounded-full w-10 h-10 flex items-center justify-center transition z-50 backdrop-blur-sm"
              >
                ✕
              </button>

              {/* COLUMNA IZQUIERDA: IMAGEN */}
              <div className="w-full md:w-1/2 p-8 bg-gradient-to-br from-gray-800 to-black flex items-center justify-center">
                <motion.img
                  layoutId={`card-${selectedCard.id}`}
                  src={selectedCard.images.large}
                  alt={selectedCard.name}
                  className="object-contain max-h-[50vh] md:max-h-[70vh] w-auto drop-shadow-[0_0_35px_rgba(255,255,255,0.15)]"
                />
              </div>

              {/* COLUMNA DERECHA: DATOS */}
              <div className="w-full md:w-1/2 p-8 flex flex-col gap-6 overflow-y-auto bg-gray-900">
                {/* CABECERA */}
                <div>
                  <div className="flex justify-between items-start">
                    <h2 className="text-4xl font-bold text-white mb-2">
                      {selectedCard.name}
                    </h2>
                    {selectedCard.hp && (
                      <span className="text-2xl font-bold text-red-500 flex items-center gap-1">
                        <span className="text-sm text-gray-400">HP</span>{" "}
                        {selectedCard.hp}
                      </span>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <span className="bg-gray-800 text-gray-300 px-3 py-1 rounded text-sm border border-gray-700">
                      {selectedCard.supertype} -{" "}
                      {selectedCard.subtypes?.join(", ")}
                    </span>
                    {selectedCard.types?.map((type: string) => (
                      <span
                        key={type}
                        className="bg-blue-900 text-blue-100 px-3 py-1 rounded text-sm border border-blue-700 font-bold"
                      >
                        {type}
                      </span>
                    ))}
                  </div>
                </div>

                <hr className="border-gray-800" />

                {/* PRECIOS Y VALOR */}
                <div className="grid grid-cols-2 gap-4">
                  <div className="bg-gray-800 p-4 rounded-xl border border-gray-700">
                    <p className="text-gray-400 text-xs uppercase tracking-wider mb-1">
                      Valor en Juego
                    </p>
                    <p className="text-2xl font-bold text-yellow-400 flex items-center gap-2">
                      {getPrice(selectedCard.rarity)} 💰
                    </p>
                    <p className="text-xs text-gray-500 mt-1">
                      Lo que obtienes al venderla
                    </p>
                  </div>
                  <div className="bg-gray-800 p-4 rounded-xl border border-gray-700">
                    <p className="text-gray-400 text-xs uppercase tracking-wider mb-1">
                      Mercado Real (USD)
                    </p>
                    <p className="text-2xl font-bold text-green-400 flex items-center gap-2">
                      $
                      {selectedCard.tcgplayer?.prices?.holofoil?.market ||
                        selectedCard.tcgplayer?.prices?.normal?.market ||
                        "---"}
                    </p>
                    <p className="text-xs text-gray-500 mt-1">
                      Precio en TCGPlayer
                    </p>
                  </div>
                </div>

                {/* DETALLES DE COLECCIONISTA */}
                <div className="space-y-3 text-sm text-gray-300">
                  <div className="flex justify-between border-b border-gray-800 pb-2">
                    <span className="text-gray-500">Rareza</span>
                    <span className="font-bold text-purple-300">
                      {selectedCard.rarity}
                    </span>
                  </div>
                  <div className="flex justify-between border-b border-gray-800 pb-2">
                    <span className="text-gray-500">Artista</span>
                    <span>{selectedCard.artist || "Desconocido"}</span>
                  </div>
                  <div className="flex justify-between border-b border-gray-800 pb-2">
                    <span className="text-gray-500">Set</span>
                    <div className="flex items-center gap-2">
                      {/* 1. Buscamos el set en tu lista de constantes (funciona con BD y con Local) */}
                      {(() => {
                        // Intentamos encontrar el set usando el ID que tenga la carta
                        const setId =
                          selectedCard.set_id || selectedCard.set?.id;
                        const setInfo = AVAILABLE_SETS.find(
                          (s) => s.id === setId,
                        );

                        // Si lo encontramos, mostramos su logo y nombre
                        if (setInfo) {
                          return (
                            <>
                              <img
                                src={setInfo.logo}
                                alt="set"
                                className="h-4 w-auto object-contain"
                              />
                              <span>{setInfo.name}</span>
                            </>
                          );
                        }

                        // Si no lo encontramos (fallback de seguridad), mostramos lo que podamos
                        return (
                          <>
                            {/* Usamos el símbolo si existe (para cartas antiguas locales) */}
                            {selectedCard.set?.images?.symbol && (
                              <img
                                src={selectedCard.set.images.symbol}
                                alt="set"
                                className="h-4 w-auto"
                              />
                            )}
                            {/* Mostramos el nombre o 'Desconocido' */}
                            <span>
                              {selectedCard.set?.name || setId || "Desconocido"}
                            </span>
                          </>
                        );
                      })()}
                    </div>
                  </div>
                  <div className="flex justify-between border-b border-gray-800 pb-2">
                    <span className="text-gray-500">Número</span>
                    <span className="font-mono">
                      {/* LÓGICA DE SEGURIDAD PARA EL TOTAL DE CARTAS */}
                      {(() => {
                        const setId =
                          selectedCard.set_id || selectedCard.set?.id;
                        // Buscamos en tus constantes (donde pusiste total: 190, total: 250, etc.)
                        const setInfo = AVAILABLE_SETS.find(
                          (s) => s.id === setId,
                        );

                        // Si lo encontramos en constantes, usamos ese. Si no, intentamos el de la carta. Si no, '???'
                        const totalCards =
                          setInfo?.total ||
                          selectedCard.set?.printedTotal ||
                          "???";

                        return `${selectedCard.number} / ${totalCards}`;
                      })()}
                    </span>
                  </div>
                </div>

                {/* POKÉDEX FLAVOR TEXT (Si existe) */}
                {selectedCard.flavorText && (
                  <div className="mt-auto bg-gray-800/50 p-4 rounded-lg italic text-gray-400 border-l-4 border-gray-600">
                    "{selectedCard.flavorText}"
                  </div>
                )}

                {/* ACCIONES */}
                <div className="mt-4 flex gap-3">
                  {selectedCard.tcgplayer?.url && (
                    <a
                      href={selectedCard.tcgplayer.url}
                      target="_blank"
                      rel="noreferrer"
                      className="flex-1 bg-gray-800 hover:bg-gray-700 text-center py-3 rounded-lg transition text-sm font-bold border border-gray-600"
                    >
                      Ver en Web Oficial ↗
                    </a>
                  )}
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </main>
  );
}
