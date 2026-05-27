// src/utils/storage.ts

const STORAGE_KEY = 'pokemon-tcg-collection';

export interface CollectionCard {
  id: string;
  name: string;
  rarity: string;
  images: { small: string; large: string };
  quantity: number; // <--- NUEVA PROPIEDAD
}

export const saveToCollection = (newPack: any[]) => {
  // 1. Recuperamos la colección actual
  const existingData = localStorage.getItem(STORAGE_KEY);
  let collection: CollectionCard[] = existingData ? JSON.parse(existingData) : [];

  // 2. Procesamos cada carta nueva del sobre
  newPack.forEach((newCard) => {
    // Buscamos si ya existe esa ID en tu álbum
    const existingIndex = collection.findIndex((c) => c.id === newCard.id);

    if (existingIndex >= 0) {
      // SI YA EXISTE: Solo aumentamos la cantidad
      collection[existingIndex].quantity = (collection[existingIndex].quantity || 1) + 1;
    } else {
      // SI ES NUEVA: La añadimos con cantidad 1
      collection.push({ ...newCard, quantity: 1 });
    }
  });

  // 3. Guardamos la colección actualizada y optimizada
  localStorage.setItem(STORAGE_KEY, JSON.stringify(collection));
};

export const saveCollectionRaw = (collection: any[]) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(collection));
}

export const getCollection = () => {
  if (typeof window === 'undefined') return [];
  const data = localStorage.getItem(STORAGE_KEY);
  return data ? JSON.parse(data) : [];
};

export const clearCollection = () => {
    localStorage.removeItem(STORAGE_KEY);
}