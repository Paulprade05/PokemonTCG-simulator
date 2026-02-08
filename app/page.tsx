// src/app/page.tsx
"use client";

import { useState, useEffect } from "react";
import { AnimatePresence, motion } from "framer-motion"; 
import { getCardsFromSet } from "../services/pokemon";
// --- CAMBIO 1: IMPORTAMOS LAS NUEVAS FUNCIONES ---
import { openStandardPack, openPremiumPack, openGoldenPack } from "../utils/packLogic";
import { saveToCollection, getCollection } from "../utils/storage"; // Necesitamos getCollection para el sobre dorado
import { useCurrency } from "../hooks/useGameCurrency";
import { AVAILABLE_SETS } from "../utils/constanst";
import PokemonCard from "../components/PokemonCard";
import Link from "next/link";

export default function Home() {
  const { coins, spendCoins } = useCurrency();

  const [selectedSet, setSelectedSet] = useState<string | null>(null);
  const [allCards, setAllCards] = useState<any[]>([]);
  const [userCollectionIds, setUserCollectionIds] = useState<string[]>([]); // Para saber qué tiene el usuario

  // --- ESTADOS PARA LA APERTURA ---
  const [currentPack, setCurrentPack] = useState<any[]>([]);
  const [packIndex, setPackIndex] = useState(0); 
  const [isPackOpen, setIsPackOpen] = useState(false); 
  const [cardRevealed, setCardRevealed] = useState(false); 
  // --------------------------------

  const [loading, setLoading] = useState(false);
  const [packSaved, setPackSaved] = useState(false);

  // Cargar colección del usuario al montar (para el sobre dorado)
  useEffect(() => {
    const col = getCollection();
    setUserCollectionIds(col.map((c: any) => c.id));
  }, [packSaved]); // Recargamos si guarda un pack nuevo

 // src/app/page.tsx

// En src/app/page.tsx (dentro de tu componente)

const handleSelectSet = async (setId: string) => {
    setLoading(true); // <--- Esto le dice a React: "¡Pinta el cargando!"
    setSelectedSet(setId); 
    
    try {
        const data = await getCardsFromSet(setId);
        
        // Verificamos si realmente han llegado cartas
        if (!data || data.length === 0) {
            throw new Error("La API no devolvió cartas.");
        }

        setAllCards(data);
        resetPackState();
    } catch (error) {
        console.error("Error cargando set:", error);
        alert("❌ Error de conexión o límite de API.\n\nInténtalo de nuevo en unos minutos.");
        setSelectedSet(null); 
        setAllCards([]);
    } finally {
        setLoading(false); // <--- Esto le dice: "¡Ya terminé, quita el cargando!"
    }
};

  const resetPackState = () => {
    setCurrentPack([]);
    setPackIndex(0);
    setIsPackOpen(false);
    setCardRevealed(false);
    setPackSaved(false);
  };

  // --- LÓGICA UNIFICADA DE APERTURA ---
  // src/app/page.tsx

const handleBuyPack = (type: 'STANDARD' | 'PREMIUM' | 'GOLDEN') => {
    // 1. SEGURIDAD: ¿Tenemos cartas para abrir?
    if (!allCards || allCards.length === 0) {
        alert("⚠️ Error: Las cartas no se han cargado correctamente.\n\nPor favor, recarga la página o elige otra expansión.");
        return; // ¡AQUÍ PARAMOS ANTES DE COBRAR!
    }

    let price = 0;
    let newPack: any[] = [];

    // 2. Configurar precios
    if (type === 'STANDARD') {
        price = 50;
        // Solo generamos el pack SI tenemos dinero, pero no cobramos aún
        if (coins >= price) newPack = openStandardPack(allCards);
    } 
    else if (type === 'PREMIUM') {
        price = 200;
        if (coins >= price) newPack = openPremiumPack(allCards);
    } 
    else if (type === 'GOLDEN') {
        price = 2500;
        if (coins >= price) newPack = openGoldenPack(allCards, userCollectionIds);
    }

    // 3. Comprobar saldo
    if (coins < price) {
        alert("¡No tienes suficientes monedas!");
        return;
    }

    // 4. TRANSACCIÓN: Solo cobramos si todo lo anterior ha ido bien
    if (spendCoins(price)) {
        setCurrentPack(newPack);
        setPackIndex(0);
        setCardRevealed(false);
        setIsPackOpen(true);
        setPackSaved(false);
    }
};

  const handleNextCard = () => {
    if (!cardRevealed) {
      setCardRevealed(true);
      return;
    }
    if (packIndex < 9) {
      setCardRevealed(false);
      setPackIndex((prev) => prev + 1);
    } else {
      saveToCollection(currentPack);
      setPackSaved(true);
      setIsPackOpen(false);
    }
  };

  const handleBackToMenu = () => {
    setSelectedSet(null);
    setAllCards([]);
    resetPackState();
  };

  return (
    <main className="flex min-h-screen flex-col items-center p-8 bg-gray-900 text-white overflow-hidden">
      
      {/* Cabecera */}
      <div className="w-full max-w-6xl flex justify-between items-center mb-8 bg-gray-800 p-4 rounded-xl shadow-md border border-gray-700 z-10">
        <div className="flex items-center gap-2">
          <span className="text-2xl">💰</span>
          <span className="text-xl font-bold text-yellow-400">{coins}</span>
        </div>
        <Link href="/collection" className="bg-gray-700 hover:bg-gray-600 px-4 py-2 rounded text-sm transition">
            Ver Álbum 📒
        </Link>
      </div>

      {/* VISTA 1: MENÚ DE SELECCIÓN DE EXPANSIÓN */}
      {!selectedSet && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 max-w-6xl w-full">
          {AVAILABLE_SETS.map((set) => (
            <button
              key={set.id}
              onClick={() => handleSelectSet(set.id)}
              className="bg-gray-800 p-6 rounded-xl hover:bg-gray-700 hover:scale-105 transition-all border border-gray-700 flex flex-col items-center gap-4 group"
            >
              <img src={set.logo} alt={set.name} className="h-24 object-contain group-hover:drop-shadow-[0_0_15px_rgba(255,255,255,0.5)] transition" />
              <span className="font-bold text-lg text-gray-300">{set.name}</span>
            </button>
          ))}
        </div>
      )}

      {/* VISTA 2: TIENDA DE SOBRES */}
      {selectedSet && !isPackOpen && !currentPack.length && (
         <div className="w-full max-w-5xl flex flex-col items-center animate-fade-in-up">
            <button onClick={handleBackToMenu} className="mb-8 text-gray-400 hover:text-white underline">← Cambiar Expansión</button>
            
            <h2 className="text-3xl font-bold mb-8 text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-purple-500">
                Elige tu sobre
            </h2>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-8 w-full">
                
                {/* --- OPCIÓN 1: BÁSICO --- */}
                <div className="bg-gray-800 border border-gray-600 rounded-2xl p-6 flex flex-col items-center hover:scale-105 transition shadow-lg group cursor-pointer"
                     onClick={() => handleBuyPack('STANDARD')}>
                    <div className="text-6xl mb-4 group-hover:animate-bounce">🃏</div>
                    <h3 className="text-xl font-bold text-white">Estándar</h3>
                    <p className="text-sm text-gray-400 text-center mb-4">Probabilidades oficiales. Bueno para empezar.</p>
                    <button className="mt-auto bg-blue-600 text-white font-bold py-2 px-6 rounded-full w-full hover:bg-blue-500">
                        50 💰
                    </button>
                </div>

                {/* --- OPCIÓN 2: ÉLITE --- */}
                <div className="bg-gray-900 border border-purple-500 rounded-2xl p-6 flex flex-col items-center hover:scale-105 transition shadow-[0_0_20px_rgba(168,85,247,0.3)] group cursor-pointer relative overflow-hidden"
                     onClick={() => handleBuyPack('PREMIUM')}>
                    <div className="absolute top-0 right-0 bg-purple-600 text-xs font-bold px-2 py-1 rounded-bl">MEJORADO</div>
                    <div className="text-6xl mb-4 group-hover:animate-pulse">✨</div>
                    <h3 className="text-xl font-bold text-purple-300">Élite</h3>
                    <p className="text-sm text-gray-400 text-center mb-4">
                        ¡Sin cartas comunes! <br/> 2 Raras aseguradas.
                    </p>
                    <button className="mt-auto bg-purple-600 text-white font-bold py-2 px-6 rounded-full w-full hover:bg-purple-500">
                        200 💰
                    </button>
                </div>

                {/* --- OPCIÓN 3: LEYENDA --- */}
                <div className="bg-gradient-to-b from-yellow-900 to-black border border-yellow-500 rounded-2xl p-6 flex flex-col items-center hover:scale-105 transition shadow-[0_0_30px_rgba(234,179,8,0.4)] group cursor-pointer relative"
                     onClick={() => handleBuyPack('GOLDEN')}>
                    <div className="absolute top-0 left-0 w-full bg-yellow-600 text-black text-xs font-bold text-center py-1">GARANTIZA CARTA NUEVA</div>
                    <div className="text-6xl mb-4 mt-2 group-hover:rotate-12 transition">👑</div>
                    <h3 className="text-xl font-bold text-yellow-400">Leyenda</h3>
                    <p className="text-sm text-yellow-200/80 text-center mb-4">
                        Garantiza 1 carta que NO tengas en tu álbum.
                    </p>
                    <button className="mt-auto bg-yellow-600 text-black font-bold py-2 px-6 rounded-full w-full hover:bg-yellow-500">
                        2500 💰
                    </button>
                </div>
                {/* --- PEGA ESTO AQUÍ AL FINAL, ANTES DE CERRAR EL MAIN --- */}
      {loading && (
        <div className="fixed inset-0 bg-black/90 z-[100] flex flex-col items-center justify-center backdrop-blur-md">
            <div className="text-6xl animate-bounce mb-4">🔮</div>
            <h2 className="text-2xl font-bold text-yellow-400 animate-pulse">Invocando Cartas...</h2>
            <p className="text-gray-400 mt-2 font-mono text-sm">Conectando con el servidor...</p>
        </div>
      )}

            </div>
         </div>
      )}


      {/* VISTA 3: MESA DE JUEGO (APERTURA) */}
      {isPackOpen && (
        <div className="w-full max-w-6xl flex flex-col items-center relative min-h-[600px]">
          
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
                    <PokemonCard card={currentPack[packIndex]} reveal={cardRevealed} />
                  </div>
                </motion.div>
              </AnimatePresence>
              
              {/* Indicador de carta garantizada (Solo visual para el pack dorado) */}
              {coins >= 2500 && packIndex === 9 && (
                   <div className="absolute top-10 text-yellow-400 font-bold animate-bounce tracking-widest">
                       ¡CARTA GARANTIZADA!
                   </div>
              )}

              <div className="absolute bottom-10 text-gray-400 font-mono text-sm bg-black/50 px-4 py-2 rounded-full">
                Carta {packIndex + 1} / 10
              </div>
          </div>
        </div>
      )}

      {/* VISTA 4: RESUMEN FINAL */}
      {!isPackOpen && currentPack.length > 0 && (
          <div className="flex flex-col items-center w-full max-w-6xl animate-fade-in-up">
            <div className="flex gap-4 mb-6">
                <h2 className="text-2xl font-bold text-white">¡Apertura completada!</h2>
                <button onClick={() => setCurrentPack([])} className="bg-gray-600 hover:bg-gray-500 px-6 py-2 rounded-full">
                    Abrir otro
                </button>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4 w-full pb-20">
                {currentPack.map((card, index) => (
                    <div key={index} className="scale-95 hover:scale-100 transition">
                        <PokemonCard card={card} reveal={true} />
                    </div>
                ))}
            </div>
          </div>
      )}
    </main>
  );
}