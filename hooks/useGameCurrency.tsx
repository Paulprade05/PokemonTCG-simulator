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
import { useUser } from "@clerk/nextjs";
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

/**
 * Clave heredada, global entre cuentas. Se conserva sólo para migrar su valor
 * UNA vez a la clave del invitado y no resetear a nadie al separar los saldos.
 */
const LEGACY_KEY = "coins";

/**
 * Cada identidad guarda su saldo bajo su propia clave: `coins:<userId>` con
 * sesión y `coins:guest` como invitado. Antes todo compartía la clave "coins",
 * así que al cerrar sesión el invitado heredaba el saldo cacheado de la última
 * cuenta y dos pestañas con sesiones distintas se pisaban vía el evento storage.
 */
const keyFor = (userId: string | null | undefined) =>
  userId ? `coins:${userId}` : "coins:guest";

/** Descarta NaN, negativos y basura de un localStorage manipulado. */
const sanitize = (n: number) => (Number.isFinite(n) && n >= 0 ? Math.floor(n) : null);

export function CurrencyProvider({ children }: { children: ReactNode }) {
  // Hasta que Clerk resuelve la sesión no se sabe qué clave leer.
  const { user, isLoaded } = useUser();
  const storageKey = keyFor(user?.id);

  const [coins, setCoinsState] = useState(STARTING_COINS);
  const [loaded, setLoaded] = useState(false);

  /**
   * El saldo vivo. React no ejecuta los actualizadores de estado de forma
   * síncrona, así que `spendCoins` no podría saber si hubo fondos mirando el
   * estado. El ref da esa respuesta al instante y, de paso, dos gastos en el
   * mismo tick no pueden colarse leyendo ambos el saldo antiguo.
   */
  const coinsRef = useRef(STARTING_COINS);
  /**
   * Clave activa, leída por los efectos de persistencia sin re-suscribirse
   * cuando cambia la identidad (evita escrituras a la clave equivocada durante
   * el cambio de sesión).
   */
  const storageKeyRef = useRef(storageKey);

  const commit = useCallback((next: number) => {
    const safe = Math.max(0, Math.floor(next));
    coinsRef.current = safe;
    setCoinsState(safe);
    return safe;
  }, []);

  // Carga inicial y cambios de identidad: cada cuenta (y el invitado) lee su
  // propia clave. Espera a que Clerk resuelva la sesión: leer antes mezclaría el
  // saldo del invitado con el de la cuenta.
  useEffect(() => {
    if (!isLoaded) return;
    const esInvitado = storageKey === "coins:guest";
    storageKeyRef.current = storageKey;
    let raw = localStorage.getItem(storageKey);
    // Migración única: el saldo del invitado vivía en la clave global "coins".
    // Se adopta (y se retira la clave vieja) para no resetear a nadie a cero al
    // separar los saldos.
    if (raw === null && esInvitado) {
      const legacy = localStorage.getItem(LEGACY_KEY);
      if (legacy !== null) {
        raw = legacy;
        try {
          localStorage.removeItem(LEGACY_KEY);
        } catch {
          /* almacenamiento inaccesible */
        }
      }
    }
    const saved = sanitize(parseInt(raw ?? "", 10));
    commit(saved !== null ? saved : STARTING_COINS);
    setLoaded(true);
  }, [isLoaded, storageKey, commit]);

  useEffect(() => {
    if (loaded) localStorage.setItem(storageKeyRef.current, String(coins));
  }, [coins, loaded]);

  // Otra pestaña de la misma app (misma identidad) cambia el saldo: nos ponemos
  // al día. El ref evita re-suscribirse en cada cambio de sesión.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== storageKeyRef.current || e.newValue === null) return;
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
