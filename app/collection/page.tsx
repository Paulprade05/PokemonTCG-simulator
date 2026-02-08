// src/app/collection/page.tsx
'use client';

import { useEffect, useState, useMemo } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { getCollection, saveCollectionRaw } from '../../utils/storage';
import { useCurrency } from '../../hooks/useGameCurrency'; 
import { AVAILABLE_SETS, RARITY_RANK, SELL_PRICES } from '../../utils/constanst'; 
import PokemonCard from '../../components/PokemonCard';
import Link from 'next/link';

export default function CollectionPage() {
  const [cards, setCards] = useState<any[]>([]);
  const { coins, addCoins } = useCurrency();

  const [searchTerm, setSearchTerm] = useState('');
  const [sortBy, setSortBy] = useState('rarity_desc'); 
  const [filterSet, setFilterSet] = useState('all');
  const [selectedCard, setSelectedCard] = useState<any | null>(null);

  useEffect(() => {
    const savedCards = getCollection();
    setCards(savedCards);
  }, []);

  // --- LÓGICA DE PROGRESO POR SET ---
  // Calculamos las estadísticas dinámicamente
  const setStats = useMemo(() => {
    return AVAILABLE_SETS.map(set => {
        // Contamos cuántas cartas tienes que empiecen por el ID del set (ej: 'sv3pt5-1')
        const uniqueCardsOwned = cards.filter(c => c.id.startsWith(set.id)).length;
        const percentage = Math.min(100, Math.round((uniqueCardsOwned / set.total) * 100));
        const missing = Math.max(0, set.total - uniqueCardsOwned);
        
        return { ...set, owned: uniqueCardsOwned, percentage, missing };
    });
  }, [cards]);
  // ----------------------------------

  const processedCards = useMemo(() => {
    let result = [...cards];
    if (searchTerm) result = result.filter(c => c.name.toLowerCase().includes(searchTerm.toLowerCase()));
    if (filterSet !== 'all') result = result.filter(c => c.id.startsWith(filterSet));

    result.sort((a, b) => {
        switch (sortBy) {
            case 'name_asc': return a.name.localeCompare(b.name);
            case 'quantity_desc': return (b.quantity || 1) - (a.quantity || 1);
            case 'rarity_desc': return (RARITY_RANK[b.rarity] || 0) - (RARITY_RANK[a.rarity] || 0);
            default: return 0;
        }
    });
    return result;
  }, [cards, searchTerm, filterSet, sortBy]);

  const getPrice = (rarity: string) => SELL_PRICES[rarity] || 10;
  
  const handleSellCard = (e: React.MouseEvent, cardId: string, rarity: string) => {
    e.stopPropagation();
    const price = getPrice(rarity);
    const updatedCards = cards.map(card => {
        if (card.id === cardId) return { ...card, quantity: (card.quantity || 1) - 1 };
        return card;
    }).filter(card => card.quantity > 0);

    setCards(updatedCards);
    saveCollectionRaw(updatedCards); 
    addCoins(price);
  };

  return (
    <main className="min-h-screen bg-gray-900 text-white p-8 pb-32">
      
      {/* Cabecera */}
      <div className="sticky top-0 z-40 bg-gray-900/95 backdrop-blur-md border-b border-gray-700 py-4 mb-8 -mx-8 px-8 shadow-2xl flex justify-between items-center">
         <div className="flex items-center gap-4">
            <Link href="/" className="bg-gray-800 hover:bg-gray-700 p-2 rounded-full transition">🏠</Link>
            <h1 className="text-2xl font-bold text-yellow-400">Mi Álbum</h1>
         </div>
         <div className="bg-gray-800 px-4 py-1.5 rounded-full border border-gray-600 flex items-center gap-2">
            <span>💰</span><span className="font-bold text-yellow-400">{coins}</span>
         </div>
      </div>

      {/* --- NUEVO: DASHBOARD DE PROGRESO --- */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-10 max-w-7xl mx-auto">
        {setStats.map((stat) => (
            <div key={stat.id} className="bg-gray-800 p-4 rounded-xl border border-gray-700 flex flex-col gap-3 shadow-lg hover:border-gray-500 transition">
                <div className="flex items-center gap-3">
                    <img src={stat.logo} alt={stat.name} className="h-8 object-contain" />
                    <div className="flex-1">
                        <h3 className="font-bold text-sm text-gray-200">{stat.name}</h3>
                        <p className="text-xs text-gray-400">
                            {stat.owned} / {stat.total} cartas
                        </p>
                    </div>
                </div>
                
                {/* Barra de Progreso */}
                <div className="w-full h-2 bg-gray-700 rounded-full overflow-hidden">
                    <div 
                        className={`h-full rounded-full ${stat.percentage === 100 ? 'bg-green-500' : 'bg-blue-500'}`} 
                        style={{ width: `${stat.percentage}%` }}
                    ></div>
                </div>

                <div className="flex justify-between text-xs font-mono">
                    <span className="text-blue-300">{stat.percentage}% Completado</span>
                    {stat.missing > 0 ? (
                        <span className="text-red-300">Faltan {stat.missing}</span>
                    ) : (
                        <span className="text-green-400 font-bold">¡COMPLETO! 🎉</span>
                    )}
                </div>
            </div>
        ))}
      </div>
      {/* ------------------------------------ */}

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
            {AVAILABLE_SETS.map(set => <option key={set.id} value={set.id}>{set.name}</option>)}
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
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-6 max-w-7xl mx-auto">
          {processedCards.map((card) => (
            <div key={card.id} className="relative group cursor-zoom-in" onClick={() => setSelectedCard(card)}>
                {card.quantity > 1 && (
                    <div className="absolute -top-2 -right-2 z-30 bg-blue-600 text-white text-xs font-bold w-6 h-6 flex items-center justify-center rounded-full border border-white shadow-lg">
                        {card.quantity}
                    </div>
                )}
                <div className="transition transform group-hover:-translate-y-1 duration-300 pointer-events-none">
                    <PokemonCard card={card} reveal={true} />
                </div>
                <div className="mt-2 flex justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-300">
                    <button
                        onClick={(e) => handleSellCard(e, card.id, card.rarity)}
                        className="bg-red-900/80 hover:bg-red-600 text-white text-xs py-1 px-3 rounded-full flex items-center gap-1 border border-red-400 backdrop-blur-sm z-20"
                    >
                        Vender (+{getPrice(card.rarity)})
                    </button>
                </div>
            </div>
          ))}
      </div>

      {/* MODAL DETALLE */}
      <AnimatePresence>
        {selectedCard && (
            <motion.div 
                initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 backdrop-blur-sm p-4"
                onClick={() => setSelectedCard(null)}
            >
                <motion.div 
                    initial={{ scale: 0.8 }} animate={{ scale: 1 }} exit={{ scale: 0.8 }}
                    className="relative max-w-4xl max-h-[90vh]"
                    onClick={(e) => e.stopPropagation()}
                >
                    <button 
                        onClick={() => setSelectedCard(null)}
                        className="absolute -top-4 -right-4 text-white bg-gray-800 rounded-full w-8 h-8 flex items-center justify-center border border-gray-600 z-50"
                    >✕</button>
                    <img src={selectedCard.images.large} alt={selectedCard.name} className="object-contain max-h-[85vh] w-auto rounded-xl shadow-2xl" />
                </motion.div>
            </motion.div>
        )}
      </AnimatePresence>
    </main>
  );
}