// src/utils/packLogic.ts

interface Card {
  id: string;
  name: string;
  rarity: string;
  images: { small: string; large: string };
}

// 1. Clasificador de Rarezas
const categorizeCards = (cards: Card[]) => {
  return {
    common: cards.filter(c => c.rarity === 'Common'),
    uncommon: cards.filter(c => c.rarity === 'Uncommon'),
    rare: cards.filter(c => c.rarity === 'Rare' || c.rarity === 'Rare Holo'),
    doubleRare: cards.filter(c => c.rarity === 'Double Rare' || c.rarity.includes('V') || c.rarity.includes('ex')),
    illustrationRare: cards.filter(c => c.rarity === 'Illustration Rare' || c.rarity === 'Trainer Gallery Rare (TG)'),
    ultraRare: cards.filter(c => c.rarity === 'Ultra Rare' || c.rarity === 'Full Art'),
    specialIllustrationRare: cards.filter(c => c.rarity === 'Special Illustration Rare'),
    hyperRare: cards.filter(c => c.rarity === 'Hyper Rare' || c.rarity === 'Secret Rare' || c.rarity.includes('Rainbow')),
  };
};

// 🛡️ FUNCIÓN DRAW INTELIGENTE (No repite cartas)
const draw = (
    pool: Card[], 
    fallbackPool: Card[], 
    currentPackIds: Set<string> // 👈 AQUÍ ESTÁ LA CLAVE
): Card => {
  // 1. Unimos los pools disponibles
  let availableCards = pool.length > 0 ? pool : fallbackPool;

  if (availableCards.length === 0) {
    return { id: 'error', name: 'MissingNo', rarity: 'Common', images: { small: '', large: '' } } as Card;
  }

  // 2. FILTRO ANTI-REPETICIÓN: Quitamos las que ya han salido
  // Solo si es posible (si quedan cartas disponibles tras filtrar)
  const uniquePool = availableCards.filter(c => !currentPackIds.has(c.id));
  
  // Si nos quedamos sin cartas únicas (raro, pero posible en sets pequeños), usamos el pool normal
  const finalPool = uniquePool.length > 0 ? uniquePool : availableCards;

  // 3. Elegimos carta
  const selected = finalPool[Math.floor(Math.random() * finalPool.length)];

  // 4. La registramos para que no vuelva a salir
  currentPackIds.add(selected.id);

  return selected;
};

// --- LOGICA DE PROBABILIDAD ---
const getHitCard = (pools: any, type: 'STANDARD' | 'PREMIUM', currentPackIds: Set<string>) => {
  const rand = Math.random() * 100; 

  if (type === 'STANDARD') {
    if (rand < 0.5) return draw(pools.hyperRare, pools.ultraRare, currentPackIds);       
    if (rand < 2.5) return draw(pools.specialIllustrationRare, pools.ultraRare, currentPackIds); 
    if (rand < 6.5) return draw(pools.ultraRare, pools.doubleRare, currentPackIds);      
    if (rand < 14.5) return draw(pools.illustrationRare, pools.rare, currentPackIds);    
    if (rand < 30.0) return draw(pools.doubleRare, pools.rare, currentPackIds);          
    return draw(pools.rare, pools.uncommon, currentPackIds);                             
  } 
  
  return draw(pools.rare, pools.uncommon, currentPackIds);
};

// --- NIVEL 1: SOBRE ESTÁNDAR ---
export const openStandardPack = (allCards: Card[]): Card[] => {
  const pools = categorizeCards(allCards);
  const pack: Card[] = [];
  const existingIds = new Set<string>(); // 🧠 Memoria del sobre

  // 1. Relleno Común (6 cartas)
  for (let i = 0; i < 6; i++) pack.push(draw(pools.common, pools.uncommon, existingIds));

  // 2. Relleno Infrecuente (3 cartas)
  for (let i = 0; i < 3; i++) pack.push(draw(pools.uncommon, pools.common, existingIds));

  // 3. LA CARTA RARA (Slot 10)
  pack.push(getHitCard(pools, 'STANDARD', existingIds));

  return pack;
};

// --- NIVEL 2: SOBRE PREMIUM ---
export const openPremiumPack = (allCards: Card[]): Card[] => {
  const pools = categorizeCards(allCards);
  const pack: Card[] = [];
  const existingIds = new Set<string>(); // 🧠 Memoria del sobre

  // FASE 1: EL RELLENO (8 Cartas)
  for (let i = 0; i < 4; i++) pack.push(draw(pools.uncommon, pools.common, existingIds));
  for (let i = 0; i < 4; i++) pack.push(draw(pools.rare, pools.uncommon, existingIds));

  // FASE 2: LOS HITS (2 Cartas)
  const midTierPool = [...pools.illustrationRare, ...pools.doubleRare];
  pack.push(draw(midTierPool, pools.rare, existingIds)); 

  // SLOT 10: EL JEFE
  const rand = Math.random() * 100;
  let bossCard;

  if (rand < 5) {
     bossCard = draw(pools.hyperRare, pools.ultraRare, existingIds);
  } else if (rand < 15) {
     bossCard = draw(pools.specialIllustrationRare, pools.ultraRare, existingIds);
  } else if (rand < 40) {
     bossCard = draw(pools.ultraRare, pools.doubleRare, existingIds);
  } else {
     bossCard = draw(pools.doubleRare, pools.rare, existingIds);
  }

  pack.push(bossCard);

  return pack;
};

// --- NIVEL 3: SOBRE LEYENDA (Garantizado) ---
export const openGoldenPack = (allCards: Card[], userIds: string[]): Card[] => {
  const pools = categorizeCards(allCards);
  const pack: Card[] = [];
  const existingIds = new Set<string>(); // 🧠 Memoria del sobre
  
  // 1. Buscamos carta faltante
  const missingCards = allCards.filter(card => !userIds.includes(card.id));
  let guaranteedCard: Card;

  if (missingCards.length > 0) {
    // Intentamos dar una rara que falte
    const missingRares = missingCards.filter(c => !['Common', 'Uncommon'].includes(c.rarity));
    if (missingRares.length > 0) {
        guaranteedCard = missingRares[Math.floor(Math.random() * missingRares.length)];
    } else {
        guaranteedCard = missingCards[Math.floor(Math.random() * missingCards.length)];
    }
  } else {
    // Si tiene todo, una Hyper Rare
    guaranteedCard = draw(pools.hyperRare, pools.specialIllustrationRare, existingIds);
  }
  
  // ¡IMPORTANTE! Registramos la garantizada ANTES de llenar el sobre para que no salga repe
  existingIds.add(guaranteedCard.id);

  // 2. Relleno de lujo (9 cartas)
  for (let i = 0; i < 5; i++) pack.push(draw(pools.rare, pools.uncommon, existingIds));
  for (let i = 0; i < 3; i++) pack.push(draw(pools.doubleRare, pools.rare, existingIds));
  for (let i = 0; i < 1; i++) pack.push(draw(pools.ultraRare, pools.illustrationRare, existingIds));

  // Añadimos la garantizada al final
  pack.push(guaranteedCard);

  return pack;
};