// src/app/collection/page.tsx
'use client';

import { useEffect, useState } from 'react';
import { useUser } from '@clerk/nextjs';
import { getFullCollection } from '../action'; // <--- Importamos la acción
import PokemonCard from '@/components/PokemonCard'; // Tu componente carta
import Link from 'next/link';

export default function CollectionPage() {
  const { isSignedIn } = useUser();
  const [cards, setCards] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadCollection() {
      if (isSignedIn) {
        // 🚀 MODO PRO: Carga desde la Base de Datos
        const dbCards = await getFullCollection();
        setCards(dbCards);
      } else {
        // 💾 MODO DEMO: Carga de localStorage (si quieres mantenerlo)
        const localIds = JSON.parse(localStorage.getItem('userCollection') || '[]');
        // Nota: Aquí tendrías que buscar los detalles de las cartas si solo guardas IDs,
        // por eso la BD es mucho mejor.
        setCards([]); 
      }
      setLoading(false);
    }

    loadCollection();
  }, [isSignedIn]);

  if (loading) return <div className="text-white text-center mt-20">Cargando tu tesoro... 💎</div>;

  return (
    <main className="min-h-screen bg-gray-900 p-8 text-white">
      <div className="flex justify-between items-center mb-8 max-w-7xl mx-auto">
        <h1 className="text-4xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-purple-600">
            Mi Colección ({cards.length})
        </h1>
        <Link href="/" className="bg-gray-700 px-4 py-2 rounded hover:bg-gray-600">
            ⬅ Volver a la Tienda
        </Link>
      </div>

      {cards.length === 0 ? (
        <div className="text-center text-gray-500 mt-20">
            <p>Aún no tienes cartas.</p>
            <Link href="/" className="text-blue-400 underline">¡Ve a abrir sobres!</Link>
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-6 max-w-7xl mx-auto">
          {cards.map((card, index) => (
            <div key={`${card.id}-${index}`} className="relative group">
              {/* Usamos tu componente carta */}
              <PokemonCard card={card} reveal={true} />
              
              {/* Badge de Cantidad */}
              {card.quantity > 1 && (
                <span className="absolute -top-2 -right-2 bg-red-500 text-white text-xs font-bold w-6 h-6 flex items-center justify-center rounded-full border-2 border-gray-900 z-50">
                    x{card.quantity}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </main>
  );
}