"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { STARTING_COINS } from "../utils/constanst";

/**
 * Saldo de monedas, compartido por toda la app.
 *
 * Antes esto era un hook con `useState` propio, así que cada componente que lo
 * usaba tenía SU PROPIA copia: la home gastaba, la colección ingresaba y la
 * recompensa diaria sumaba, pero el contador de la barra superior —otra
 * instancia— seguía mostrando el valor viejo hasta recargar. Con un contexto
 * hay un único saldo y todos los consumidores se enteran a la vez.
 *
 * La API es la misma de antes (coins, setCoins, spendCoins, addCoins, loaded),
 * así que ningún consumidor necesita cambiar.
 */
interface CurrencyValue {
  coins: number;
  setCoins: (value: number | ((prev: number) => number)) => void;
  /** Cobra si hay saldo. Devuelve si se pudo, de forma síncrona. */
  spendCoins: (amount: number) => boolean;
  addCoins: (amount: number) => void;
  loaded: boolean;
}

const CurrencyContext = createContext<CurrencyValue | null>(null);

const STORAGE_KEY = "coins";

/** Descarta NaN, negativos y basura de un localStorage manipulado. */
const sanitize = (n: number) => (Number.isFinite(n) && n >= 0 ? Math.floor(n) : null);

export function CurrencyProvider({ children }: { children: ReactNode }) {
  const [coins, setCoinsState] = useState(STARTING_COINS);
  const [loaded, setLoaded] = useState(false);

  /**
   * El saldo vivo. React no ejecuta los actualizadores de estado de forma
   * síncrona, así que `spendCoins` no podría saber si hubo fondos mirando el
   * estado. El ref da esa respuesta al instante y, de paso, dos gastos en el
   * mismo tick no pueden colarse leyendo ambos el saldo antiguo.
   */
  const coinsRef = useRef(STARTING_COINS);

  const commit = useCallback((next: number) => {
    const safe = Math.max(0, Math.floor(next));
    coinsRef.current = safe;
    setCoinsState(safe);
    return safe;
  }, []);

  useEffect(() => {
    const saved = sanitize(parseInt(localStorage.getItem(STORAGE_KEY) ?? "", 10));
    if (saved !== null) commit(saved);
    setLoaded(true);
  }, [commit]);

  useEffect(() => {
    if (loaded) localStorage.setItem(STORAGE_KEY, String(coins));
  }, [coins, loaded]);

  // Otra pestaña de la misma app cambia el saldo: nos ponemos al día.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY || e.newValue === null) return;
      const parsed = sanitize(parseInt(e.newValue, 10));
      if (parsed !== null) commit(parsed);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [commit]);

  const setCoins = useCallback(
    (value: number | ((prev: number) => number)) => {
      commit(typeof value === "function" ? value(coinsRef.current) : value);
    },
    [commit],
  );

  const spendCoins = useCallback(
    (amount: number) => {
      if (!Number.isFinite(amount) || amount <= 0) return false;
      if (coinsRef.current < amount) return false;
      commit(coinsRef.current - amount);
      return true;
    },
    [commit],
  );

  const addCoins = useCallback(
    (amount: number) => {
      if (!Number.isFinite(amount)) return;
      // Se acota en 0: hay devoluciones compensatorias con importes negativos y
      // un saldo bajo cero dejaría la tienda inutilizable.
      commit(coinsRef.current + amount);
    },
    [commit],
  );

  const value = useMemo(
    () => ({ coins, setCoins, spendCoins, addCoins, loaded }),
    [coins, setCoins, spendCoins, addCoins, loaded],
  );

  return (
    <CurrencyContext.Provider value={value}>{children}</CurrencyContext.Provider>
  );
}

export const useCurrency = (): CurrencyValue => {
  const ctx = useContext(CurrencyContext);
  if (!ctx) {
    throw new Error("useCurrency debe usarse dentro de <CurrencyProvider>");
  }
  return ctx;
};
