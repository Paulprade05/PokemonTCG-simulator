// src/hooks/useGameCurrency.ts
'use client';

import { useState, useEffect } from 'react';
import { STARTING_COINS } from '../utils/constanst';

export const useCurrency = () => {
  const [coins, setCoins] = useState(STARTING_COINS);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem('coins');
    if (saved) {
      setCoins(parseInt(saved));
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (loaded) {
      localStorage.setItem('coins', coins.toString());
    }
  }, [coins, loaded]);

  const spendCoins = (amount: number) => {
    if (coins >= amount) {
      setCoins((prev) => prev - amount);
      return true;
    }
    return false;
  };

  const addCoins = (amount: number) => {
    setCoins((prev) => prev + amount);
  };

  // 👇 AQUÍ ESTÁ EL CAMBIO IMPORTANTE 👇
  // Añadimos 'setCoins' a la lista para poder usarlo desde fuera
  return { 
    coins, 
    setCoins, // <--- ¡ESTA ES LA CLAVE! 🔑
    spendCoins, 
    addCoins,
    loaded 
  };
};