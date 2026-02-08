// src/utils/constants.ts

export const AVAILABLE_SETS = [
    // El campo 'total' es el número oficial de cartas del set
    { id: 'sv3pt5', name: '151', total: 165, logo: 'https://images.pokemontcg.io/sv3pt5/logo.png' },
    { id: 'swsh12pt5', name: 'Crown Zenith', total: 159, logo: 'https://images.pokemontcg.io/swsh12pt5/logo.png' },
    { id: 'sv4', name: 'Paradox Rift', total: 182, logo: 'https://images.pokemontcg.io/sv4/logo.png' },
    { id: 'swsh11', name: 'Lost Origin', total: 196, logo: 'https://images.pokemontcg.io/swsh11/logo.png' }
];

export const RARITY_RANK: Record<string, number> = {
    'Common': 1,
    'Uncommon': 2,
    'Rare': 3,
    'Rare Holo': 4,
    'Double Rare': 5,
    'Ultra Rare': 6,
    'Illustration Rare': 7,
    'Special Illustration Rare': 8,
    'Hyper Rare': 9
};

export const SELL_PRICES: Record<string, number> = {
    'Common': 2, 'Uncommon': 7, 'Rare': 30, 'Rare Holo': 80,
    'Double Rare': 150, 'Ultra Rare': 200, 'Illustration Rare': 250,
    'Special Illustration Rare': 400, 'Hyper Rare': 500,
};