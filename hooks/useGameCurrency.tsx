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
import { getUserData } from "../app/action";
import { borrarLocal, escribirLocal, leerLocal } from "../utils/almacen";
import { STARTING_COINS } from "../utils/constanst";
import {
  CLAVES_DE_QUIEN_JUEGA,
  CLAVE_ULTIMA_IDENTIDAD,
  rastroDeSesion,
  type Identidad,
  type RastroDeSesion,
} from "../utils/identidad";
import { useAlVolver } from "./useAlVolver";

/**
 * Saldo de monedas, compartido por toda la app.
 *
 * Antes esto era un hook con `useState` propio, así que cada componente que lo
 * usaba tenía SU PROPIA copia: la home gastaba, la colección ingresaba y la
 * recompensa diaria sumaba, pero el contador de la barra superior —otra
 * instancia— seguía mostrando el valor viejo hasta recargar. Con un contexto
 * hay un único saldo y todos los consumidores se enteran a la vez.
 *
 * La API de siempre (coins, setCoins, spendCoins, addCoins, loaded) no cambia;
 * se le añade `sesionResuelta`, que explica el bloque de abajo.
 */
interface CurrencyValue {
  coins: number;
  setCoins: (value: number | ((prev: number) => number)) => void;
  /** Cobra si hay saldo. Devuelve si se pudo, de forma síncrona. */
  spendCoins: (amount: number) => boolean;
  addCoins: (amount: number) => void;
  loaded: boolean;
  /**
   * Clerk ha dicho quién es el usuario, O se ha cansado de esperarle. Es lo
   * que deben mirar las pantallas que hoy miran `useUser().isLoaded` para
   * decidir si pintan su esqueleto; ver `useSesionResuelta` abajo.
   */
  sesionResuelta: boolean;
  /**
   * A QUIÉN se ha dejado de esperar: cuenta, invitado o una cuenta a la que
   * Clerk no ha podido confirmar por falta de red (utils/identidad.ts). Se lee
   * con `useIdentidad` (hooks/useIdentidad.ts).
   */
  identidad: Identidad;
}

const CurrencyContext = createContext<CurrencyValue | null>(null);

/**
 * Clave heredada, global entre cuentas. Se conserva sólo para migrar su valor
 * UNA vez a la clave del invitado y no resetear a nadie al separar los saldos.
 */
const LEGACY_KEY = "coins";

/**
 * CLERK PUEDE NO LLEGAR NUNCA, Y HAY QUE SEGUIR SIN ÉL.
 *
 * El script de Clerk se sirve desde su propio dominio y, aunque el service
 * worker lo guarde (public/sw.js), para resolver la sesión clerk-js necesita
 * hablar con su API. Sin conexión —la PWA instalada abierta en el metro— eso
 * no ocurre y `useUser().isLoaded` se queda en false PARA SIEMPRE. Todo lo que
 * esperaba a esa bandera se quedaba colgado: la barra superior con "…" en
 * lugar del saldo, y los esqueletos de Social y del álbum de entrenador
 * girando sin fin, con la app entera cacheada y lista debajo.
 *
 * Cuatro segundos son más de lo que Clerk tarda con red (medio segundo largo
 * en un móvil) y menos de lo que aguanta alguien mirando tres puntos. Pasado
 * el plazo se sigue CON LO ÚLTIMO QUE SE SUPO (utils/identidad.ts): como
 * invitado si nada indica que hubiera una cuenta, y como "cuenta sin conexión"
 * si la había. Antes se seguía siempre como invitado y se leía `coins:guest`:
 * a quien tenía cuenta la barra le enseñaba el saldo del invitado, y la portada
 * le dejaba gastarlo. Ahora, si se sabe de qué cuenta era la sesión, se lee SU
 * espejo (`coins:<id>`), que es lo último que el servidor dijo de ella. Si
 * Clerk acaba llegando más tarde, el efecto de carga se vuelve a ejecutar con
 * la clave que toque —el mismo camino que ya recorre un cambio de sesión—.
 */
const ESPERA_CLERK_MS = 4000;

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

/**
 * EL SALDO DE UNA CUENTA ES EL DEL SERVIDOR, Y HAY QUE IR A BUSCARLO.
 *
 * Con sesión, `coins:<id>` en localStorage es sólo un espejo para pintar algo
 * al instante. Antes el proveedor no preguntaba nunca al servidor: lo hacían
 * Inicio y Graduación, y sólo al montar. Entrar con la cuenta en un móvil nuevo
 * directamente por /collection enseñaba 1.000 monedas teniendo 12.000; y una
 * PWA reanudada horas después (iOS no la recarga) seguía con el saldo de
 * cuando se cerró, aunque entre medias se hubieran abierto sobres en el
 * ordenador o alguien hubiera comprado un anuncio del bazar.
 *
 * Ahora se pregunta al resolverse la sesión y cada vez que la app vuelve a
 * primer plano, en todas las pantallas.
 */
/** Mínimo entre dos consultas provocadas por volver a la app. */
const ENTRE_REFRESCOS_MS = 60_000;
/**
 * Si el saldo se ha movido aquí hace menos de esto, la respuesta del servidor
 * puede ser anterior a ese movimiento (un gasto optimista cuya compra todavía
 * viaja): adoptarla devolvería monedas ya gastadas al marcador. Se espera a
 * que haya calma y se vuelve a preguntar.
 */
const CALMA_TRAS_MOVIMIENTO_MS = 8_000;
const ESPERA_REINTENTO_MS = 9_000;
/** Tope de reintentos: una racha larga de sobres no se convierte en un sondeo
 *  perpetuo. Las propias pantallas ya adoptan el saldo que devuelve cada acción. */
const MAX_REINTENTOS = 3;

export function CurrencyProvider({ children }: { children: ReactNode }) {
  // Hasta que Clerk resuelve la sesión no se sabe qué clave leer.
  const { user, isLoaded, isSignedIn } = useUser();

  // El plazo de espera a Clerk: ver ESPERA_CLERK_MS. Se arma sólo mientras
  // Clerk no ha contestado y se desarma en cuanto contesta.
  //
  // El rastro de la última sesión se lee EN EL MISMO INSTANTE en que vence el
  // plazo, y los dos estados se fijan juntos: así no existe un render en el que
  // ya no se espera a Clerk pero todavía no se sabe a quién se ha dejado de
  // esperar (ése era el hueco por el que la portada entraba como invitado). Se
  // lee desde el temporizador y no en el render porque son cookies y
  // almacenamiento: el servidor no los tiene y romperían la hidratación.
  const [clerkTardo, setClerkTardo] = useState(false);
  const [rastro, setRastro] = useState<RastroDeSesion | null>(null);
  useEffect(() => {
    if (isLoaded) return;
    const t = window.setTimeout(() => {
      setRastro(rastroDeSesion());
      setClerkTardo(true);
    }, ESPERA_CLERK_MS);
    return () => window.clearTimeout(t);
  }, [isLoaded]);
  const sesionResuelta = isLoaded || clerkTardo;

  const identidad: Identidad = isLoaded
    ? isSignedIn
      ? "cuenta"
      : "invitado"
    : !clerkTardo || rastro === null
      ? "resolviendo"
      : rastro.tipo === "cuenta"
        ? "cuenta-sin-conexion"
        : "invitado";

  // Cada vez que Clerk resuelve, se apunta quién era: es de donde sale el
  // rastro la próxima vez que no llegue. Lo apunta el proveedor, que está
  // montado en todas las rutas; antes lo hacían cuatro pantallas, y quien sólo
  // abría la portada no dejaba rastro.
  const idConfirmado = isLoaded ? (user?.id ?? null) : undefined;
  useEffect(() => {
    if (idConfirmado === undefined) return;
    const ahora = idConfirmado ?? "guest";
    // Ha cambiado quién juega en este dispositivo (otra cuenta, o se ha cerrado
    // la sesión): lo que era de quien estaba no lo hereda quien llega. Sin
    // apunte anterior no se borra nada: es el primer arranque con esta versión.
    const antes = leerLocal(CLAVE_ULTIMA_IDENTIDAD);
    if (antes !== null && antes !== ahora) {
      for (const clave of CLAVES_DE_QUIEN_JUEGA) borrarLocal(clave);
    }
    escribirLocal(CLAVE_ULTIMA_IDENTIDAD, ahora);
  }, [idConfirmado]);

  // Con Clerk, la clave de su usuario. Sin Clerk y con rastro de cuenta, la de
  // esa cuenta si se sabe cuál era; en cualquier otro caso, la del invitado.
  const idSinConexion = !isLoaded && rastro?.tipo === "cuenta" ? rastro.id : null;
  const storageKey = keyFor(user?.id ?? idSinConexion);

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
  // propia clave. Espera a que Clerk resuelva la sesión —o a que venza el
  // plazo—: leer antes mezclaría el saldo del invitado con el de la cuenta.
  //
  // EL ALMACENAMIENTO SE TOCA SIEMPRE A TRAVÉS DE utils/almacen.ts, QUE NO
  // LANZA. Estos efectos viven en AppShell, por encima de app/error.tsx: con el
  // almacenamiento bloqueado (Safari con "Bloquear todas las cookies") un
  // `localStorage.getItem` a pelo tumbaba la app entera en global-error, en
  // todas las rutas y sin salida. Sin almacenamiento se lee null, se arranca
  // con el saldo inicial y `loaded` pasa a true igual: el saldo vive en memoria
  // lo que dure la sesión (y con cuenta lo trae enseguida el servidor).
  useEffect(() => {
    if (!sesionResuelta) return;
    const esInvitado = storageKey === "coins:guest";
    storageKeyRef.current = storageKey;
    let raw = leerLocal(storageKey);
    // Migración única: el saldo del invitado vivía en la clave global "coins".
    // Se adopta (y se retira la clave vieja) para no resetear a nadie a cero al
    // separar los saldos.
    if (raw === null && esInvitado) {
      const legacy = leerLocal(LEGACY_KEY);
      if (legacy !== null) {
        raw = legacy;
        borrarLocal(LEGACY_KEY);
      }
    }
    const saved = sanitize(parseInt(raw ?? "", 10));
    commit(saved !== null ? saved : STARTING_COINS);
    setLoaded(true);
  }, [sesionResuelta, storageKey, commit]);

  // Si no cabe (cuota llena) no se lanza: el saldo sigue bien en pantalla y se
  // volverá a intentar con el siguiente cambio.
  useEffect(() => {
    if (loaded) escribirLocal(storageKeyRef.current, String(coins));
  }, [coins, loaded]);

  /**
   * Cuándo se movió el saldo AQUÍ por última vez (un gasto, un ingreso, o una
   * pantalla que lo fija). Lo lee el refresco del servidor para no pisar un
   * movimiento que su respuesta todavía no conoce. Fijar el mismo valor que ya
   * hay no cuenta: no ha cambiado nada que proteger.
   */
  const ultimoMovimientoRef = useRef(0);
  const mover = useCallback(
    (next: number) => {
      if (Math.max(0, Math.floor(next)) !== coinsRef.current) {
        ultimoMovimientoRef.current = Date.now();
      }
      commit(next);
    },
    [commit],
  );

  // EL REFRESCO DESDE EL SERVIDOR. Ver ENTRE_REFRESCOS_MS, arriba.
  //
  // Sólo con la identidad CONFIRMADA por Clerk (`isLoaded` y usuario): cuando
  // el plazo de espera vence sin Clerk se sigue como invitado, y preguntar al
  // servidor sin saber quién pregunta no devolvería nada.
  const userId = isLoaded && user ? user.id : null;
  const refrescandoRef = useRef(false);
  const reintentoRef = useRef<number | undefined>(undefined);
  const refrescarRef = useRef<(intento?: number) => void>(() => {});

  const refrescarDelServidor = useCallback(
    async (intento = 0) => {
      if (!userId || refrescandoRef.current) return;
      // El efecto de carga aún no ha cambiado a la clave de esta cuenta: lo que
      // llegara se guardaría bajo la identidad anterior.
      if (storageKeyRef.current !== keyFor(userId)) return;
      const reintentar = () => {
        if (intento >= MAX_REINTENTOS) return;
        window.clearTimeout(reintentoRef.current);
        reintentoRef.current = window.setTimeout(
          () => refrescarRef.current(intento + 1),
          ESPERA_REINTENTO_MS,
        );
      };
      if (Date.now() - ultimoMovimientoRef.current < CALMA_TRAS_MOVIMIENTO_MS) {
        reintentar();
        return;
      }
      refrescandoRef.current = true;
      const salida = Date.now();
      const claveAlSalir = storageKeyRef.current;
      try {
        const data = await getUserData();
        if (!data || !Number.isFinite(data.coins)) return;
        // Cambió la sesión mientras la respuesta viajaba: ese saldo es de otro.
        if (storageKeyRef.current !== claveAlSalir) return;
        // Hubo un gasto o un ingreso aquí mientras viajaba: la respuesta puede
        // ser anterior a él. Se descarta y se pregunta otra vez más tarde.
        if (ultimoMovimientoRef.current >= salida) {
          reintentar();
          return;
        }
        commit(data.coins);
      } catch {
        // Sin red la acción rechaza: el saldo guardado sigue en pantalla y se
        // volverá a preguntar al regresar a la app.
      } finally {
        refrescandoRef.current = false;
      }
    },
    [userId, commit],
  );
  useEffect(() => {
    refrescarRef.current = refrescarDelServidor;
  }, [refrescarDelServidor]);

  // Al resolverse la sesión (y si cambia de cuenta). Va DESPUÉS del efecto de
  // carga a propósito: para entonces la clave activa ya es la de esta cuenta.
  useEffect(() => {
    if (!userId) return;
    refrescarDelServidor();
    return () => window.clearTimeout(reintentoRef.current);
  }, [userId, refrescarDelServidor]);

  // Y al volver: del segundo plano, de la caché de páginas o de un rato sin red.
  useAlVolver(() => {
    refrescarDelServidor();
  }, ENTRE_REFRESCOS_MS);

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

  // Las tres puertas por las que las pantallas mueven el saldo pasan por
  // `mover`, que apunta la hora del movimiento; la carga, el evento `storage` y
  // el refresco del servidor usan `commit` a secas, porque no son movimientos
  // del jugador sino el saldo poniéndose al día.
  const setCoins = useCallback(
    (value: number | ((prev: number) => number)) => {
      mover(typeof value === "function" ? value(coinsRef.current) : value);
    },
    [mover],
  );

  const spendCoins = useCallback(
    (amount: number) => {
      if (!Number.isFinite(amount) || amount <= 0) return false;
      if (coinsRef.current < amount) return false;
      mover(coinsRef.current - amount);
      return true;
    },
    [mover],
  );

  const addCoins = useCallback(
    (amount: number) => {
      if (!Number.isFinite(amount)) return;
      // Se acota en 0: hay devoluciones compensatorias con importes negativos y
      // un saldo bajo cero dejaría la tienda inutilizable.
      mover(coinsRef.current + amount);
    },
    [mover],
  );

  const value = useMemo(
    () => ({ coins, setCoins, spendCoins, addCoins, loaded, sesionResuelta, identidad }),
    [coins, setCoins, spendCoins, addCoins, loaded, sesionResuelta, identidad],
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

/**
 * `useUser().isLoaded` con plazo: true cuando Clerk ha contestado o cuando ya
 * ha esperado ESPERA_CLERK_MS sin respuesta. Es lo que deben usar las pantallas
 * para salir de su esqueleto —Social y el álbum de entrenador lo hacen—; con
 * `isLoaded` a secas, sin conexión se quedaban cargando para siempre.
 * Cuando el plazo vence sin Clerk, `useUser().isSignedIn` sigue siendo
 * `undefined`, y eso NO significa invitado: puede ser una cuenta sin red. Quien
 * necesite saber a quién se ha dejado de esperar usa `useIdentidad`
 * (hooks/useIdentidad.ts); esto sólo dice que ya no hay que esperar.
 */
export const useSesionResuelta = (): boolean => useCurrency().sesionResuelta;
