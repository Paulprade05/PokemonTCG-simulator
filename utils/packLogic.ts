// src/utils/packLogic.ts

interface Card {
  id: string;
  name: string;
  rarity: string;
  images: { small: string; large: string };
}

// Función auxiliar para mezclar y sacar N cartas
const getRandom = (pool: Card[], count: number) => {
  if (pool.length === 0) return [];
  // Si pedimos más cartas de las que hay, devolvemos todas las que haya (y repetimos si hace falta)
  if (count > pool.length) {
     const repeated = [...pool, ...pool, ...pool].sort(() => 0.5 - Math.random());
     return repeated.slice(0, count);
  }
  const shuffled = [...pool].sort(() => 0.5 - Math.random());
  return shuffled.slice(0, count);
};

// --- NIVEL 1: SOBRE BÁSICO (50 monedas) ---
// 6 Comunes, 3 Infrecuentes, 1 Rara+
export const openStandardPack = (allCards: Card[]): Card[] => {
  const commons = allCards.filter(c => c.rarity === 'Common');
  const uncommons = allCards.filter(c => c.rarity === 'Uncommon');
  const rares = allCards.filter(c => !['Common', 'Uncommon'].includes(c.rarity));

  return [
    ...getRandom(commons, 6),
    ...getRandom(uncommons, 3),
    ...getRandom(rares, 1) // 1 Rara garantizada
  ];
};

// --- NIVEL 2: SOBRE ÉLITE (200 monedas) ---
// ¡Sin comunes! 7 Infrecuentes, 3 Raras+ (Mayor probabilidad de hit)
export const openPremiumPack = (allCards: Card[]): Card[] => {
  const commons = allCards.filter(c => c.rarity === 'Common');
  const uncommons = allCards.filter(c => c.rarity === 'Uncommon');
  // Filtramos solo las raras MUY buenas para asegurar emoción
  const goodRares = allCards.filter(c => !['Common', 'Uncommon'].includes(c.rarity));

  return [
    ...getRandom(commons, 6),
    ...getRandom(uncommons, 6),
    ...getRandom(goodRares, 2) // 3 Raras garantizadas
  ];
};

// --- NIVEL 3: SOBRE LEYENDA (2500 monedas) ---
// Garantiza 1 carta NUEVA (que no tengas). El resto son Raras.
export const openGoldenPack = (allCards: Card[], userIds: string[]): Card[] => {
  // 1. Buscamos qué cartas le faltan al usuario DE ESTE SET
  const missingCards = allCards.filter(card => !userIds.includes(card.id));
  
  // 2. Preparamos el pool de cartas de relleno (solo raras e infrecuentes de calidad)
  const fillers = allCards.filter(c => !['Common'].includes(c.rarity));

  let guaranteedCard: Card;

  if (missingCards.length > 0) {
    // Si le faltan cartas, le damos una de las que le faltan
    guaranteedCard = getRandom(missingCards, 1)[0];
  } else {
    // Si ya tiene TODAS, le damos una carta muy valiosa al azar (Hyper Rare)
    const bestCards = allCards.filter(c => c.rarity === 'Hyper Rare' || c.rarity === 'Special Illustration Rare');
    guaranteedCard = getRandom(bestCards.length > 0 ? bestCards : fillers, 1)[0];
  }

  // El sobre son 9 cartas buenas + la garantizada (que ponemos la última para el final)
  const packContent = getRandom(fillers, 9);
  packContent.push(guaranteedCard);

  return packContent;
};