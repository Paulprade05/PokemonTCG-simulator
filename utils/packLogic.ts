interface Card {
  id: string;
  name: string;
  rarity: string;
  images: { small: string; large: string };
}

// 1. Clasificador de Rarezas (Para tener los "mazos" ordenados)
const categorizeCards = (cards: Card[]) => {
  return {
    common: cards.filter(c => c.rarity === 'Common'),
    uncommon: cards.filter(c => c.rarity === 'Uncommon'),
    rare: cards.filter(c => c.rarity === 'Rare' || c.rarity === 'Rare Holo'),
    doubleRare: cards.filter(c => c.rarity === 'Double Rare' || c.rarity.includes('V') || c.rarity.includes('ex')),
    illustrationRare: cards.filter(c => c.rarity === 'Illustration Rare' || c.rarity === 'Trainer Gallery Rare (TG)'),
    ultraRare: cards.filter(c => c.rarity === 'Ultra Rare' || c.rarity === 'Full Art'),
    specialIllustrationRare: cards.filter(c => c.rarity === 'Special Illustration Rare'),
    hyperRare: cards.filter(c => c.rarity === 'Hyper Rare' || c.rarity === 'Secret Rare'),
  };
};

// Función auxiliar para sacar carta de un pool seguro (si está vacío, busca en el anterior peor)
const draw = (pool: Card[], fallbackPool: Card[]): Card => {
  if (pool.length > 0) return pool[Math.floor(Math.random() * pool.length)];
  if (fallbackPool.length > 0) return fallbackPool[Math.floor(Math.random() * fallbackPool.length)];
  return { id: 'error', name: 'MissingNo', rarity: 'Common', images: { small: '', large: '' } }; // Fallback final
};

// --- LOGICA DE PROBABILIDAD (El corazón del realismo) ---
const getHitCard = (pools: any, type: 'STANDARD' | 'PREMIUM') => {
  const rand = Math.random() * 100; // Número entre 0.00 y 99.99

  if (type === 'STANDARD') {
    // 📊 PROBABILIDADES REALISTAS (Aprox. Era Escarlata y Púrpura)
    if (rand < 0.5) return draw(pools.hyperRare, pools.ultraRare);       // 0.5% - Gold / Hyper
    if (rand < 2.5) return draw(pools.specialIllustrationRare, pools.ultraRare); // 2% - SIR / SAR
    if (rand < 6.5) return draw(pools.ultraRare, pools.doubleRare);      // 4% - Ultra Rare (Full Art)
    if (rand < 14.5) return draw(pools.illustrationRare, pools.rare);    // 8% - Illustration Rare (Art Rare)
    if (rand < 30.0) return draw(pools.doubleRare, pools.rare);          // 15.5% - Double Rare (ex / V)
    return draw(pools.rare, pools.uncommon);                             // 70% - Holo Rare (Lo normal)
  } 
  
  else if (type === 'PREMIUM') {
    // 📊 PROBABILIDADES MEJORADAS (God Pack / Premium)
    if (rand < 2.0) return draw(pools.hyperRare, pools.ultraRare);       // 2%
    if (rand < 8.0) return draw(pools.specialIllustrationRare, pools.ultraRare); // 6%
    if (rand < 20.0) return draw(pools.ultraRare, pools.doubleRare);     // 12%
    if (rand < 40.0) return draw(pools.illustrationRare, pools.doubleRare); // 20%
    return draw(pools.doubleRare, pools.rare);                           // 60% - Mínimo una ex/V garantizada
  }

  return draw(pools.rare, pools.uncommon);
};

// --- NIVEL 1: SOBRE ESTÁNDAR (Realista) ---
export const openStandardPack = (allCards: Card[]): Card[] => {
  const pools = categorizeCards(allCards);
  const pack: Card[] = [];

  // 1. Relleno Común (6 cartas)
  for (let i = 0; i < 6; i++) pack.push(draw(pools.common, pools.uncommon));

  // 2. Relleno Infrecuente (3 cartas)
  for (let i = 0; i < 3; i++) pack.push(draw(pools.uncommon, pools.common));

  // 3. LA CARTA RARA (Slot 10 - El "Hit")
  // Aquí es donde ocurre la magia de la probabilidad
  pack.push(getHitCard(pools, 'STANDARD'));

  return pack;
};

// --- NIVEL 2: SOBRE PREMIUM (High Class Pack) ---
export const openPremiumPack = (allCards: Card[]): Card[] => {
  const pools = categorizeCards(allCards);
  const pack: Card[] = [];

  // --- FASE 1: EL RELLENO (8 Cartas) ---
  // Mezclamos Infrecuentes y Raras para que no se sienta "barato", pero sin dar premios gordos.
  for (let i = 0; i < 4; i++) pack.push(draw(pools.uncommon, pools.common));
  for (let i = 0; i < 4; i++) pack.push(draw(pools.rare, pools.uncommon));

  // --- FASE 2: LOS HITS (2 Cartas) ---

  // SLOT 9: Garantizado "Illustration Rare" O "Double Rare"
  // Creamos un pool combinado. Si el set tiene Art Rares, salen aquí. Si no, sale una ex.
  const midTierPool = [...pools.illustrationRare, ...pools.doubleRare];
  // Si el set es muy antiguo y no tiene ni ex ni arts, damos una Rara Holo.
  pack.push(draw(midTierPool, pools.rare)); 

  // SLOT 10: EL JEFE (Probabilidad de Ultra Rare superior)
  const rand = Math.random() * 100;
  let bossCard;

  // Ajuste de probabilidades para el último slot:
  if (rand < 5) {
     // 5% -> Hyper Rare (Dorada)
     bossCard = draw(pools.hyperRare, pools.ultraRare);
  } else if (rand < 15) {
     // 10% -> Special Illustration Rare (SIR/SAR)
     bossCard = draw(pools.specialIllustrationRare, pools.ultraRare);
  } else if (rand < 40) {
     // 25% -> Ultra Rare (Full Art)
     bossCard = draw(pools.ultraRare, pools.doubleRare);
  } else {
     // 60% -> Double Rare (ex normal) - El premio de consolación del slot jefe
     bossCard = draw(pools.doubleRare, pools.rare);
  }

  pack.push(bossCard);

  return pack;
};

// --- NIVEL 3: SOBRE LEYENDA (Garantizado) ---
export const openGoldenPack = (allCards: Card[], userIds: string[]): Card[] => {
  const pools = categorizeCards(allCards);
  
  // 1. Buscamos carta faltante (Lógica original perfecta)
  const missingCards = allCards.filter(card => !userIds.includes(card.id));
  let guaranteedCard: Card;

  if (missingCards.length > 0) {
    // Priorizamos darte una carta RARA que te falte, no una común
    const missingRares = missingCards.filter(c => !['Common', 'Uncommon'].includes(c.rarity));
    if (missingRares.length > 0) {
        guaranteedCard = missingRares[Math.floor(Math.random() * missingRares.length)];
    } else {
        guaranteedCard = missingCards[Math.floor(Math.random() * missingCards.length)];
    }
  } else {
    // Si tienes todo, te damos la carta más cara del set (Hyper Rare / SIR)
    guaranteedCard = draw(pools.hyperRare, pools.specialIllustrationRare);
  }

  // 2. Relleno de lujo (9 cartas)
  // Mezclamos cosas buenas para que el sobre se sienta "pesado"
  const pack: Card[] = [];
  for (let i = 0; i < 5; i++) pack.push(draw(pools.rare, pools.uncommon));
  for (let i = 0; i < 3; i++) pack.push(draw(pools.doubleRare, pools.rare));
  for (let i = 0; i < 1; i++) pack.push(draw(pools.ultraRare, pools.illustrationRare));

  // Añadimos la garantizada al final (Slot 10)
  pack.push(guaranteedCard);

  return pack;
};