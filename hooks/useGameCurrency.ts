// hooks/useCurrency.ts
import { useState, useEffect } from 'react';

const COIN_STORAGE_KEY = 'pokemon-tcg-coins';
const INITIAL_COINS = 500; // Dinero inicial para usuarios nuevos

export const useCurrency = () => {
  const [coins, setCoins] = useState(INITIAL_COINS);
  const [loaded, setLoaded] = useState(false);

  // 1. Cargar monedas al iniciar
  useEffect(() => {
    const savedCoins = localStorage.getItem(COIN_STORAGE_KEY);
    if (savedCoins) {
      setCoins(parseInt(savedCoins, 10));
    }
    setLoaded(true);
  }, []);

  // 2. Guardar monedas cada vez que cambian
  useEffect(() => {
    if (loaded) {
      localStorage.setItem(COIN_STORAGE_KEY, coins.toString());
    }
  }, [coins, loaded]);

  // 3. Función para gastar (devuelve true si pudo pagar, false si no tiene dinero)
  const spendCoins = (amount: number): boolean => {
    if (coins >= amount) {
      setCoins((prev) => prev - amount);
      return true;
    }
    return false;
  };

  // 4. Función para ganar (bonus o ventas)
  const addCoins = (amount: number) => {
    setCoins((prev) => prev + amount);
  };

  return { coins, spendCoins, addCoins, loaded };
};