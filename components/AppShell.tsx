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
import { ToastProvider } from "./ui/Toast";
import EdgeBackGesture from "./ui/EdgeBackGesture";
import { useViewport } from "../hooks/useViewport";
import { CurrencyProvider } from "../hooks/useGameCurrency";

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
  const { isKeyboardOpen } = useViewport();

  const setImmersive = useCallback((v: boolean) => setImmersiveState(v), []);
  const value = useMemo(
    () => ({ immersive, setImmersive }),
    [immersive, setImmersive],
  );

  return (
    <ShellContext.Provider value={value}>
      {/* framer no lee la media query de CSS: hay que decírselo aquí para que
          quien tenga "reducir movimiento" activo salte a los estados finales. */}
      <MotionConfig reducedMotion="user">
        <ToastProvider>
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
