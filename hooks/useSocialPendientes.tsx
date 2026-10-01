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
import { getSocialPendientes } from "../app/social";
import { useAlVolver } from "./useAlVolver";

/**
 * LO QUE HAY ESPERÁNDOTE EN SOCIAL, PARA QUE SE VEA DESDE FUERA DE SOCIAL.
 *
 * Una petición de amistad o una oferta de intercambio sólo se anunciaban DENTRO
 * de /friends, en el interruptor de secciones. Quien entra a diario a abrir
 * sobres y no pisa esa pestaña no se enteraba nunca: la petición se quedaba
 * semanas sin contestar y el que la envió sólo veía «Pendiente». Este contexto
 * guarda las dos cuentas una vez para toda la cáscara, y las barras de
 * navegación (components/BottomNav.tsx, components/Sidebar.tsx) pintan con
 * ellas la insignia de la pestaña.
 *
 * CUÁNDO SE PREGUNTA, Y POR QUÉ NO HAY INTERVALO:
 *
 *  · al resolverse la sesión (y cada vez que cambia de cuenta);
 *  · al VOLVER a la app (hooks/useAlVolver.ts), como mucho una vez por minuto;
 *  · cuando una pantalla lo pide con `refrescar()`.
 *
 * Un sondeo periódico costaría una consulta por minuto y por pestaña abierta
 * para un dato que casi nunca cambia mientras se mira la pantalla. iOS además
 * congela los temporizadores de una PWA en segundo plano, así que el intervalo
 * no llegaría justo cuando hace falta: al volver. Volver SÍ es una señal, y es
 * la misma que ya usa el saldo (hooks/useGameCurrency.tsx).
 *
 * `getSocialPendientes` son dos `count` sobre índices y devuelve ceros si algo
 * falla; aquí se añade el catch del fallo de TRANSPORTE (sin cobertura), que sí
 * rechaza. Una insignia no puede tumbar la barra de navegación.
 */
interface SocialPendientesValue {
  /** Peticiones de amistad que me han enviado y no he contestado. */
  peticiones: number;
  /** Ofertas de intercambio recibidas y sin contestar. */
  ofertas: number;
  /** La suma: lo que pinta la insignia. */
  total: number;
  /** Vuelve a preguntar al servidor. Para después de una acción social. */
  refrescar: () => void;
  /**
   * Fija una cuenta que la pantalla YA conoce. /friends acaba de cargar las
   * listas enteras: pedir además los dos `count` sería pagar otra consulta
   * para saber lo que tiene delante.
   */
  fijar: (parcial: { peticiones?: number; ofertas?: number }) => void;
}

const SIN_PENDIENTES: SocialPendientesValue = {
  peticiones: 0,
  ofertas: 0,
  total: 0,
  refrescar: () => {},
  fijar: () => {},
};

const SocialPendientesContext = createContext<SocialPendientesValue>(SIN_PENDIENTES);

/** Mínimo entre dos consultas provocadas por volver a la app. */
const ENTRE_REFRESCOS_MS = 60_000;

interface Cuentas {
  /** De quién son: las de otra cuenta no se enseñan ni un fotograma. */
  uid: string | null;
  peticiones: number;
  ofertas: number;
}

const contar = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

export function SocialPendientesProvider({ children }: { children: ReactNode }) {
  const { user } = useUser();
  const uid = user?.id ?? null;

  const [cuentas, setCuentas] = useState<Cuentas>({ uid: null, peticiones: 0, ofertas: 0 });

  /* La identidad al día para lo que corre fuera del render: una respuesta que
   * llega después de cerrar sesión (o de cambiar de cuenta) es de otro, y sin
   * esta comprobación le pintaría su insignia al siguiente. */
  const uidRef = useRef<string | null>(uid);
  useEffect(() => {
    uidRef.current = uid;
  }, [uid]);

  /* Sólo cuenta la ÚLTIMA pregunta: dos en vuelo (volver a la app justo tras
   * una acción) pueden contestar en desorden y la vieja pisaría a la nueva. */
  const turnoRef = useRef(0);

  const consultar = useCallback(async () => {
    const quien = uidRef.current;
    if (!quien) return;
    const turno = ++turnoRef.current;
    try {
      const r = await getSocialPendientes();
      if (turno !== turnoRef.current || uidRef.current !== quien) return;
      setCuentas({ uid: quien, peticiones: contar(r?.peticiones), ofertas: contar(r?.ofertas) });
    } catch {
      // Sin red la insignia se queda como estaba: no es un dato por el que
      // merezca la pena avisar ni reintentar. Al volver se pregunta otra vez.
    }
  }, []);

  // Al aparecer la sesión, y otra vez si cambia de cuenta.
  useEffect(() => {
    if (!uid) return;
    void consultar();
  }, [uid, consultar]);

  useAlVolver(() => {
    void consultar();
  }, ENTRE_REFRESCOS_MS);

  const fijar = useCallback((parcial: { peticiones?: number; ofertas?: number }) => {
    const quien = uidRef.current;
    if (!quien) return;
    // Lo que la pantalla acaba de leer es más nuevo que cualquier pregunta que
    // siguiera en vuelo: se la descarta subiendo el turno.
    turnoRef.current += 1;
    setCuentas((previas) => {
      const base = previas.uid === quien ? previas : { uid: quien, peticiones: 0, ofertas: 0 };
      const siguientes = {
        uid: quien,
        peticiones: parcial.peticiones === undefined ? base.peticiones : contar(parcial.peticiones),
        ofertas: parcial.ofertas === undefined ? base.ofertas : contar(parcial.ofertas),
      };
      // Mismo objeto si no cambia nada: /friends llama a esto tras cada carga y
      // no tiene por qué repintar las dos barras de navegación cada vez.
      return siguientes.peticiones === previas.peticiones &&
        siguientes.ofertas === previas.ofertas &&
        previas.uid === quien
        ? previas
        : siguientes;
    });
  }, []);

  const refrescar = useCallback(() => {
    void consultar();
  }, [consultar]);

  /* Las cuentas se DERIVAN de la identidad en vez de borrarse en un efecto: al
   * cerrar sesión `uid` pasa a null en este mismo render y la insignia
   * desaparece ya, sin el fotograma intermedio con el número del que se fue. */
  const peticiones = cuentas.uid === uid && uid ? cuentas.peticiones : 0;
  const ofertas = cuentas.uid === uid && uid ? cuentas.ofertas : 0;

  const value = useMemo(
    () => ({ peticiones, ofertas, total: peticiones + ofertas, refrescar, fijar }),
    [peticiones, ofertas, refrescar, fijar],
  );

  return <SocialPendientesContext.Provider value={value}>{children}</SocialPendientesContext.Provider>;
}

/**
 * Fuera del proveedor devuelve ceros y funciones vacías en vez de lanzar: la
 * barra de navegación tiene que poder pintarse aunque alguien la monte suelta
 * (una prueba, una página de error), y sin insignia no pasa nada.
 */
export const useSocialPendientes = (): SocialPendientesValue => useContext(SocialPendientesContext);

/** El texto de la insignia: la cifra, o «9+» cuando ya no cabe en la píldora. */
export const textoDeInsignia = (n: number): string => (n > 9 ? "9+" : String(n));
