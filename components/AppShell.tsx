"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { MotionConfig } from "framer-motion";
import Sidebar from "./Sidebar";
import TopBar from "./TopBar";
import BottomNav from "./BottomNav";
import InstallPrompt from "./pwa/InstallPrompt";
import ServiceWorkerRegister from "./pwa/ServiceWorkerRegister";
import { ToastProvider } from "./ui/Toast";
import EdgeBackGesture from "./ui/EdgeBackGesture";
import { useKeyboardOpen } from "../hooks/useViewport";
import { CurrencyProvider } from "../hooks/useGameCurrency";
import { leerAjustes, suscribirseAjustes, type Ajustes } from "../utils/settings";

interface ShellContextValue {
  /** Oculta el cromo para las vistas a pantalla completa. */
  immersive: boolean;
  setImmersive: (value: boolean) => void;
}

const ShellContext = createContext<ShellContextValue>({
  immersive: false,
  setImmersive: () => {},
});

export const useShell = () => useContext(ShellContext);

/**
 * Pide modo inmersivo mientras el componente esté montado y `active` sea true.
 * La limpieza devuelve el cromo, así que navegar fuera lo restaura solo.
 */
export function useImmersive(active: boolean) {
  const { setImmersive } = useShell();
  useEffect(() => {
    setImmersive(active);
    return () => setImmersive(false);
  }, [active, setImmersive]);
}

export default function AppShell({ children }: { children: ReactNode }) {
  const [immersive, setImmersiveState] = useState(false);
  /* Sólo el booleano, no las medidas enteras: el visualViewport dispara
   * `scroll` con cada desplazamiento del dedo en iOS y con `useViewport()` este
   * componente —y con él Sidebar, TopBar y BottomNav— se repintaba en cada uno.
   * useKeyboardOpen sólo avisa cuando el teclado aparece o se va. */
  const isKeyboardOpen = useKeyboardOpen();

  /* "REDUCIR EFECTOS", EL AJUSTE PROPIO DE LA APP, APLICADO A TODA LA APP.
   *
   * De los treinta ficheros con framer-motion sólo seis leían
   * `ajustes.reducirEfectos`; el resto sólo obedecía a la preferencia del
   * sistema, así que el interruptor de la hoja de ajustes apagaba el confeti
   * de la apertura y poco más. Aquí se resuelve de una vez para todos:
   *
   *  · MotionConfig con reducedMotion="always" hace que framer descarte los
   *    transforms y deje sólo los fundidos, en TODOS los motion.* que cuelgan
   *    de la cáscara, sin que ninguno tenga que leer el ajuste. Con el ajuste
   *    apagado vuelve a "user", que es respetar la preferencia del sistema.
   *
   *  · `data-efectos="off"` en <html> es el mismo interruptor para el CSS:
   *    las animaciones y transiciones declaradas en hojas de estilo no pasan
   *    por framer. La regla que lo consume vive en app/globals.css (al lado
   *    de la media query de prefers-reduced-motion, que es su gemela); aquí
   *    sólo se escribe el atributo. El nombre es ese, `data-efectos`, con el
   *    valor `off`; ausente cuando el ajuste está apagado.
   *
   * Se lee en un efecto y no en el useState inicial: leer localStorage durante
   * el render daría un HTML distinto al del servidor y rompería la hidratación.
   * El primer fotograma sale con los efectos encendidos y se corrige antes de
   * que nada se mueva. */
  const [efectosApagados, setEfectosApagados] = useState(false);
  useEffect(() => {
    const aplicar = (a: Ajustes) => setEfectosApagados(a.reducirEfectos);
    aplicar(leerAjustes());
    return suscribirseAjustes(aplicar);
  }, []);
  useEffect(() => {
    const root = document.documentElement;
    if (efectosApagados) root.setAttribute("data-efectos", "off");
    else root.removeAttribute("data-efectos");
  }, [efectosApagados]);

  const setImmersive = useCallback((v: boolean) => setImmersiveState(v), []);
  const value = useMemo(
    () => ({ immersive, setImmersive }),
    [immersive, setImmersive],
  );

  return (
    <ShellContext.Provider value={value}>
      {/* framer no lee la media query de CSS: hay que decírselo aquí para que
          quien tenga "reducir movimiento" activo salte a los estados finales.
          Y "always" cuando lo pide el ajuste propio de la app (ver arriba). */}
      <MotionConfig reducedMotion={efectosApagados ? "always" : "user"}>
        <ToastProvider>
          {/* Vive DENTRO del proveedor de avisos porque ahora avisa: cuando hay
              una versión nueva enseña un Toast en vez de recargar sin más. Por
              eso ya no está en app/layout.tsx, que queda fuera del proveedor. */}
          <ServiceWorkerRegister />
          {/* El saldo vive aquí para que la barra superior, la home, la
              colección y la recompensa diaria compartan el mismo número. */}
          <CurrencyProvider>
          {/* En modo inmersivo (apertura de sobres) el resto de la app queda
              inerte: ni foco de teclado ni lector de pantalla pueden escaparse
              a lo que hay detrás de la capa. Los avisos de Toast viven fuera
              de este div (son hermanos, arriba), así que siguen anunciándose. */}
          <div className="min-h-dvh-app" inert={immersive || undefined}>
            <Sidebar />
            {/* Content column offset by sidebar on desktop */}
            <div className="md:pl-60">
              <TopBar />
              {/* El hueco inferior lo pone SÓLO `pb-nav`. Llevaba además un
                  `md:pb-12` que nunca ha pintado nada: globals.css declara
                  .pb-nav después de las utilidades de Tailwind y dentro de la
                  misma capa, así que gana por orden de cascada y cualquier
                  md:pb-* encima es letra muerta —está explicado allí, junto a la
                  media query que baja --content-bottom en escritorio, que es
                  donde de verdad se corrige—. Se quita para que nadie lo lea
                  como que en escritorio manda otra cosa. */}
              <main className="px-4 md:px-8 pt-6 pb-nav max-w-7xl mx-auto w-full">
                {children}
              </main>
            </div>
            <BottomNav hidden={immersive || isKeyboardOpen} />
            <EdgeBackGesture disabled={immersive} />
            {!immersive && <InstallPrompt />}
          </div>
          </CurrencyProvider>
        </ToastProvider>
      </MotionConfig>
    </ShellContext.Provider>
  );
}
