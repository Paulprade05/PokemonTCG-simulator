"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useUser, SignedIn, UserButton } from "@clerk/nextjs";
import { getSetsFromDB, getFullCollection } from "../../action";
import { getCardsFromSet } from "../../../services/pokemon";
import { getCollection } from "../../../utils/storage";
import { useCurrency } from "../../../hooks/useGameCurrency";
import PokemonCard from "../../../components/PokemonCard";

export default function SetAlbumPage() {
  const params = useParams();
  const setId = params.setId as string;
  
  const { isSignedIn, isLoaded } = useUser();
  const { coins } = useCurrency();

  const [setInfo, setSetInfo] = useState<any>(null);
  const [allSetCards, setAllSetCards] = useState<any[]>([]);
  const [ownedCards, setOwnedCards] = useState<Map<string, any>>(new Map());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchAlbumData() {
      if (!isLoaded) return;
      setLoading(true);

      try {
        // 1. Conseguir la info de la expansión (logo, nombre)
        const sets = await getSetsFromDB();
        const currentSet = sets.find((s: any) => s.id === setId);
        if (currentSet) setSetInfo(currentSet);

        // 2. Conseguir TODAS las cartas de la expansión (La plantilla del álbum)
        const blueprintCards = await getCardsFromSet(setId);
        setAllSetCards(blueprintCards);

        // 3. Conseguir las cartas que TIENE el usuario
        let userCards = [];
        if (isSignedIn) {
          userCards = await getFullCollection();
        } else {
          userCards = getCollection();
        }

        // 4. Crear un "Diccionario" para buscar rapidísimo si tenemos la carta
        const ownedMap = new Map();
        userCards.forEach((card: any) => {
          if (card.id.startsWith(setId + "-")) {
            ownedMap.set(card.id, card);
          }
        });
        setOwnedCards(ownedMap);

      } catch (error) {
        console.error("Error cargando el álbum:", error);
      } finally {
        setLoading(false);
      }
    }

    fetchAlbumData();
  }, [setId, isSignedIn, isLoaded]);

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-900 flex flex-col items-center justify-center text-white">
        <div className="text-4xl animate-bounce mb-4">📖</div>
        <p className="animate-pulse">Abriendo álbum de la expansión...</p>
      </div>
    );
  }

  return (
    <main className="min-h-screen bg-gray-900 text-white p-8 pb-32 select-none">
      
      {/* CABECERA (Estilo Isla Flotante) */}
      <div className="w-full max-w-7xl mx-auto sticky top-4 z-50 bg-gray-800 p-4 rounded-xl shadow-xl border border-gray-700 mb-8 flex justify-between items-center transition-all">
        <div className="flex items-center gap-4">
          <Link
            href="/collection"
            className="bg-gray-700 hover:bg-gray-600 w-10 h-10 flex items-center justify-center rounded-lg border border-gray-600 transition shadow"
            title="Volver a Colecciones"
          >
            ⬅️
          </Link>
          {setInfo && (
            <img src={setInfo.images?.logo} alt="Logo" className="h-8 md:h-12 object-contain" />
          )}
        </div>

        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 bg-gray-900/60 px-4 py-2 rounded-full border border-gray-700 shadow-inner">
            <span className="text-xl drop-shadow-md">💰</span>
            <span className="font-black text-yellow-400">{coins}</span>
          </div>
          <SignedIn>
            <div className="bg-gray-700/50 p-1 rounded-full border border-gray-600 hidden sm:block">
              <UserButton />
            </div>
          </SignedIn>
        </div>
      </div>

      {/* MARCADOR DE PROGRESO */}
      <div className="max-w-7xl mx-auto mb-8 bg-gray-800 rounded-xl p-4 border border-gray-700 flex justify-between items-center shadow-lg">
        <div>
          <h2 className="text-xl font-bold text-white">Progreso del Álbum</h2>
          <p className="text-sm text-gray-400">
            Has coleccionado {ownedCards.size} de {setInfo?.total || allSetCards.length} cartas.
          </p>
        </div>
        <div className="text-3xl font-black text-yellow-400">
          {Math.round((ownedCards.size / (setInfo?.total || allSetCards.length || 1)) * 100)}%
        </div>
      </div>

      {/* GRID DE CARTAS (HUECOS Y OBTENIDAS) */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4 md:gap-6 max-w-7xl mx-auto">
        {allSetCards.map((blueprintCard) => {
          const ownedCard = ownedCards.get(blueprintCard.id);

          // SI TIENE LA CARTA: La mostramos a todo color
          if (ownedCard) {
            return (
              <div key={blueprintCard.id} className="relative group cursor-pointer transition transform hover:-translate-y-2 duration-300">
                {ownedCard.quantity > 1 && (
                  <div className="absolute -top-2 -right-2 z-30 bg-blue-600 text-white text-xs font-bold w-6 h-6 flex items-center justify-center rounded-full border border-white shadow-lg">
                    {ownedCard.quantity}
                  </div>
                )}
                <PokemonCard card={ownedCard} reveal={true} />
              </div>
            );
          }

          // SI NO LA TIENE: Mostramos el hueco vacío
          return (
            <div 
              key={blueprintCard.id} 
              className="w-full aspect-[2.5/3.5] bg-gray-900/50 border-2 border-dashed border-gray-700 rounded-xl flex flex-col items-center justify-center p-2 opacity-50 shadow-inner"
            >
              <span className="text-gray-600 text-2xl md:text-3xl mb-2">🔒</span>
              <span className="text-gray-500 font-black text-xl md:text-2xl">#{blueprintCard.number}</span>
              <span className="text-gray-600 text-[9px] md:text-[10px] uppercase text-center mt-2 font-bold px-2">
                {blueprintCard.rarity || 'Desconocida'}
              </span>
            </div>
          );
        })}
      </div>

    </main>
  );
}