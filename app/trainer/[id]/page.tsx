"use client";

import { useEffect, useState, useMemo } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { getTrainerCollection } from "../../action";
import { RARITY_RANK } from "../../../utils/constanst";
import PokemonCard from "../../../components/PokemonCard";

export default function TrainerProfilePage() {
  const params = useParams();
  const trainerId = params.id as string;
  
  const [cards, setCards] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [sortBy, setSortBy] = useState("rarity_desc");

  useEffect(() => {
    async function loadTrainer() {
      setLoading(true);
      const trainerCards = await getTrainerCollection(trainerId);
      setCards(trainerCards);
      setLoading(false);
    }
    loadTrainer();
  }, [trainerId]);

  const processedCards = useMemo(() => {
    let result = [...cards];
    if (searchTerm) {
      result = result.filter((c) => c.name.toLowerCase().includes(searchTerm.toLowerCase()));
    }
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
  }, [cards, searchTerm, sortBy]);

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-900 flex flex-col items-center justify-center text-white">
        <div className="text-4xl animate-bounce mb-4">👀</div>
        <p className="animate-pulse">Cargando colección del entrenador...</p>
      </div>
    );
  }

  return (
    <main className="min-h-screen bg-gray-900 text-white p-8 pb-32 select-none">
      
      {/* CABECERA PÚBLICA */}
      <div className="w-full max-w-7xl mx-auto sticky top-4 z-50 bg-gray-800 p-4 rounded-xl shadow-xl border border-gray-700 mb-8 flex justify-between items-center">
        <div className="flex items-center gap-4">
          <Link href="/" className="bg-gray-700 hover:bg-gray-600 w-10 h-10 flex items-center justify-center rounded-lg border border-gray-600 transition shadow">
            🏠
          </Link>
          <div>
            <h1 className="text-xl md:text-2xl font-bold text-white tracking-wide">Colección de Amigo</h1>
            <p className="text-xs text-gray-400 font-mono">ID: {trainerId}</p>
          </div>
        </div>
        <div className="bg-blue-600/20 border border-blue-500 text-blue-400 px-4 py-2 rounded-full font-bold text-sm flex items-center gap-2">
          <span>{cards.length} Cartas</span>
        </div>
      </div>

      {/* TOOLBAR */}
      <div className="max-w-7xl mx-auto mb-6 flex flex-wrap gap-2 items-center bg-gray-800 p-2 rounded-lg border border-gray-700">
        <input
          type="text"
          placeholder="🔍 Buscar..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="bg-gray-900 text-white px-3 py-1.5 rounded border border-gray-600 focus:border-blue-400 outline-none text-sm w-full md:w-auto"
        />
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

      {/* GRID CARTAS (SOLO LECTURA) */}
      {processedCards.length === 0 ? (
        <div className="text-center py-20 text-gray-500">
          <p>Este entrenador aún no tiene cartas.</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-6 max-w-7xl mx-auto">
          {processedCards.map((card) => (
            <div key={card.id} className="relative group">
              {card.quantity > 1 && (
                <div className="absolute -top-2 -right-2 z-30 bg-blue-600 text-white text-xs font-bold w-6 h-6 flex items-center justify-center rounded-full border border-white shadow-lg">
                  {card.quantity}
                </div>
              )}
              {card.is_favorite && (
                <div className="absolute -top-2 -left-2 z-30 text-xl filter drop-shadow-md">
                  ❤️
                </div>
              )}
              <div className="pointer-events-none transition transform group-hover:scale-105 duration-300">
                <PokemonCard card={card} reveal={true} />
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}