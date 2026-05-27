// src/utils/packLogic.ts

interface Card {
  id: string;
  name: string;
  rarity: string;
  images: { small: string; large: string };
}

// 1. Clasificador de Rarezas (He añadido protección '?' por si la rareza viene vacía de la BD)
const categorizeCards = (cards: Card[]) => {
  return {
    common: cards.filter(c => c.rarity === 'Common'),
    uncommon: cards.filter(c => c.rarity === 'Uncommon'),
    rare: cards.filter(c => c.rarity === 'Rare' || c.rarity === 'Rare Holo'),
    doubleRare: cards.filter(c => c.rarity === 'Double Rare' || c.rarity?.includes('V') || c.rarity?.includes('ex')),
    illustrationRare: cards.filter(c => c.rarity === 'Illustration Rare' || c.rarity?.includes('Trainer Gallery')),
    ultraRare: cards.filter(c => c.rarity === 'Ultra Rare' || c.rarity === 'Full Art'),
    specialIllustrationRare: cards.filter(c => c.rarity === 'Special Illustration Rare' || c.rarity?.includes('Secret')),
    hyperRare: cards.filter(c => c.rarity === 'Hyper Rare' || c.rarity === 'Secret Rare' || c.rarity?.includes('Rainbow')),
  };
};

// 🛡️ FUNCIÓN DRAW BLINDADA (Ahora recibe 'allCards' como salvavidas final)
const draw = (
    pool: Card[], 
    fallbackPool: Card[], 
    currentPackIds: Set<string>,
    allCards: Card[] // 👈 AQUÍ ESTÁ LA MAGIA: El set completo como último recurso
): Card => {
  
  // 1. Si el pool principal y el fallback están vacíos (Sets Especiales), usamos TODAS las cartas
  let availableCards = pool.length > 0 ? pool : (fallbackPool.length > 0 ? fallbackPool : allCards);

  // Si a pesar de todo no hay cartas (BD vacía), lanzamos MissingNo
  if (!availableCards || availableCards.length === 0) {
    return { id: 'error', name: 'MissingNo', rarity: 'Common', images: { small: '', large: '' } } as Card;
  }

  // 2. Filtro anti-repetición
  const uniquePool = availableCards.filter(c => !currentPackIds.has(c.id));
  const finalPool = uniquePool.length > 0 ? uniquePool : availableCards;
  
  // 3. Elegimos la carta
  const selected = finalPool[Math.floor(Math.random() * finalPool.length)];
  currentPackIds.add(selected.id);

  return selected;
};

// --- LOGICA DE PROBABILIDAD ---
const getHitCard = (pools: any, type: 'STANDARD' | 'PREMIUM', currentPackIds: Set<string>, allCards: Card[]) => {
  const rand = Math.random() * 100; 

  if (type === 'STANDARD') {
    if (rand < 0.5) return draw(pools.hyperRare, pools.ultraRare, currentPackIds, allCards);       
    if (rand < 2.5) return draw(pools.specialIllustrationRare, pools.ultraRare, currentPackIds, allCards); 
    if (rand < 6.5) return draw(pools.ultraRare, pools.doubleRare, currentPackIds, allCards);      
    if (rand < 14.5) return draw(pools.illustrationRare, pools.rare, currentPackIds, allCards);    
    if (rand < 30.0) return draw(pools.doubleRare, pools.rare, currentPackIds, allCards);          
    return draw(pools.rare, pools.uncommon, currentPackIds, allCards);                             
  } 
  
  return draw(pools.rare, pools.uncommon, currentPackIds, allCards);
};

// --- NIVEL 1: SOBRE ESTÁNDAR ---
export const openStandardPack = (allCards: Card[]): Card[] => {
  const pools = categorizeCards(allCards);
  const pack: Card[] = [];
  const existingIds = new Set<string>();

  // Pasamos 'allCards' a todas las llamadas de draw
  for (let i = 0; i < 6; i++) pack.push(draw(pools.common, pools.uncommon, existingIds, allCards));
  for (let i = 0; i < 3; i++) pack.push(draw(pools.uncommon, pools.common, existingIds, allCards));
  
  pack.push(getHitCard(pools, 'STANDARD', existingIds, allCards));

  return pack;
};

// --- NIVEL 2: SOBRE PREMIUM ---
export const openPremiumPack = (allCards: Card[]): Card[] => {
  const pools = categorizeCards(allCards);
  const pack: Card[] = [];
  const existingIds = new Set<string>();

  for (let i = 0; i < 4; i++) pack.push(draw(pools.uncommon, pools.common, existingIds, allCards));
  for (let i = 0; i < 4; i++) pack.push(draw(pools.rare, pools.uncommon, existingIds, allCards));

  const midTierPool = [...pools.illustrationRare, ...pools.doubleRare];
  pack.push(draw(midTierPool, pools.rare, existingIds, allCards)); 

  const rand = Math.random() * 100;
  let bossCard;

  if (rand < 5) bossCard = draw(pools.hyperRare, pools.ultraRare, existingIds, allCards);
  else if (rand < 15) bossCard = draw(pools.specialIllustrationRare, pools.ultraRare, existingIds, allCards);
  else if (rand < 40) bossCard = draw(pools.ultraRare, pools.doubleRare, existingIds, allCards);
  else bossCard = draw(pools.doubleRare, pools.rare, existingIds, allCards);

  pack.push(bossCard);

  return pack;
};

// --- NIVEL 3: SOBRE LEYENDA ---
export const openGoldenPack = (allCards: Card[], userIds: string[]): Card[] => {
  const pools = categorizeCards(allCards);
  const pack: Card[] = [];
  const existingIds = new Set<string>();
  
  const missingCards = allCards.filter(card => !userIds.includes(card.id));
  let guaranteedCard: Card;

  if (missingCards.length > 0) {
    const missingRares = missingCards.filter(c => c.rarity !== 'Common' && c.rarity !== 'Uncommon');
    if (missingRares.length > 0) {
        guaranteedCard = missingRares[Math.floor(Math.random() * missingRares.length)];
    } else {
        guaranteedCard = missingCards[Math.floor(Math.random() * missingCards.length)];
    }
  } else {
    guaranteedCard = draw(pools.hyperRare, pools.specialIllustrationRare, existingIds, allCards);
  }
  
  existingIds.add(guaranteedCard.id);

  for (let i = 0; i < 5; i++) pack.push(draw(pools.rare, pools.uncommon, existingIds, allCards));
  for (let i = 0; i < 3; i++) pack.push(draw(pools.doubleRare, pools.rare, existingIds, allCards));
  for (let i = 0; i < 1; i++) pack.push(draw(pools.ultraRare, pools.illustrationRare, existingIds, allCards));

  pack.push(guaranteedCard);

  return pack;
};