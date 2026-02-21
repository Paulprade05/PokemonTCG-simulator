// src/app/page.tsx
"use client";

import {
  useUser,
  SignInButton,
  SignedIn,
  SignedOut,
  UserButton,
} from "@clerk/nextjs";
import { AnimatePresence, motion } from "framer-motion";
import Link from "next/link";
import { useState, useEffect, useMemo } from "react";
import {
  getUserData,
  updateCoins,
  syncSetToDatabase,
  savePackToCollection,
  getSetsFromDB, // 👈 1. IMPORTAMOS LA NUEVA FUNCIÓN
} from "./action";
import { getCardsFromSet } from "../services/pokemon";
import {
  openStandardPack,
  openPremiumPack,
  openGoldenPack,
} from "../utils/packLogic";
import { saveToCollection } from "../utils/storage";
import { useCurrency } from "../hooks/useGameCurrency";
import PokemonCard from "../components/PokemonCard";
// 👈 2. ELIMINADO EL IMPORT DE 'AVAILABLE_SETS'

export default function Home() {
  const { coins, setCoins, spendCoins } = useCurrency();
  const { isSignedIn, isLoaded } = useUser();

  // 👈 3. NUEVO ESTADO PARA GUARDAR LOS SETS DE LA BD
  const [dbSets, setDbSets] = useState<any[]>([]);

  const [selectedSet, setSelectedSet] = useState<string | null>(null);
  const [allCards, setAllCards] = useState<any[]>([]);
  const [userCollectionIds, setUserCollectionIds] = useState<string[]>([]);
  const [currentPackType, setCurrentPackType] = useState<
    "STANDARD" | "PREMIUM" | "GOLDEN" | null
  >(null);
  const [currentPack, setCurrentPack] = useState<any[]>([]);
  const [packIndex, setPackIndex] = useState(0);
  const [isPackOpen, setIsPackOpen] = useState(false);
  const [cardRevealed, setCardRevealed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [packSaved, setPackSaved] = useState(false);
// 👈 AÑADE ESTO JUSTO ANTES DEL return (
  const currentSetObj = dbSets.find((s) => s.id === selectedSet);
  const isSpecialSet = currentSetObj ? (
    currentSetObj.name.toLowerCase().includes("promos") ||
    currentSetObj.name.toLowerCase().includes("gallery") ||
    currentSetObj.series === "POP" ||
    currentSetObj.series === "Other" ||
    currentSetObj.total < 69 // Sets muy pequeños como Celebrations o Detective Pikachu
  ) : false;
  // 👈 4. NUEVO EFECTO: CARGAR SETS AL ABRIR LA PÁGINA
  useEffect(() => {
    const loadSets = async () => {
      const sets = await getSetsFromDB();
      setDbSets(sets);
    };
    loadSets();
  }, []);

  // Sincronizar Monedas con la BD
  useEffect(() => {
    const syncUserData = async () => {
      if (isSignedIn && isLoaded) {
        const data = await getUserData();
        if (data) setCoins(data.coins);
      }
    };
    syncUserData();
  }, [isSignedIn, isLoaded, setCoins]);

  // Cargar cartas al seleccionar un set
  useEffect(() => {
    async function loadAndSync() {
      if (!selectedSet) return;
      setLoading(true);
      try {
        const cards = await getCardsFromSet(selectedSet);
        if (cards && cards.length > 0) {
          setAllCards(cards);
          syncSetToDatabase(selectedSet, cards).catch((err) =>
            console.error("Fallo sync:", err),
          );
        }
      } catch (err) {
        console.error("Fallo al invocar cartas:", err);
      } finally {
        setLoading(false);
      }
    }
    loadAndSync();
  }, [selectedSet]);

  // 👈 5. MODIFICADO: Agrupar usando 'dbSets' en lugar de 'AVAILABLE_SETS'
  const setsBySeries = useMemo(() => {
    const groups: Record<string, any[]> = {};
    dbSets.forEach((set) => {
      const seriesName = set.series || "Otras";
      if (!groups[seriesName]) groups[seriesName] = [];
      groups[seriesName].push(set);
    });
    return groups;
  }, [dbSets]);

  const handleSelectSet = (setId: string) => {
    setSelectedSet(setId);
    resetPackState();
  };

  const resetPackState = () => {
    setCurrentPack([]);
    setPackIndex(0);
    setIsPackOpen(false);
    setCardRevealed(false);
    setPackSaved(false);
  };

  // Añadimos "SPECIAL" a las opciones
  const handleBuyPack = async (type: "STANDARD" | "PREMIUM" | "GOLDEN" | "SPECIAL") => {
    if (!allCards || allCards.length === 0) {
      alert("⚠️ Error: Las cartas no se han cargado. Recarga la página.");
      return;
    }

    let price = 0;
    let newPack: any[] = [];

    if (type === "STANDARD") {
      price = 50;
      if (coins >= price) newPack = openStandardPack(allCards);
    } else if (type === "PREMIUM") {
      price = 200;
      if (coins >= price) newPack = openPremiumPack(allCards);
    } else if (type === "GOLDEN") {
      price = 2500;
      if (coins >= price) newPack = openGoldenPack(allCards, userCollectionIds);
    } else if (type === "SPECIAL") {
      // 👇 LÓGICA DEL SOBRE ESPECIAL
      price = 2500;
      if (coins >= price) newPack = openGoldenPack(allCards, userCollectionIds);
    }

    if (coins < price) {
      alert("¡No tienes suficientes monedas!");
      return;
    }

    if (spendCoins(price)) {
      if (isSignedIn) await updateCoins(coins - price);
      setCurrentPackType(type as any);
      setCurrentPack(newPack);
      setPackIndex(0);
      setCardRevealed(false);
      setIsPackOpen(true);
      setPackSaved(false);
    }
  };

  const handleNextCard = async () => {
    if (!cardRevealed) {
      setCardRevealed(true);
      return;
    }

    if (packIndex < 9) {
      setCardRevealed(false);
      setPackIndex((prev) => prev + 1);
    } else {
      if (isSignedIn) {
        await savePackToCollection(currentPack);
      } else {
        saveToCollection(currentPack);
      }
      setPackSaved(true);
      setIsPackOpen(false);
    }
  };

  const handleBackToMenu = () => {
    setSelectedSet(null);
    setAllCards([]);
    resetPackState();
  };

  // ... AQUÍ EMPIEZA TU RETURN ORIGINAL ...
  // (Asegúrate de cambiar set.logo por set.images?.logo en el renderizado HTML de los sets)
  // --- RENDERIZADO ---
  return (
    <main className="flex min-h-screen flex-col items-center p-8 bg-gray-900 text-white overflow-hidden select-none" >
      {/* CABECERA */}
      <div className="w-full max-w-6xl flex justify-between items-center mb-8 bg-gray-800 p-4 rounded-xl shadow-md border border-gray-700 z-10">
        <div className="flex items-center gap-2">
          <span className="text-2xl">💰</span>
          <span className="text-xl font-bold text-yellow-400">
            {/* Mostramos '...' mientras carga el usuario para que no se vea el salto de 500 a X */}
            {!isLoaded ? "..." : coins}
          </span>
        </div>

        {/* LOGIN DE CLERK */}
        <div className="flex gap-4 items-center">
          <SignedOut>
            <SignInButton mode="modal">
              <button className="bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-lg font-bold transition">
                Iniciar Sesión 👤
              </button>
            </SignInButton>
          </SignedOut>

          <SignedIn>
            <div className="flex items-center gap-2 bg-gray-700/50 px-3 py-1 rounded-full border border-gray-600">
              <span className="text-sm text-gray-300 mr-2 hidden sm:inline">
                Entrenador
              </span>
              <UserButton />
            </div>
          </SignedIn>

          <Link
            href="/collection"
            className="bg-gray-700 hover:bg-gray-600 px-4 py-2 rounded text-sm transition"
          >
            Ver Álbum 📒
          </Link>
        </div>
      </div>

      {/* VISTA 1: SELECCIÓN DE EXPANSIÓN (CLASIFICADA) */}
      {!selectedSet && (
        <div className="w-full max-w-6xl flex flex-col gap-12 animate-fade-in-up pb-20">
          {/* Iteramos por cada Serie (Escarlata, Espada...) */}
          {Object.entries(setsBySeries).map(([seriesName, sets]) => (
            <div key={seriesName} className="flex flex-col gap-4">
              {/* Título de la Generación */}
              <div className="flex items-center gap-4">
                <h2 className="text-3xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-purple-400 uppercase tracking-wider">
                  {seriesName}
                </h2>
                <div className="h-px bg-gray-700 flex-1"></div>
              </div>

              {/* Grid de Sets de esa generación */}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                {sets.map((set) => (
                  <button
                    key={set.id}
                    onClick={() => handleSelectSet(set.id)}
                    className="bg-gray-800 p-6 rounded-xl hover:bg-gray-700 hover:scale-105 transition-all border border-gray-700 flex flex-col items-center gap-4 group shadow-lg relative overflow-hidden"
                  >
                    {/* Efecto de brillo al pasar el ratón */}
                    <div className="absolute inset-0 bg-white/5 opacity-0 group-hover:opacity-100 transition duration-500"></div>

                    <img
                      src={set.images?.logo}
                      alt={set.name}
                      className="h-24 object-contain group-hover:drop-shadow-[0_0_15px_rgba(255,255,255,0.5)] transition relative z-10"
                    />
                    <span className="font-bold text-lg text-gray-300 relative z-10">
                      {set.name}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* VISTA 2: TIENDA DE SOBRES */}
      {selectedSet && !isPackOpen && !currentPack.length && (
        <div className="w-full max-w-5xl flex flex-col items-center animate-fade-in-up">
          <button
            onClick={handleBackToMenu}
            className="mb-8 text-gray-400 hover:text-white underline transition"
          >
            ← Cambiar Expansión
          </button>

          <h2 className="text-3xl font-bold mb-8 text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-purple-500">
            {isSpecialSet ? "Edición Especial" : "Elige tu sobre"}
          </h2>

          <div className={`grid grid-cols-1 ${isSpecialSet ? 'max-w-md' : 'md:grid-cols-3'} gap-8 w-full px-4`}>
            
            {isSpecialSet ? (
              <div
                className="bg-gradient-to-b from-blue-900 to-black border border-blue-500 rounded-2xl p-6 flex flex-col items-center hover:scale-105 transition shadow-[0_0_30px_rgba(59,130,246,0.4)] group cursor-pointer relative"
                onClick={() => handleBuyPack("SPECIAL")}
              >
                <div className="absolute top-0 left-0 w-full bg-blue-600 text-white text-xs font-bold text-center py-1 shadow-sm rounded-t-xl">
                  COLECCIÓN EXCLUSIVA
                </div>
                <div className="text-6xl mb-4 mt-6 group-hover:scale-110 transition transform">
                  🌟
                </div>
                <h3 className="text-2xl font-bold text-blue-400">Sobre Promo</h3>
                <p className="text-sm text-blue-200/80 text-center mb-6 mt-2">
                  100% Garantizado: <br/> 1 Carta que no tienes.
                </p>
                <button className="mt-auto bg-blue-600 text-white font-bold py-3 px-6 rounded-full w-full hover:bg-blue-500 shadow-lg shadow-blue-900/50">
                  2500 💰
                </button>
              </div>
            ) : (
              <>
                <div
                  className="bg-gray-800 border border-gray-600 rounded-2xl p-6 flex flex-col items-center hover:scale-105 transition shadow-lg group cursor-pointer"
                  onClick={() => handleBuyPack("STANDARD")}
                >
                  <div className="text-6xl mb-4 group-hover:animate-bounce">🃏</div>
                  <h3 className="text-xl font-bold text-white">Estándar</h3>
                  <p className="text-sm text-gray-400 text-center mb-4 mt-2">
                    Probabilidades oficiales.<br />Ideal para empezar.
                  </p>
                  <button className="mt-auto bg-blue-600 text-white font-bold py-2 px-6 rounded-full w-full hover:bg-blue-500 shadow-md">
                    50 💰
                  </button>
                </div>

                <div
                  className="bg-gray-900 border border-purple-500 rounded-2xl p-6 flex flex-col items-center hover:scale-105 transition shadow-[0_0_20px_rgba(168,85,247,0.3)] group cursor-pointer relative overflow-hidden"
                  onClick={() => handleBuyPack("PREMIUM")}
                >
                  <div className="absolute top-0 right-0 bg-purple-600 text-xs font-bold px-2 py-1 rounded-bl">
                    MEJORADO
                  </div>
                  <div className="text-6xl mb-4 group-hover:animate-pulse">✨</div>
                  <h3 className="text-xl font-bold text-purple-300">Élite</h3>
                  <p className="text-sm text-gray-400 text-center mb-4 mt-2">
                    ¡Sin cartas comunes! <br /> 2 Raras aseguradas.
                  </p>
                  <button className="mt-auto bg-purple-600 text-white font-bold py-2 px-6 rounded-full w-full hover:bg-purple-500 shadow-lg shadow-purple-900/50">
                    200 💰
                  </button>
                </div>

                <div
                  className="bg-gradient-to-b from-yellow-900 to-black border border-yellow-500 rounded-2xl p-6 flex flex-col items-center hover:scale-105 transition shadow-[0_0_30px_rgba(234,179,8,0.4)] group cursor-pointer relative"
                  onClick={() => handleBuyPack("GOLDEN")}
                >
                  <div className="absolute top-0 left-0 w-full bg-yellow-600 text-black text-xs font-bold text-center py-1 shadow-sm rounded-t-xl">
                    GARANTIZA CARTA NUEVA
                  </div>
                  <div className="text-6xl mb-4 mt-6 group-hover:rotate-12 transition transform">
                    👑
                  </div>
                  <h3 className="text-xl font-bold text-yellow-400">Leyenda</h3>
                  <p className="text-sm text-yellow-200/80 text-center mb-4 mt-2">
                    100% Garantizado:<br />1 carta que NO tienes.
                  </p>
                  <button className="mt-auto bg-yellow-600 text-black font-bold py-2 px-6 rounded-full w-full hover:bg-yellow-500 shadow-lg shadow-yellow-900/50">
                    2500 💰
                  </button>
                </div>
              </>
            )}
          </div>

          {/* LOADER */}
          {loading && (
            <div className="fixed inset-0 bg-black/90 z-[100] flex flex-col items-center justify-center backdrop-blur-md">
              <div className="text-6xl animate-bounce mb-4">🔮</div>
              <h2 className="text-2xl font-bold text-yellow-400 animate-pulse">
                Invocando Cartas...
              </h2>
              <p className="text-gray-400 mt-2 font-mono text-sm">
                Conectando con el servidor...
              </p>
            </div>
          )}
        </div>
      )}

      {/* VISTA 3: APERTURA DE SOBRE */}
      {isPackOpen && (
        <div className="w-full max-w-6xl flex flex-col items-center relative min-h-[600px] justify-center">
          <div className="relative w-full h-[500px] flex justify-center items-center perspective-1000">
            <AnimatePresence mode="wait">
              <motion.div
                key={packIndex}
                initial={{ x: 300, opacity: 0, rotate: 20 }}
                animate={{ x: 0, opacity: 1, rotate: 0 }}
                exit={{ x: -300, opacity: 0, rotate: -20 }}
                transition={{ type: "spring", stiffness: 200, damping: 20 }}
                className="absolute z-20 w-64 aspect-[2.5/3.5] cursor-pointer"
                onClick={handleNextCard}
              >
                <div className="w-full h-full pointer-events-none">
                  <PokemonCard
                    card={currentPack[packIndex]}
                    reveal={cardRevealed}
                    useHighRes={true} // 👈 ¡ACTIVAMOS ALTA DEFINICIÓN!
                  />
                </div>
              </motion.div>
            </AnimatePresence>

            {currentPackType === "GOLDEN" && packIndex === 9 && (
              <div className="absolute top-10 text-yellow-400 font-bold animate-bounce tracking-widest bg-black/50 px-4 py-2 rounded-full border border-yellow-500">
                ¡CARTA GARANTIZADA!
              </div>
            )}

            <div className="absolute bottom-5 text-gray-400 font-mono text-sm bg-black/50 px-4 py-2 rounded-full backdrop-blur-sm border border-gray-700">
              Carta {packIndex + 1} / 10
            </div>
          </div>
          <p className="text-gray-500 mt-4 animate-pulse">
            Toca la carta para revelar / siguiente
          </p>
        </div>
      )}

      {/* VISTA 4: RESUMEN FINAL */}
      {!isPackOpen && currentPack.length > 0 && (
        <div className="flex flex-col items-center w-full max-w-6xl animate-fade-in-up pb-20">
          <div className="flex flex-col md:flex-row gap-6 mb-8 items-center">
            <h2 className="text-3xl font-bold text-white">
              ¡Apertura completada!
            </h2>
            <div className="flex gap-4">
              <button
                onClick={() => {
                  setCurrentPack([]);
                  // Opcional: Volver a comprar automáticamente si hay dinero
                }}
                className="bg-blue-600 hover:bg-blue-500 px-6 py-2 rounded-full font-bold shadow-lg transition"
              >
                Abrir otro igual 🔄
              </button>
              <button
                onClick={handleBackToMenu}
                className="bg-gray-700 hover:bg-gray-600 px-6 py-2 rounded-full transition"
              >
                Volver al menú
              </button>
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-5 gap-4 w-full">
            {currentPack.map((card, index) => (
              <div
                key={index}
                className="scale-95 hover:scale-100 transition duration-300"
              >
                <PokemonCard card={card} reveal={true} 
                  useHighRes={true} // 👈 ¡ACTIVAMOS ALTA DEFINICIÓN!
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </main>
  );
}
